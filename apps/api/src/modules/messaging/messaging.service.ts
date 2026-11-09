import { createHash, randomUUID } from 'node:crypto';
import {
  GatewayMode,
  CreditLedgerEntryType,
  SmsStatus,
  FeatureKey,
  UpdateGatewayConfigDto,
  MessagingAccountDto,
  MessageDispatchResult,
  NormalizedDeliveryEvent,
  InsufficientCreditsError,
  BriskError,
} from '@brisksms/shared';
import { sql, withTransaction, SqlExecutor } from '@brisksms/db';
import {
  MessagingAccountRecord,
  MessagingCreditLedgerRecord,
  SmsCampaignRecord,
  SmsCampaignRecipientRecord,
  SmsMessageRecord,
  MessageIdempotencyRecord,
} from '../../core/store.js';
import { entitlementService } from '../subscription/entitlement.service.js';
import { MessagingProvider } from './interfaces/messaging-provider.interface.js';
import { smsGateProvider } from './providers/smsgate.provider.js';
import { recipientParserService } from './recipient-parser.service.js';
import { HttpException } from '../../core/http.js';

/** Durable dispatch lease. After expiry an unfinished DISPATCHING operation becomes UNCERTAIN, never re-dispatched. */
const DISPATCH_LEASE_SECONDS = 60;

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

  mapIdempotencyRow(row: Record<string, any>): MessageIdempotencyRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      status: row.status as any,
      messageId: row.message_id ?? null,
      responsePayload:
        typeof row.response_payload === 'string'
          ? JSON.parse(row.response_payload)
          : (row.response_payload ?? null),
      claimedBy: row.claimed_by ?? null,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async getIdempotencyRecord(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<MessageIdempotencyRecord | null> {
    const rows = await sql<Record<string, any>>`
      SELECT * FROM message_idempotency_records
      WHERE organization_id = ${organizationId} AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return this.mapIdempotencyRow(rows[0]!);
  }

  async getMessageById(
    organizationId: string,
    messageId: string,
  ): Promise<SmsMessageRecord | null> {
    const rows = await sql<Record<string, any>>`
      SELECT * FROM sms_messages
      WHERE id = ${messageId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return this.mapMessageRow(rows[0]!);
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
      gatewayBaseUrl = 'https://gateway.brisksms.com/api/3rdparty/v1';
    } else if (dto.gatewayMode === GatewayMode.EXTERNAL_RELAY && !account.gatewayBaseUrl) {
      gatewayBaseUrl = 'https://api.sms-gate.app/3rdparty/v1';
    }

    let authStored: string | null = account.encryptedApiToken;
    if (dto.auth) {
      authStored = JSON.stringify(dto.auth);
    } else if (dto.apiToken !== undefined) {
      authStored = dto.apiToken;
    }

    const defaultSimSlot = dto.defaultSimSlot !== undefined ? dto.defaultSimSlot : account.defaultSimSlot;
    const now = new Date();

    const updated = await sql<Record<string, any>>`
      UPDATE messaging_accounts
      SET gateway_mode = ${gatewayMode},
          gateway_base_url = ${gatewayBaseUrl},
          encrypted_api_token = ${authStored},
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
    metadata?: Record<string, any>,
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

      // Idempotency: verify if this exact reference was already deducted
      if (referenceId) {
        const existing = await tx<Record<string, any>>`
          SELECT id FROM messaging_credit_ledger
          WHERE organization_id = ${organizationId}
            AND reference_id = ${referenceId}
            AND entry_type = ${CreditLedgerEntryType.USAGE_DEDUCTION}
          LIMIT 1
        `;
        if (existing.length > 0) {
          return currentBalance;
        }
      }

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
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, metadata, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.USAGE_DEDUCTION},
          ${amountCredits}, ${newBalance}, ${referenceId ?? null}, ${metadata ? JSON.stringify(metadata) : null}::jsonb, ${now}
        )
      `;

      return newBalance;
    });
  }

  /**
   * Atomically refunds credits upon permanent delivery failure (with duplicate refund protection)
   */
  async refundCredits(
    organizationId: string,
    amountCredits: number,
    referenceId?: string,
    existingTx?: SqlExecutor,
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

      // Protection against duplicate refunds
      if (referenceId) {
        const existingRefund = await tx<Record<string, any>>`
          SELECT id FROM messaging_credit_ledger
          WHERE organization_id = ${organizationId}
            AND reference_id = ${referenceId}
            AND entry_type = ${CreditLedgerEntryType.REFUND}
          LIMIT 1
        `;
        if (existingRefund.length > 0) {
          return currentBalance;
        }
      }

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
    }, existingTx);
  }

  /**
   * Retrieves the current available credit balance for an organization
   */
  async getBalance(organizationId: string): Promise<number> {
    const account = await this.getOrCreateAccount(organizationId);
    return account.creditBalance;
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
   * Checks whether the current or specified time falls within product anti-spam curfew hours (configurable, defaults to 20:00 - 07:00 EAT)
   */
  isCurfewRestricted(sendDate: Date = new Date()): boolean {
    if (process.env.PROMOTIONAL_CURFEW_ENABLED === 'false') {
      return false;
    }
    const startHour = Number(process.env.PROMOTIONAL_CURFEW_START_HOUR_EAT ?? 20);
    const endHour = Number(process.env.PROMOTIONAL_CURFEW_END_HOUR_EAT ?? 7);

    const utcHours = sendDate.getUTCHours();
    const eatHours = (utcHours + 3) % 24;

    if (startHour > endHour) {
      // Overnight curfew, e.g. 20:00 to 07:00 EAT
      return eatHours >= startHour || eatHours < endHour;
    } else {
      return eatHours >= startHour && eatHours < endHour;
    }
  }

  /**
   * Durable, organization-scoped single-message dispatch with crash recovery.
   *
   * Operation state lives in PostgreSQL (message_idempotency_records.status); every transition is a
   * compare-and-set so API instances and sweepers never need shared memory to agree:
   *   PENDING     Credit deducted and sms_messages(QUEUED) committed; the gateway was definitely NOT contacted.
   *   DISPATCHING Claimed by exactly one dispatcher under a lease; the gateway MAY have been contacted.
   *   COMPLETED   Gateway accepted the request (SUBMITTED); delivery is tracked by webhooks.
   *   FAILED      Definitive gateway rejection; credit refunded in the same transaction as the status change.
   *   UNCERTAIN   Outcome unknowable (timeout, reset, 5xx, expired lease). Never refunded, never re-dispatched.
   * Exactly-once external delivery is NOT claimed: UNCERTAIN operations need operator reconciliation.
   */
  async sendSingleMessage(
    organizationId: string,
    payload: {
      to: string;
      content: string;
      simSlot?: number;
      isPromotional?: boolean;
      campaignId?: string;
      idempotencyKey?: string;
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
        'Product anti-spam policy: Promotional SMS broadcasts are restricted between 20:00 and 07:00 EAT. Transactional messages are unaffected.',
      );
    }

    const account = await this.getOrCreateAccount(organizationId);
    if (!account.encryptedApiToken) {
      throw new BriskError('MESSAGING_ERROR', 'No cellular gateway token configured. Please connect a relay gateway first.');
    }

    const simSlot = payload.simSlot ?? account.defaultSimSlot;
    const fingerprint = createHash('sha256')
      .update(`${organizationId}:${normalizedPhone}:${payload.content}:${simSlot}`)
      .digest('hex');
    const idempotencyKey = payload.idempotencyKey?.trim() || randomUUID();

    await this.reserveDispatch(organizationId, idempotencyKey, fingerprint, {
      to: normalizedPhone,
      content: payload.content,
      simSlot,
      campaignId: payload.campaignId,
    });
    return this.resolveDispatch(organizationId, idempotencyKey, fingerprint);
  }

  /**
   * Step 1 (one ACID transaction): claim the (organization, key) slot, deduct 1 credit and persist the
   * QUEUED message. A duplicate key is a no-op here; an insufficient balance rolls everything back.
   */
  async reserveDispatch(
    organizationId: string,
    idempotencyKey: string,
    fingerprint: string,
    input: { to: string; content: string; simSlot: number; campaignId?: string },
  ): Promise<void> {
    await withTransaction(async (tx) => {
      const now = new Date();
      const inserted = await tx<Record<string, any>>`
        INSERT INTO message_idempotency_records (
          id, organization_id, idempotency_key, request_fingerprint, status, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${idempotencyKey}, ${fingerprint}, 'PENDING', ${now}, ${now}
        )
        ON CONFLICT (organization_id, idempotency_key) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) return;

      const accRows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts WHERE organization_id = ${organizationId} FOR UPDATE
      `;
      const currentBalance = Number(accRows[0]?.credit_balance ?? 0);
      if (currentBalance < 1) {
        throw new InsufficientCreditsError(1, currentBalance);
      }
      const newBalance = currentBalance - 1;
      const messageId = randomUUID();

      await tx`
        UPDATE messaging_accounts SET credit_balance = ${newBalance}, updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;
      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reference_id, metadata, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.USAGE_DEDUCTION},
          1, ${newBalance}, ${idempotencyKey},
          ${JSON.stringify({ idempotencyKey, fingerprint, messageId, recipientPhone: input.to, simSlot: input.simSlot })}::jsonb,
          ${now}
        )
      `;
      await tx`
        INSERT INTO sms_messages (
          id, organization_id, campaign_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, gateway_provider, created_at, updated_at
        ) VALUES (
          ${messageId}, ${organizationId}, ${input.campaignId ?? null}, ${input.to}, ${input.content},
          ${SmsStatus.QUEUED}, 1, ${input.simSlot}, ${accRows[0]!.gateway_mode}, ${now}, ${now}
        )
      `;
      await tx`
        UPDATE message_idempotency_records SET message_id = ${messageId}
        WHERE id = ${inserted[0]!.id}
      `;
    });
  }

  /**
   * Step 2: drive the operation to a settled state without ever dispatching twice.
   * PENDING is dispatched by whichever caller wins the claim; DISPATCHING is left to its owner until the
   * lease expires (then UNCERTAIN); settled states return the original message.
   */
  private async resolveDispatch(
    organizationId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<SmsMessageRecord> {
    for (let poll = 0; poll < 25; poll++) {
      const record = await this.getIdempotencyRecord(organizationId, idempotencyKey);
      if (!record || !record.messageId) {
        throw new HttpException(500, 'INTERNAL_ERROR', 'Idempotency record is missing its message');
      }
      if (record.requestFingerprint !== fingerprint) {
        throw new HttpException(
          409,
          'DUPLICATE_IDEMPOTENCY',
          'Idempotency key was previously used with different request parameters',
        );
      }

      if (record.status === 'PENDING') {
        const dispatched = await this.dispatchReserved(record);
        if (dispatched) return dispatched;
      } else if (record.status === 'DISPATCHING') {
        await this.expireDispatchLeases(record.id);
      } else {
        const settled = await this.getMessageById(organizationId, record.messageId);
        if (settled) return settled;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new HttpException(
      409,
      'DUPLICATE_IDEMPOTENCY',
      'Request with this idempotency key is currently being processed. Please retry shortly.',
    );
  }

  /**
   * Dispatches a reserved (PENDING) operation: everything needed is read back from PostgreSQL, so it works
   * after a crash. Returns null when another dispatcher won the claim.
   */
  private async dispatchReserved(record: MessageIdempotencyRecord): Promise<SmsMessageRecord | null> {
    const message = await this.getMessageById(record.organizationId, record.messageId!);
    const account = await this.getOrCreateAccount(record.organizationId);
    if (!message || !account.encryptedApiToken) {
      throw new BriskError('MESSAGING_ERROR', 'No cellular gateway token configured. Please connect a relay gateway first.');
    }

    const claimed = await this.claimDispatch(record.id);
    if (!claimed) return null;

    let result: MessageDispatchResult;
    try {
      result = await this.provider.sendMessage(
        {
          mode: account.gatewayMode,
          baseUrl: account.gatewayBaseUrl || 'https://gateway.brisksms.com/api/v1',
          apiToken: account.encryptedApiToken,
          defaultSimSlot: account.defaultSimSlot,
        },
        {
          organizationId: record.organizationId,
          campaignId: message.campaignId ?? undefined,
          to: message.recipientPhone,
          content: message.messageText,
          idempotencyKey: record.idempotencyKey,
          simSlot: message.simSlot,
        },
      );
    } catch (err: unknown) {
      result = {
        providerMessageId: '',
        status: 'UNCERTAIN',
        rawResponse: { error: err instanceof Error ? err.message : String(err), uncertain: true },
      };
    }
    return this.finalizeDispatch(claimed, message, result);
  }

  /**
   * Durable claim: exactly one caller flips PENDING -> DISPATCHING. The lease uses PostgreSQL time so
   * instances with skewed clocks agree. After this commits the gateway MAY be contacted.
   */
  async claimDispatch(recordId: string): Promise<MessageIdempotencyRecord | null> {
    const claimant = `${process.pid}_${randomUUID()}`;
    const rows = await sql<Record<string, any>>`
      UPDATE message_idempotency_records
      SET status = 'DISPATCHING',
          claimed_by = ${claimant},
          lease_expires_at = NOW() + (${DISPATCH_LEASE_SECONDS}::int * INTERVAL '1 second'),
          dispatch_started_at = NOW(),
          updated_at = NOW()
      WHERE id = ${recordId} AND status = 'PENDING'
      RETURNING *
    `;
    return rows.length > 0 ? this.mapIdempotencyRow(rows[0]!) : null;
  }

  /**
   * Persists the gateway outcome. Only the claimant may settle, so a stale or foreign process cannot
   * overwrite it. A definitive FAILED refunds in the same transaction (refund is also reference-idempotent).
   * UNCERTAIN keeps the credit and keeps the message QUEUED with no provider id (nothing to correlate).
   */
  private async finalizeDispatch(
    claimed: MessageIdempotencyRecord,
    message: SmsMessageRecord,
    result: MessageDispatchResult,
  ): Promise<SmsMessageRecord> {
    const outcome =
      result.status === 'DISPATCHED' ? 'COMPLETED' : result.status === 'FAILED' ? 'FAILED' : 'UNCERTAIN';
    const smsStatus =
      outcome === 'COMPLETED' ? SmsStatus.SUBMITTED : outcome === 'FAILED' ? SmsStatus.FAILED : SmsStatus.QUEUED;
    const providerMessageId = outcome === 'UNCERTAIN' ? null : result.providerMessageId;
    const detail = String(result.rawResponse?.error ?? '');
    const errorText =
      outcome === 'COMPLETED'
        ? null
        : outcome === 'FAILED'
          ? detail || 'Gateway rejected the request'
          : `GATEWAY_UNCERTAIN: ${detail || 'gateway outcome unknown'}`;
    const now = new Date();

    return withTransaction(async (tx) => {
      const settled = await tx<Record<string, any>>`
        UPDATE message_idempotency_records
        SET status = ${outcome},
            response_payload = ${JSON.stringify({
              messageId: message.id,
              status: smsStatus,
              recipientPhone: message.recipientPhone,
              costCredits: message.costCredits,
              outcome,
            })}::jsonb,
            updated_at = ${now}
        WHERE id = ${claimed.id}
          AND claimed_by = ${claimed.claimedBy}
          AND status IN ('DISPATCHING', 'UNCERTAIN')
        RETURNING id
      `;
      if (settled.length === 0) {
        return (await this.getMessageById(message.organizationId, message.id)) ?? message;
      }

      const updated = await tx<Record<string, any>>`
        UPDATE sms_messages
        SET status = ${smsStatus}, provider_message_id = ${providerMessageId},
            last_error = ${errorText}, updated_at = ${now}
        WHERE id = ${message.id} AND organization_id = ${message.organizationId}
        RETURNING *
      `;
      await tx`
        INSERT INTO sms_delivery_attempts (
          id, organization_id, message_id, attempt_number, gateway_provider,
          provider_message_id, status, error_message, raw_response, attempted_at
        ) VALUES (
          ${randomUUID()}, ${message.organizationId}, ${message.id}, 1, ${message.gatewayProvider},
          ${providerMessageId}, ${smsStatus}::"SmsStatus", ${errorText},
          ${result.rawResponse ? JSON.stringify(result.rawResponse) : null}::jsonb, ${now}
        )
      `;
      if (outcome === 'FAILED') {
        await this.refundCredits(message.organizationId, message.costCredits, `refund_${message.id}`, tx);
      }
      return this.mapMessageRow(updated[0]!);
    });
  }

  /**
   * DISPATCHING operations whose lease expired are marked UNCERTAIN (optionally only `recordId`).
   * They are never re-dispatched and never refunded automatically.
   */
  private async expireDispatchLeases(recordId?: string): Promise<number> {
    const expired = await sql<Record<string, any>>`
      WITH expired AS (
        UPDATE message_idempotency_records
        SET status = 'UNCERTAIN', updated_at = NOW()
        WHERE status = 'DISPATCHING'
          AND lease_expires_at < NOW()
          AND (${recordId ?? null}::uuid IS NULL OR id = ${recordId ?? null}::uuid)
        RETURNING message_id
      )
      UPDATE sms_messages
      SET last_error = 'GATEWAY_UNCERTAIN: dispatch lease expired before the gateway outcome was recorded',
          updated_at = NOW()
      WHERE id IN (SELECT message_id FROM expired)
      RETURNING id
    `;
    return expired.length;
  }

  /**
   * Recovery sweep (safe to run from any number of instances): expired leases become UNCERTAIN, and
   * reservations still PENDING after the grace period (gateway never contacted) are dispatched.
   */
  async recoverStaleDispatches(
    options: { pendingGraceSeconds?: number; limit?: number } = {},
  ): Promise<{ expiredToUncertain: number; resumed: number }> {
    const expiredToUncertain = await this.expireDispatchLeases();
    const stale = await sql<Record<string, any>>`
      SELECT * FROM message_idempotency_records
      WHERE status = 'PENDING' AND message_id IS NOT NULL
        AND created_at < NOW() - (${options.pendingGraceSeconds ?? 60}::int * INTERVAL '1 second')
      ORDER BY created_at ASC
      LIMIT ${options.limit ?? 50}
    `;
    let resumed = 0;
    for (const row of stale) {
      if (await this.dispatchReserved(this.mapIdempotencyRow(row))) resumed++;
    }
    return { expiredToUncertain, resumed };
  }

  /**
   * Operations whose gateway outcome is unknown and need operator reconciliation.
   */
  async listUncertainDispatches(organizationId: string): Promise<
    Array<{ idempotencyKey: string; messageId: string; recipientPhone: string; lastError: string | null; since: Date }>
  > {
    const rows = await sql<Record<string, any>>`
      SELECT r.idempotency_key, r.message_id, r.updated_at, m.recipient_phone, m.last_error
      FROM message_idempotency_records r
      JOIN sms_messages m ON m.id = r.message_id AND m.organization_id = r.organization_id
      WHERE r.organization_id = ${organizationId} AND r.status = 'UNCERTAIN'
      ORDER BY r.updated_at ASC
    `;
    return rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      messageId: r.message_id,
      recipientPhone: r.recipient_phone,
      lastError: r.last_error ?? null,
      since: new Date(r.updated_at),
    }));
  }

  /**
   * Processes gateway delivery webhook report with strict idempotency and terminal state protection.
   * Atomically executes in an ACID transaction with row-level locks (SELECT ... FOR UPDATE).
   * - Never moves a DELIVERED message backwards to FAILED.
   * - Never triggers duplicate refunds.
   * - Distinguishes SENT from DELIVERED.
   * - Safely returns null on unknown provider message ID.
   */
  async handleDeliveryEvent(
    event: NormalizedDeliveryEvent,
  ): Promise<SmsMessageRecord | null> {
    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM sms_messages
        WHERE provider_message_id = ${event.providerMessageId}
        FOR UPDATE
      `;
      if (rows.length === 0) return null;

      const targetMessage = this.mapMessageRow(rows[0]!);
      const now = new Date();

      // 1. Terminal State Protection: A delivered message cannot be reverted to failed or re-refunded
      if (targetMessage.status === SmsStatus.DELIVERED) {
        return targetMessage; // Idempotent no-op
      }

      if (event.eventType === 'DELIVERED') {
        const updated = await tx<Record<string, any>>`
          UPDATE sms_messages
          SET status = ${SmsStatus.DELIVERED},
              delivered_at = ${event.carrierTimestamp},
              updated_at = ${now}
          WHERE id = ${targetMessage.id}
          RETURNING *
        `;

        await tx`
          UPDATE message_idempotency_records
          SET status = 'COMPLETED', updated_at = ${now}
          WHERE message_id = ${targetMessage.id}
        `;

        return this.mapMessageRow(updated[0]!);
      } else if (event.eventType === 'FAILED') {
        // 2. Failure State Protection: Never refund more than once
        if (targetMessage.status !== SmsStatus.FAILED) {
          const updated = await tx<Record<string, any>>`
            UPDATE sms_messages
            SET status = ${SmsStatus.FAILED},
                last_error = ${event.failureReason ?? 'Carrier transmission failed'},
                updated_at = ${now}
            WHERE id = ${targetMessage.id}
            RETURNING *
          `;

          await tx`
            UPDATE message_idempotency_records
            SET status = 'FAILED', updated_at = ${now}
            WHERE message_id = ${targetMessage.id}
          `;

          // Atomic credit refund within the same transaction
          const accRows = await tx<Record<string, any>>`
            SELECT * FROM messaging_accounts
            WHERE organization_id = ${targetMessage.organizationId}
            FOR UPDATE
          `;
          if (accRows.length > 0) {
            const currentBalance = Number(accRows[0]!.credit_balance);
            const newBalance = currentBalance + targetMessage.costCredits;
            await tx`
              UPDATE messaging_accounts
              SET credit_balance = ${newBalance}, updated_at = ${now}
              WHERE organization_id = ${targetMessage.organizationId}
            `;
            await tx`
              INSERT INTO messaging_credit_ledger (
                id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
              ) VALUES (
                ${randomUUID()}, ${targetMessage.organizationId}, ${CreditLedgerEntryType.REFUND},
                ${targetMessage.costCredits}, ${newBalance}, ${`refund_${targetMessage.id}`}, ${now}
              )
            `;
          }

          return this.mapMessageRow(updated[0]!);
        }
      } else if (event.eventType === 'SENT') {
        if (targetMessage.status === SmsStatus.QUEUED) {
          const updated = await tx<Record<string, any>>`
            UPDATE sms_messages
            SET status = ${SmsStatus.SUBMITTED},
                updated_at = ${now}
            WHERE id = ${targetMessage.id}
            RETURNING *
          `;
          return this.mapMessageRow(updated[0]!);
        }
      }

      return targetMessage;
    });
  }

  /**
   * Concurrency-safe atomic processing of an incoming SMSGate delivery webhook.
   *
   * Transaction Boundaries:
   * 1. Checks or locks smsgate_webhook_events with row-level locks.
   *    - If event with eventFingerprint already exists and status is 'PROCESSED': returns { duplicate: true }.
   * 2. Locks target sms_messages row FOR UPDATE strictly scoped to organizationId.
   *    - Cross-tenant validation: if provider_message_id belongs to another organization, throws 403 CROSS_TENANT_FORBIDDEN.
   * 3. Performs terminal state mutations (DELIVERED/FAILED/SUBMITTED).
   *    - If FAILED and previously un-refunded: atomically increments messaging_accounts and appends messaging_credit_ledger REFUND.
   * 4. Persists smsgate_webhook_events record with status = 'PROCESSED' in the SAME transaction.
   * 5. If any step fails, entire transaction rolls back; no event is saved as PROCESSED, remaining safely retryable.
   */
  async processSmsGateWebhookDelivery(params: {
    organizationId: string;
    deviceId?: string;
    eventFingerprint: string;
    event: NormalizedDeliveryEvent;
    signature: string;
    timestamp: string;
  }): Promise<{ duplicate: boolean; messageRecord: SmsMessageRecord | null }> {
    return withTransaction(async (tx) => {
      const now = new Date();

      // 1. Concurrency-safe event identity reservation using PostgreSQL unique constraint
      const insertResult = await tx<Record<string, any>>`
        INSERT INTO smsgate_webhook_events (
          id, organization_id, device_id, event_fingerprint, provider_message_id,
          event_type, signature, timestamp, status, first_seen_at, processed_at
        ) VALUES (
          ${randomUUID()}, ${params.organizationId}, ${params.deviceId ?? null},
          ${params.eventFingerprint}, ${params.event.providerMessageId}, ${params.event.eventType},
          ${params.signature}, ${BigInt(params.timestamp)}, 'PROCESSED',
          ${now}, ${now}
        )
        ON CONFLICT ("event_fingerprint") DO NOTHING
        RETURNING id, status
      `;

      if (insertResult.length === 0) {
        // Event already exists (concurrent duplicate or retried duplicate)
        const msgRows = await tx<Record<string, any>>`
          SELECT * FROM sms_messages
          WHERE provider_message_id = ${params.event.providerMessageId}
            AND organization_id = ${params.organizationId}
          LIMIT 1
        `;
        const currentMsg = msgRows.length > 0 ? this.mapMessageRow(msgRows[0]!) : null;
        return {
          duplicate: true,
          messageRecord: currentMsg,
        };
      }

      // 2. Cross-tenant check: Verify message belongs to the authoritative organization
      const anyMsgRows = await tx<Record<string, any>>`
        SELECT id, organization_id FROM sms_messages
        WHERE provider_message_id = ${params.event.providerMessageId}
        LIMIT 1
      `;

      if (anyMsgRows.length > 0 && anyMsgRows[0]!.organization_id !== params.organizationId) {
        throw new HttpException(
          403,
          'CROSS_TENANT_FORBIDDEN',
          'Target provider message ID belongs to a different organization',
        );
      }

      // 3. Lock target message row FOR UPDATE
      const rows = await tx<Record<string, any>>`
        SELECT * FROM sms_messages
        WHERE provider_message_id = ${params.event.providerMessageId}
          AND organization_id = ${params.organizationId}
        FOR UPDATE
      `;

      let updatedRecord: SmsMessageRecord | null = null;

      if (rows.length > 0) {
        const targetMessage = this.mapMessageRow(rows[0]!);

        if (targetMessage.status === SmsStatus.DELIVERED) {
          // Terminal State Protection: Delivered messages are never demoted or refunded
          updatedRecord = targetMessage;
        } else if (params.event.eventType === 'DELIVERED') {
          const updated = await tx<Record<string, any>>`
            UPDATE sms_messages
            SET status = ${SmsStatus.DELIVERED},
                delivered_at = ${params.event.carrierTimestamp},
                updated_at = ${now}
            WHERE id = ${targetMessage.id}
            RETURNING *
          `;
          updatedRecord = this.mapMessageRow(updated[0]!);
        } else if (params.event.eventType === 'FAILED') {
          if (targetMessage.status !== SmsStatus.FAILED) {
            const updated = await tx<Record<string, any>>`
              UPDATE sms_messages
              SET status = ${SmsStatus.FAILED},
                  last_error = ${params.event.failureReason ?? 'Carrier transmission failed'},
                  updated_at = ${now}
              WHERE id = ${targetMessage.id}
              RETURNING *
            `;

            // Atomic credit refund
            const accRows = await tx<Record<string, any>>`
              SELECT * FROM messaging_accounts
              WHERE organization_id = ${targetMessage.organizationId}
              FOR UPDATE
            `;
            if (accRows.length > 0) {
              const currentBalance = Number(accRows[0]!.credit_balance);
              const newBalance = currentBalance + targetMessage.costCredits;
              await tx`
                UPDATE messaging_accounts
                SET credit_balance = ${newBalance}, updated_at = ${now}
                WHERE organization_id = ${targetMessage.organizationId}
              `;
              await tx`
                INSERT INTO messaging_credit_ledger (
                  id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
                ) VALUES (
                  ${randomUUID()}, ${targetMessage.organizationId}, ${CreditLedgerEntryType.REFUND},
                  ${targetMessage.costCredits}, ${newBalance}, ${`refund_${targetMessage.id}`}, ${now}
                )
              `;
            }

            updatedRecord = this.mapMessageRow(updated[0]!);
          } else {
            updatedRecord = targetMessage;
          }
        } else if (params.event.eventType === 'SENT') {
          if (targetMessage.status === SmsStatus.QUEUED) {
            const updated = await tx<Record<string, any>>`
              UPDATE sms_messages
              SET status = ${SmsStatus.SUBMITTED},
                  updated_at = ${now}
              WHERE id = ${targetMessage.id}
              RETURNING *
            `;
            updatedRecord = this.mapMessageRow(updated[0]!);
          } else {
            updatedRecord = targetMessage;
          }
        } else {
          updatedRecord = targetMessage;
        }
      }

      return {
        duplicate: false,
        messageRecord: updatedRecord,
      };
    });
  }
}

export const messagingService = new MessagingService();
