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
import { sql, withTransaction } from '@brisksms/db';
import {
  MessagingAccountRecord,
  MessagingCreditLedgerRecord,
  SmsCampaignRecord,
  SmsCampaignRecipientRecord,
  SmsMessageRecord,
} from '../../core/store.js';
import { entitlementService } from '../subscription/entitlement.service.js';
import { MessagingProvider } from './interfaces/messaging-provider.interface.js';
import { smsGateProvider } from './providers/smsgate.provider.js';
import { recipientParserService } from './recipient-parser.service.js';

export interface CreateCampaignDto {
  name: string;
  templateText: string;
  recipients: Array<{
    phoneNumber: string;
    variables?: Record<string, string>;
  }>;
  scheduledAt?: Date;
}

export class MessagingService {
  constructor(private readonly provider: MessagingProvider = smsGateProvider) {}

  private mapAccountRow(row: Record<string, any>): MessagingAccountRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      creditBalance: Number(row.credit_balance),
      reservedCredits: Number(row.reserved_credits),
      gatewayMode: row.gateway_mode as GatewayMode,
      gatewayBaseUrl: row.gateway_base_url,
      encryptedApiToken: row.encrypted_api_token,
      defaultSimSlot: Number(row.default_sim_slot),
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapMessageRow(row: Record<string, any>): SmsMessageRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      campaignId: row.campaign_id,
      recipientPhone: row.recipient_phone,
      messageText: row.message_text,
      status: row.status as SmsStatus,
      costCredits: Number(row.cost_credits),
      simSlot: Number(row.sim_slot),
      providerMessageId: row.provider_message_id,
      gatewayProvider: row.gateway_provider as GatewayMode,
      attemptCount: Number(row.attempt_count ?? 1),
      lastError: row.last_error ?? undefined,
      deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Retrieves or provisions a tenant's messaging account
   */
  async getOrCreateAccount(organizationId: string): Promise<MessagingAccountRecord> {
    const existing = await sql<Record<string, any>>`
      SELECT * FROM messaging_accounts WHERE organization_id = ${organizationId} LIMIT 1
    `;
    if (existing.length > 0) {
      return this.mapAccountRow(existing[0]!);
    }

    const id = randomUUID();
    const now = new Date();
    const inserted = await sql<Record<string, any>>`
      INSERT INTO messaging_accounts (
        id, organization_id, credit_balance, reserved_credits,
        gateway_mode, gateway_base_url, encrypted_api_token,
        default_sim_slot, is_active, created_at, updated_at
      ) VALUES (
        ${id}, ${organizationId}, 0, 0,
        ${GatewayMode.MANAGED_GATEWAY}, 'https://gateway.brisksms.com/api/v1', NULL,
        1, true, ${now}, ${now}
      )
      ON CONFLICT (organization_id) DO UPDATE SET updated_at = messaging_accounts.updated_at
      RETURNING *
    `;

    return this.mapAccountRow(inserted[0]!);
  }

  /**
   * Updates tenant gateway settings (Supports Mode A External & Mode B Private VPS)
   */
  async updateGatewayConfig(
    organizationId: string,
    dto: UpdateGatewayConfigDto,
  ): Promise<MessagingAccountDto> {
    const account = await this.getOrCreateAccount(organizationId);

    const gatewayMode = dto.gatewayMode;
    let gatewayBaseUrl = account.gatewayBaseUrl;
    if (dto.gatewayBaseUrl !== undefined) {
      gatewayBaseUrl = dto.gatewayBaseUrl;
    } else if (dto.gatewayMode === GatewayMode.MANAGED_GATEWAY && !account.gatewayBaseUrl) {
      gatewayBaseUrl = 'https://gateway.brisksms.com/api/v1';
    } else if (dto.gatewayMode === GatewayMode.EXTERNAL_RELAY && !account.gatewayBaseUrl) {
      gatewayBaseUrl = 'https://api.sms-gate.app/3rdparty/v1';
    }

    const encryptedApiToken = dto.apiToken !== undefined ? dto.apiToken : account.encryptedApiToken;
    const defaultSimSlot = dto.defaultSimSlot !== undefined ? dto.defaultSimSlot : account.defaultSimSlot;
    const now = new Date();

    const updated = await sql<Record<string, any>>`
      UPDATE messaging_accounts
      SET gateway_mode = ${gatewayMode},
          gateway_base_url = ${gatewayBaseUrl},
          encrypted_api_token = ${encryptedApiToken},
          default_sim_slot = ${defaultSimSlot},
          updated_at = ${now}
      WHERE organization_id = ${organizationId}
      RETURNING *
    `;

    const updatedAccount = this.mapAccountRow(updated[0]!);
    return {
      organizationId: updatedAccount.organizationId,
      creditBalance: updatedAccount.creditBalance,
      gatewayMode: updatedAccount.gatewayMode,
      gatewayBaseUrl: updatedAccount.gatewayBaseUrl ?? undefined,
      defaultSimSlot: updatedAccount.defaultSimSlot,
      isActive: updatedAccount.isActive,
    };
  }

  /**
   * Gets available prepaid credit balance
   */
  async getCreditBalance(organizationId: string): Promise<number> {
    const account = await this.getOrCreateAccount(organizationId);
    return account.creditBalance;
  }

  /**
   * Gets full credit state (available and reserved)
   */
  async getAccountBalances(organizationId: string): Promise<{ creditBalance: number; reservedCredits: number }> {
    const account = await this.getOrCreateAccount(organizationId);
    return {
      creditBalance: account.creditBalance,
      reservedCredits: account.reservedCredits,
    };
  }

  /**
   * Lists immutable credit ledger entries for an organization
   */
  async listLedgerEntries(organizationId: string): Promise<MessagingCreditLedgerRecord[]> {
    const rows = await sql<Record<string, any>>`
      SELECT * FROM messaging_credit_ledger
      WHERE organization_id = ${organizationId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      entryType: row.entry_type as CreditLedgerEntryType,
      amountCredits: Number(row.amount_credits),
      balanceAfter: Number(row.balance_after),
      reservedAfter: Number(row.reserved_after ?? 0),
      referenceId: row.reference_id,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Purchases prepaid messaging credits (Records immutable ledger entry inside ACID transaction)
   */
  async purchaseCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): Promise<number> {
    if (amountCredits <= 0) {
      throw new BriskError('MESSAGING_ERROR', 'Purchased credits must be greater than zero.');
    }

    await this.getOrCreateAccount(organizationId);

    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      const currentBalance = Number(rows[0]!.credit_balance);
      const newBalance = currentBalance + amountCredits;
      const now = new Date();

      await tx`
        UPDATE messaging_accounts
        SET credit_balance = ${newBalance}, updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;

      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.PURCHASE},
          ${amountCredits}, ${newBalance}, ${referenceId ?? null}, ${now}
        )
      `;

      return newBalance;
    });
  }

  /**
   * Atomically reserves credits for a scheduled or active campaign (FOR UPDATE row lock)
   */
  async reserveCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): Promise<{ creditBalance: number; reservedCredits: number }> {
    if (amountCredits <= 0) {
      throw new BriskError('MESSAGING_ERROR', 'Reservation amount must be greater than zero.');
    }

    await this.getOrCreateAccount(organizationId);

    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      const currentBalance = Number(rows[0]!.credit_balance);
      const currentReserved = Number(rows[0]!.reserved_credits);

      if (currentBalance < amountCredits) {
        throw new InsufficientCreditsError(amountCredits, currentBalance);
      }

      const newBalance = currentBalance - amountCredits;
      const newReserved = currentReserved + amountCredits;
      const now = new Date();

      await tx`
        UPDATE messaging_accounts
        SET credit_balance = ${newBalance},
            reserved_credits = ${newReserved},
            updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;

      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.RESERVATION},
          ${amountCredits}, ${newBalance}, ${referenceId ?? null}, ${now}
        )
      `;

      return { creditBalance: newBalance, reservedCredits: newReserved };
    });
  }

  /**
   * Releases previously reserved credits back to available creditBalance
   */
  async releaseReservedCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): Promise<{ creditBalance: number; reservedCredits: number }> {
    if (amountCredits <= 0) {
      throw new BriskError('MESSAGING_ERROR', 'Release amount must be greater than zero.');
    }

    await this.getOrCreateAccount(organizationId);

    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      const currentBalance = Number(rows[0]!.credit_balance);
      const currentReserved = Number(rows[0]!.reserved_credits);

      if (currentReserved < amountCredits) {
        throw new BriskError('MESSAGING_ERROR', 'Cannot release more credits than currently reserved.');
      }

      const newBalance = currentBalance + amountCredits;
      const newReserved = currentReserved - amountCredits;
      const now = new Date();

      await tx`
        UPDATE messaging_accounts
        SET credit_balance = ${newBalance},
            reserved_credits = ${newReserved},
            updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;

      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.RELEASE},
          ${amountCredits}, ${newBalance}, ${referenceId ?? null}, ${now}
        )
      `;

      return { creditBalance: newBalance, reservedCredits: newReserved };
    });
  }

  /**
   * Commits reserved credits into final usage deduction
   */
  async commitReservedCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): Promise<{ creditBalance: number; reservedCredits: number }> {
    if (amountCredits <= 0) {
      throw new BriskError('MESSAGING_ERROR', 'Commit amount must be greater than zero.');
    }

    await this.getOrCreateAccount(organizationId);

    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      const currentBalance = Number(rows[0]!.credit_balance);
      const currentReserved = Number(rows[0]!.reserved_credits);

      if (currentReserved < amountCredits) {
        throw new BriskError('MESSAGING_ERROR', 'Insufficient reserved credits to commit.');
      }

      const newReserved = currentReserved - amountCredits;
      const now = new Date();

      await tx`
        UPDATE messaging_accounts
        SET reserved_credits = ${newReserved},
            updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;

      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.USAGE_DEDUCTION},
          ${amountCredits}, ${currentBalance}, ${referenceId ?? null}, ${now}
        )
      `;

      return { creditBalance: currentBalance, reservedCredits: newReserved };
    });
  }

  /**
   * Atomically deducts credits for outbound dispatches (FOR UPDATE row lock prevents concurrent overspending)
   */
  async deductCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): Promise<number> {
    if (amountCredits <= 0) {
      throw new BriskError('MESSAGING_ERROR', 'Deduction amount must be greater than zero.');
    }

    await this.getOrCreateAccount(organizationId);

    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      const currentBalance = Number(rows[0]!.credit_balance);
      if (currentBalance < amountCredits) {
        throw new InsufficientCreditsError(amountCredits, currentBalance);
      }

      const newBalance = currentBalance - amountCredits;
      const now = new Date();

      await tx`
        UPDATE messaging_accounts
        SET credit_balance = ${newBalance}, updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;

      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.USAGE_DEDUCTION},
          ${amountCredits}, ${newBalance}, ${referenceId ?? null}, ${now}
        )
      `;

      return newBalance;
    });
  }

  /**
   * Atomically refunds credits upon permanent delivery failure
   */
  async refundCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
  ): Promise<number> {
    if (amountCredits <= 0) {
      throw new BriskError('MESSAGING_ERROR', 'Refund amount must be greater than zero.');
    }

    await this.getOrCreateAccount(organizationId);

    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      const currentBalance = Number(rows[0]!.credit_balance);
      const newBalance = currentBalance + amountCredits;
      const now = new Date();

      await tx`
        UPDATE messaging_accounts
        SET credit_balance = ${newBalance}, updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;

      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.REFUND},
          ${amountCredits}, ${newBalance}, ${referenceId ?? null}, ${now}
        )
      `;

      return newBalance;
    });
  }

  /**
   * Creates a persisted SMS campaign with recipients and reserves credits atomically
   */
  async createCampaign(
    organizationId: string,
    dto: CreateCampaignDto,
  ): Promise<{ campaign: SmsCampaignRecord; recipients: SmsCampaignRecipientRecord[] }> {
    if (!(await entitlementService.isFeatureEnabled(organizationId, FeatureKey.BULK_MESSAGING_ENABLED))) {
      throw new BriskError('MESSAGING_ERROR', 'Bulk messaging is not enabled on your current subscription plan.');
    }

    if (!dto.recipients || dto.recipients.length === 0) {
      throw new BriskError('MESSAGING_ERROR', 'Campaign must include at least one recipient.');
    }

    const normalizedRecipients = dto.recipients.map((r) => {
      const normalized = recipientParserService.normalizePhoneNumber(r.phoneNumber);
      if (!normalized) {
        throw new BriskError('MESSAGING_ERROR', `Invalid Tanzanian mobile phone number: ${r.phoneNumber}`);
      }
      return {
        phoneNumber: normalized,
        variables: r.variables ?? null,
      };
    });

    const totalCost = normalizedRecipients.length;
    await this.getOrCreateAccount(organizationId);

    return withTransaction(async (tx) => {
      const accountRows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      const currentBalance = Number(accountRows[0]!.credit_balance);
      const currentReserved = Number(accountRows[0]!.reserved_credits);

      if (currentBalance < totalCost) {
        throw new InsufficientCreditsError(totalCost, currentBalance);
      }

      const newBalance = currentBalance - totalCost;
      const newReserved = currentReserved + totalCost;
      const now = new Date();
      const campaignId = randomUUID();

      await tx`
        UPDATE messaging_accounts
        SET credit_balance = ${newBalance},
            reserved_credits = ${newReserved},
            updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;

      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.RESERVATION},
          ${totalCost}, ${newBalance}, ${`campaign_${campaignId}`}, ${now}
        )
      `;

      const status = dto.scheduledAt ? 'SCHEDULED' : 'DRAFT';
      const campaignRows = await tx<Record<string, any>>`
        INSERT INTO sms_campaigns (
          id, organization_id, sender_id_id, name, message_template, status,
          recipient_count, scheduled_at, completed_at, created_at, updated_at
        ) VALUES (
          ${campaignId}, ${organizationId}, NULL, ${dto.name.trim()}, ${dto.templateText}, ${status}::"CampaignStatus",
          ${normalizedRecipients.length}, ${dto.scheduledAt ?? null}, NULL, ${now}, ${now}
        )
        RETURNING *
      `;

      const recipients: SmsCampaignRecipientRecord[] = [];
      for (const r of normalizedRecipients) {
        const recId = randomUUID();
        const interpolatedText = recipientParserService.interpolateTemplate(
          dto.templateText,
          r.variables ?? {},
        );
        await tx`
          INSERT INTO sms_campaign_recipients (
            id, organization_id, campaign_id, recipient_phone, variables,
            interpolated_text, status, message_id, created_at, updated_at
          ) VALUES (
            ${recId}, ${organizationId}, ${campaignId}, ${r.phoneNumber},
            ${r.variables ? JSON.stringify(r.variables) : null}::jsonb,
            ${interpolatedText}, ${SmsStatus.QUEUED}::"SmsStatus", NULL, ${now}, ${now}
          )
        `;
        recipients.push({
          id: recId,
          organizationId,
          campaignId,
          recipientPhone: r.phoneNumber,
          variables: r.variables,
          interpolatedText,
          status: SmsStatus.QUEUED,
          messageId: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const cRow = campaignRows[0]!;
      const campaign: SmsCampaignRecord = {
        id: cRow.id,
        organizationId: cRow.organization_id,
        senderIdId: cRow.sender_id_id ?? null,
        name: cRow.name,
        messageTemplate: cRow.message_template,
        status: cRow.status,
        recipientCount: Number(cRow.recipient_count),
        scheduledAt: cRow.scheduled_at ? new Date(cRow.scheduled_at) : null,
        completedAt: cRow.completed_at ? new Date(cRow.completed_at) : null,
        createdAt: new Date(cRow.created_at),
        updatedAt: new Date(cRow.updated_at),
      };

      return { campaign, recipients };
    });
  }

  /**
   * Checks whether the current or specified time falls within TCRA marketing curfew (20:00 - 07:00 EAT)
   */
  isCurfewRestricted(sendDate: Date = new Date()): boolean {
    const utcHours = sendDate.getUTCHours();
    const eatHours = (utcHours + 3) % 24;
    return eatHours >= 20 || eatHours < 7;
  }

  /**
   * Dispatches a single SMS message with credit deduction, delivery attempt persistence, and failure refund
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
    if (!(await entitlementService.isFeatureEnabled(organizationId, FeatureKey.BULK_MESSAGING_ENABLED))) {
      throw new BriskError('MESSAGING_ERROR', 'Bulk messaging is not enabled on your current subscription plan.');
    }

    const normalizedPhone = recipientParserService.normalizePhoneNumber(payload.to);
    if (!normalizedPhone) {
      throw new BriskError('MESSAGING_ERROR', `Invalid Tanzanian mobile phone number: ${payload.to}`);
    }

    if (payload.isPromotional && this.isCurfewRestricted()) {
      throw new BriskError(
        'MESSAGING_ERROR',
        'TCRA anti-spam compliance: Promotional SMS broadcasts are prohibited between 20:00 and 07:00 EAT.',
      );
    }

    const account = await this.getOrCreateAccount(organizationId);
    if (!account.encryptedApiToken) {
      throw new BriskError('MESSAGING_ERROR', 'No cellular gateway token configured. Please connect a relay gateway first.');
    }

    const idempotencyKey = randomUUID();
    await this.deductCredits(organizationId, 1, idempotencyKey);

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

    let dispatchResult: MessageDispatchResult;
    let errorMessage: string | null = null;
    try {
      dispatchResult = await this.provider.sendMessage(credentials, dispatchPayload);
    } catch (err: unknown) {
      errorMessage = err instanceof Error ? err.message : String(err);
      dispatchResult = {
        providerMessageId: `fail_${Date.now()}_${randomUUID().slice(0, 8)}`,
        status: 'FAILED',
        rawResponse: { error: errorMessage },
      };
    }

    const finalStatus = dispatchResult.status === 'DISPATCHED' ? SmsStatus.SUBMITTED : SmsStatus.FAILED;

    const inserted = await sql<Record<string, any>>`
      INSERT INTO sms_messages (
        id, organization_id, campaign_id, recipient_phone, message_text,
        status, cost_credits, sim_slot, provider_message_id, gateway_provider,
        delivered_at, created_at, updated_at
      ) VALUES (
        ${messageId}, ${organizationId}, ${payload.campaignId ?? null}, ${normalizedPhone}, ${payload.content},
        ${finalStatus}, 1, ${dispatchPayload.simSlot ?? 1}, ${dispatchResult.providerMessageId}, ${account.gatewayMode},
        NULL, ${now}, ${now}
      )
      RETURNING *
    `;

    await sql`
      INSERT INTO sms_delivery_attempts (
        id, organization_id, message_id, attempt_number, gateway_provider,
        provider_message_id, status, error_message, raw_response, attempted_at
      ) VALUES (
        ${randomUUID()}, ${organizationId}, ${messageId}, 1, ${account.gatewayMode},
        ${dispatchResult.providerMessageId}, ${finalStatus}::"SmsStatus", ${errorMessage},
        ${dispatchResult.rawResponse ? JSON.stringify(dispatchResult.rawResponse) : null}::jsonb,
        ${now}
      )
    `;

    if (dispatchResult.status === 'FAILED') {
      await this.refundCredits(organizationId, 1, `refund_${messageId}`);
    }

    return this.mapMessageRow(inserted[0]!);
  }

  /**
   * Processes gateway delivery webhook report (Handles automated refund on permanent failure)
   */
  async handleDeliveryEvent(
    event: NormalizedDeliveryEvent,
  ): Promise<SmsMessageRecord | null> {
    const rows = await sql<Record<string, any>>`
      SELECT * FROM sms_messages
      WHERE provider_message_id = ${event.providerMessageId}
      LIMIT 1
    `;
    if (rows.length === 0) return null;

    const targetMessage = this.mapMessageRow(rows[0]!);
    const now = new Date();

    if (event.eventType === 'DELIVERED') {
      const updated = await sql<Record<string, any>>`
        UPDATE sms_messages
        SET status = ${SmsStatus.DELIVERED},
            delivered_at = ${event.carrierTimestamp},
            updated_at = ${now}
        WHERE id = ${targetMessage.id}
        RETURNING *
      `;
      return this.mapMessageRow(updated[0]!);
    } else if (event.eventType === 'FAILED') {
      if (targetMessage.status !== SmsStatus.FAILED) {
        const updated = await sql<Record<string, any>>`
          UPDATE sms_messages
          SET status = ${SmsStatus.FAILED},
              updated_at = ${now}
          WHERE id = ${targetMessage.id}
          RETURNING *
        `;
        await this.refundCredits(
          targetMessage.organizationId,
          targetMessage.costCredits,
          `refund_${targetMessage.id}`,
        );
        return this.mapMessageRow(updated[0]!);
      }
    }

    return targetMessage;
  }
}

export const messagingService = new MessagingService();
