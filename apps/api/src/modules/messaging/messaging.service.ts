import { randomUUID } from 'node:crypto';
import {
  GatewayMode,
  CreditLedgerEntryType,
  SmsStatus,
  FeatureKey,
  UpdateGatewayConfigDto,
  MessagingAccountDto,
  MessageDispatchPayload,
  MessageDispatchResult,
  NormalizedDeliveryEvent,
  InsufficientCreditsError,
  BriskError,
} from '@brisksms/shared';
import {
  dbStore,
  MessagingAccountRecord,
  MessagingCreditLedgerRecord,
  SmsMessageRecord,
} from '../../core/store.js';
import { entitlementService } from '../subscription/entitlement.service.js';
import { MessagingProvider } from './interfaces/messaging-provider.interface.js';
import { smsGateProvider } from './providers/smsgate.provider.js';
import { recipientParserService } from './recipient-parser.service.js';

export class MessagingService {
  constructor(private readonly provider: MessagingProvider = smsGateProvider) {}

  /**
   * Retrieves or provisions a tenant's messaging account
   */
  getOrCreateAccount(organizationId: string): MessagingAccountRecord {
    let account = dbStore.messagingAccounts.get(organizationId);
    if (!account) {
      const now = new Date();
      account = {
        id: randomUUID(),
        organizationId,
        creditBalance: 0,
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        gatewayBaseUrl: 'https://gateway.brisksms.com/api/v1',
        encryptedApiToken: null,
        defaultSimSlot: 1,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      dbStore.messagingAccounts.set(organizationId, account);
    }
    return account;
  }

  /**
   * Updates tenant gateway settings (Supports Mode A External & Mode B Private VPS)
   */
  updateGatewayConfig(
    organizationId: string,
    dto: UpdateGatewayConfigDto,
  ): MessagingAccountDto {
    const account = this.getOrCreateAccount(organizationId);

    account.gatewayMode = dto.gatewayMode;
    if (dto.gatewayBaseUrl !== undefined) {
      account.gatewayBaseUrl = dto.gatewayBaseUrl;
    } else if (dto.gatewayMode === GatewayMode.MANAGED_GATEWAY && !account.gatewayBaseUrl) {
      account.gatewayBaseUrl = 'https://gateway.brisksms.com/api/v1';
    } else if (dto.gatewayMode === GatewayMode.EXTERNAL_RELAY && !account.gatewayBaseUrl) {
      account.gatewayBaseUrl = 'https://api.sms-gate.app/3rdparty/v1';
    }

    if (dto.apiToken !== undefined) {
      account.encryptedApiToken = dto.apiToken;
    }
    if (dto.defaultSimSlot !== undefined) {
      account.defaultSimSlot = dto.defaultSimSlot;
    }
    account.updatedAt = new Date();

    return {
      organizationId: account.organizationId,
      creditBalance: account.creditBalance,
      gatewayMode: account.gatewayMode,
      gatewayBaseUrl: account.gatewayBaseUrl ?? undefined,
      defaultSimSlot: account.defaultSimSlot,
      isActive: account.isActive,
    };
  }

  /**
   * Gets available prepaid credit balance
   */
  getCreditBalance(organizationId: string): number {
    const account = this.getOrCreateAccount(organizationId);
    return account.creditBalance;
  }

  /**
   * Purchases prepaid messaging credits (Records immutable ledger entry)
   */
  purchaseCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): number {
    if (amountCredits <= 0) {
      throw new BriskError("MESSAGING_ERROR", 'Purchased credits must be greater than zero.');
    }
    const account = this.getOrCreateAccount(organizationId);
    account.creditBalance += amountCredits;
    account.updatedAt = new Date();

    const ledgerEntry: MessagingCreditLedgerRecord = {
      id: randomUUID(),
      organizationId,
      entryType: CreditLedgerEntryType.PURCHASE,
      amountCredits,
      balanceAfter: account.creditBalance,
      referenceId: referenceId ?? null,
      createdAt: new Date(),
    };
    dbStore.messagingLedgers.push(ledgerEntry);

    return account.creditBalance;
  }

  /**
   * Atomically deducts credits for outbound dispatches
   */
  deductCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): number {
    const account = this.getOrCreateAccount(organizationId);
    if (account.creditBalance < amountCredits) {
      throw new InsufficientCreditsError(amountCredits, account.creditBalance);
    }

    account.creditBalance -= amountCredits;
    account.updatedAt = new Date();

    const ledgerEntry: MessagingCreditLedgerRecord = {
      id: randomUUID(),
      organizationId,
      entryType: CreditLedgerEntryType.USAGE_DEDUCTION,
      amountCredits,
      balanceAfter: account.creditBalance,
      referenceId: referenceId ?? null,
      createdAt: new Date(),
    };
    dbStore.messagingLedgers.push(ledgerEntry);

    return account.creditBalance;
  }

  /**
   * Atomically refunds credits upon permanent delivery failure
   */
  refundCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): number {
    const account = this.getOrCreateAccount(organizationId);
    account.creditBalance += amountCredits;
    account.updatedAt = new Date();

    const ledgerEntry: MessagingCreditLedgerRecord = {
      id: randomUUID(),
      organizationId,
      entryType: CreditLedgerEntryType.REFUND,
      amountCredits,
      balanceAfter: account.creditBalance,
      referenceId: referenceId ?? null,
      createdAt: new Date(),
    };
    dbStore.messagingLedgers.push(ledgerEntry);

    return account.creditBalance;
  }

  /**
   * Checks whether the current or specified time falls within TCRA marketing curfew (20:00 - 07:00 EAT)
   */
  isCurfewRestricted(sendDate: Date = new Date()): boolean {
    // East Africa Time (EAT) is UTC+3
    const utcHours = sendDate.getUTCHours();
    const eatHours = (utcHours + 3) % 24;

    // Curfew applies between 20:00 (8 PM) and 07:00 (7 AM) EAT
    return eatHours >= 20 || eatHours < 7;
  }

  /**
   * Dispatches a single SMS message with credit deduction and failure refund
   */
  async sendSingleMessage(
    organizationId: string,
    payload: {
      to: string;
      content: string;
      simSlot?: number;
      isPromotional?: boolean;
      campaignId?: string;
    },
  ): Promise<SmsMessageRecord> {
    // 1. Entitlement check
    if (!entitlementService.isFeatureEnabled(organizationId, FeatureKey.BULK_MESSAGING_ENABLED)) {
      throw new BriskError("MESSAGING_ERROR", 'Bulk messaging is not enabled on your current subscription plan.');
    }

    // 2. Validate & normalize Tanzanian phone number
    const normalizedPhone = recipientParserService.normalizePhoneNumber(payload.to);
    if (!normalizedPhone) {
      throw new BriskError("MESSAGING_ERROR", `Invalid Tanzanian mobile phone number: ${payload.to}`);
    }

    // 3. TCRA Curfew validation for promotional broadcasts
    if (payload.isPromotional && this.isCurfewRestricted()) {
      throw new BriskError("MESSAGING_ERROR", 
        'TCRA anti-spam compliance: Promotional SMS broadcasts are prohibited between 20:00 and 07:00 EAT.',
      );
    }

    // 4. Retrieve gateway credentials
    const account = this.getOrCreateAccount(organizationId);
    if (!account.encryptedApiToken) {
      throw new BriskError("MESSAGING_ERROR", 'No cellular gateway token configured. Please connect a relay gateway first.');
    }

    // 5. Atomic credit deduction (1 credit per SMS)
    const idempotencyKey = randomUUID();
    this.deductCredits(organizationId, 1, idempotencyKey);

    const messageId = randomUUID();
    const now = new Date();

    const dispatchPayload: MessageDispatchPayload = {
      organizationId,
      campaignId: payload.campaignId,
      to: normalizedPhone,
      content: payload.content,
      idempotencyKey,
      simSlot: payload.simSlot ?? account.defaultSimSlot,
    };

    const credentials = {
      mode: account.gatewayMode,
      baseUrl: account.gatewayBaseUrl || 'https://gateway.brisksms.com/api/v1',
      apiToken: account.encryptedApiToken,
      defaultSimSlot: account.defaultSimSlot,
    };

    // 6. Invoke provider adapter
    let dispatchResult: MessageDispatchResult;
    try {
      dispatchResult = await this.provider.sendMessage(credentials, dispatchPayload);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      dispatchResult = {
        providerMessageId: `fail_${Date.now()}`,
        status: 'FAILED',
        rawResponse: { error: errorMsg },
      };
    }

    // 7. Persist message record
    const smsRecord: SmsMessageRecord = {
      id: messageId,
      organizationId,
      campaignId: payload.campaignId ?? null,
      recipientPhone: normalizedPhone,
      messageText: payload.content,
      status: dispatchResult.status === 'DISPATCHED' ? SmsStatus.SUBMITTED : SmsStatus.FAILED,
      costCredits: 1,
      simSlot: dispatchPayload.simSlot ?? 1,
      providerMessageId: dispatchResult.providerMessageId,
      gatewayProvider: account.gatewayMode,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    dbStore.smsMessages.set(smsRecord.id, smsRecord);

    // 8. Auto-refund credit if dispatch failed immediately
    if (dispatchResult.status === 'FAILED') {
      this.refundCredits(organizationId, 1, `refund_${smsRecord.id}`);
    }

    return smsRecord;
  }

  /**
   * Processes gateway delivery webhook report (Handles automated refund on permanent failure)
   */
  handleDeliveryEvent(
    event: NormalizedDeliveryEvent,
  ): SmsMessageRecord | null {
    // Find message by providerMessageId
    let targetMessage: SmsMessageRecord | null = null;
    for (const msg of dbStore.smsMessages.values()) {
      if (msg.providerMessageId === event.providerMessageId) {
        targetMessage = msg;
        break;
      }
    }

    if (!targetMessage) return null;

    if (event.eventType === 'DELIVERED') {
      targetMessage.status = SmsStatus.DELIVERED;
      targetMessage.deliveredAt = event.carrierTimestamp;
      targetMessage.updatedAt = new Date();
    } else if (event.eventType === 'FAILED') {
      // Only refund if not already marked failed
      if (targetMessage.status !== SmsStatus.FAILED) {
        targetMessage.status = SmsStatus.FAILED;
        targetMessage.updatedAt = new Date();
        // Atomic refund to tenant ledger
        this.refundCredits(targetMessage.organizationId, targetMessage.costCredits, `refund_${targetMessage.id}`);
      }
    }

    return targetMessage;
  }
}

export const messagingService = new MessagingService();
