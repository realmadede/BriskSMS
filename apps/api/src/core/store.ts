import { randomUUID } from 'node:crypto';
import {
  UserRole,
  DeviceStatus,
  DeviceIngestionMode,
  ProductType,
  BillingInterval,
  SubscriptionStatus,
  EntitlementType,
  GatewayMode,
  CreditLedgerEntryType,
  SmsStatus,
  CampaignStatus,
  EvidenceSourceType,
  PaymentProvider,
  TransactionState,
  InvoiceStatus,
  ApiKeyScope,
  BusinessEventType,
  OutboxStatus,
  VerificationMethod,
} from '@brisksms/shared';
import {
  assertTenantContext,
  sql,
  withTransaction,
  SqlExecutor,
  resetTestDatabaseState,
  seedCommercialCatalog,
} from '@brisksms/db';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  phoneNumber?: string;
  isEmailVerified: boolean;
  isActive: boolean;
  twoFactorSecret?: string;
  twoFactorEnabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  timezone: string;
  planTier: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserOrganizationRecord {
  id: string;
  organizationId: string;
  userId: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationInvitationRecord {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
  invitedById: string;
  tokenHash: string;
  status: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceRecord {
  id: string;
  organizationId: string;
  label: string;
  deviceModel: string;
  manufacturer: string;
  androidVersion: string;
  appVersion: string;
  publicKeyPem: string;
  status: DeviceStatus;
  ingestionMode: DeviceIngestionMode;
  deviceTokenHash: string;
  lastSyncAt: Date | null;
  revokedAt: Date | null;
  revokedById?: string | null;
  revocationReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceTelemetryRecord {
  id: string;
  deviceId: string;
  batteryPct: number;
  isCharging: boolean;
  networkType: string;
  signalStrengthDbm: number | null;
  pendingOfflineCount: number;
  recordedAt: Date;
}

export interface PairingTokenRecord {
  id?: string;
  token: string;
  organizationId: string;
  createdById: string;
  expiresAt: Date;
  usedAt?: Date | null;
  usedByDeviceId?: string | null;
  createdAt?: Date;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  userId: string;
  jti: string;
  expiresAt: Date;
  revokedAt?: Date | null;
}

export interface AuditLogRecord {
  id: string;
  organizationId: string;
  actorId: string;
  actorType: 'USER' | 'DEVICE' | 'SYSTEM' | 'API_KEY';
  action: string;
  resourceType: string;
  resourceId: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CommercialProductRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  productType: ProductType;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionPlanRecord {
  id: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanVersionRecord {
  id: string;
  planId: string;
  versionNumber: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
  trialPeriodDays: number;
  gracePeriodDays: number;
  createdAt: Date;
}

export interface PlanPriceRecord {
  id: string;
  planVersionId: string;
  currency: string;
  amountCents: bigint;
  billingInterval: BillingInterval;
  isActive: boolean;
  createdAt: Date;
}

export interface FeatureDefinitionRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: EntitlementType;
  defaultValue: string;
  createdAt: Date;
}

export interface PlanEntitlementRecord {
  id: string;
  planVersionId: string;
  featureKey: string;
  value: string;
  createdAt: Date;
}

export interface OrganizationSubscriptionRecord {
  id: string;
  organizationId: string;
  planVersionId: string;
  status: SubscriptionStatus;
  currency: string;
  unitPriceCents: bigint;
  billingInterval: BillingInterval;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  canceledAt: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionBillingInvoiceRecord {
  id: string;
  organizationId: string;
  subscriptionId: string;
  invoiceNumber: string;
  amountCents: bigint;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  isPaid: boolean;
  paidAt: Date | null;
  paymentProviderRef: string | null;
  createdAt: Date;
}

export interface SubscriptionHistoryRecord {
  id: string;
  organizationId: string;
  subscriptionId: string;
  planVersionId: string;
  eventType: string;
  previousStatus: SubscriptionStatus | null;
  newStatus: SubscriptionStatus;
  unitPriceCents: bigint;
  currency: string;
  billingInterval: BillingInterval;
  actorId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface MessagingAccountRecord {
  id: string;
  organizationId: string;
  creditBalance: number;
  reservedCredits: number;
  gatewayMode: GatewayMode;
  gatewayBaseUrl: string | null;
  encryptedApiToken: string | null;
  defaultSimSlot: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessagingCreditLedgerRecord {
  id: string;
  organizationId: string;
  entryType: CreditLedgerEntryType;
  amountCredits: number;
  balanceAfter: number;
  reservedAfter: number;
  referenceId: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SmsMessageRecord {
  id: string;
  organizationId: string;
  campaignId: string | null;
  recipientPhone: string;
  messageText: string;
  status: SmsStatus;
  costCredits: number;
  simSlot: number;
  providerMessageId: string | null;
  gatewayProvider: string | null;
  attemptCount: number;
  lastError?: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SmsCampaignRecord {
  id: string;
  organizationId: string;
  senderIdId: string | null;
  name: string;
  messageTemplate: string;
  status: CampaignStatus;
  recipientCount: number;
  scheduledAt: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SmsCampaignRecipientRecord {
  id: string;
  organizationId: string;
  campaignId: string;
  recipientPhone: string;
  variables: Record<string, string> | null;
  interpolatedText: string;
  status: SmsStatus;
  messageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SmsDeliveryAttemptRecord {
  id: string;
  organizationId: string;
  messageId: string;
  attemptNumber: number;
  gatewayProvider: string;
  providerMessageId: string | null;
  status: SmsStatus;
  errorMessage: string | null;
  rawResponse: Record<string, unknown> | null;
  attemptedAt: Date;
}

export interface RawPaymentEvidenceRecord {
  id: string;
  organizationId: string;
  sourceType: EvidenceSourceType;
  deviceId?: string | null;
  senderAddress: string;
  rawPayload: string;
  simSlot: number;
  deviceTimestamp: Date;
  signature?: string | null;
  nonce?: string | null;
  sequenceNumber?: bigint | null;
  parserVersion: string;
  parseStatus: string;
  receivedAt: Date;
}

export interface NormalizedPaymentRecord {
  id: string;
  organizationId: string;
  deviceId?: string | null;
  rawEvidenceId: string;
  provider: PaymentProvider;
  reference: string;
  amountCents: bigint;
  currency: string;
  senderPhone: string;
  senderName: string | null;
  recipientAccount: string | null;
  customerMemo: string | null;
  providerTimestamp: Date;
  parserVersion: string;
  state: TransactionState;
  confidenceTier?: string | null;
  deduplicationHash: string;
  candidateInvoiceId?: string | null;
  matchedInvoiceId: string | null;
  reviewReason?: string | null;
  verifiedAt?: Date | null;
  verifiedById?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentVerificationRecord {
  id: string;
  organizationId: string;
  paymentId: string;
  invoiceId: string | null;
  verificationMethod: VerificationMethod;
  decision: 'APPROVED' | 'REJECTED';
  verifiedById: string | null;
  externalVerificationRef: string | null;
  notes: string | null;
  previousState: TransactionState;
  newState: TransactionState;
  createdAt: Date;
}

export interface InvoiceRecord {
  id: string;
  organizationId: string;
  customerId?: string | null;
  referenceNumber: string;
  totalAmountCents: bigint;
  paidAmountCents: bigint;
  balanceCents: bigint;
  currency: string;
  status: InvoiceStatus;
  customerPhone?: string | null;
  customerName?: string | null;
  dueDate?: Date | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoicePaymentRecord {
  id: string;
  organizationId: string;
  invoiceId: string;
  paymentId: string;
  verificationId: string | null;
  appliedAmountCents: bigint;
  createdAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  keyHash: string;
  keyPrefix: string;
  label: string;
  scopes: ApiKeyScope[];
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  rotatedFromId?: string | null;
  createdAt: Date;
}

export interface WebhookEndpointRecord {
  id: string;
  organizationId: string;
  url: string;
  secret: string;
  subscribedEvents: BusinessEventType[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryRecord {
  id: string;
  organizationId: string;
  endpointId: string;
  outboxEventId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  responseStatus: number | null;
  responseBody: string | null;
  attemptNumber: number;
  status: string;
  nextRetryAt: Date | null;
  deliveredAt: Date;
  createdAt: Date;
}

export interface OutboxEventRecord {
  id: string;
  organizationId: string;
  eventType: BusinessEventType;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  isDelivered: boolean;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastAttemptAt?: Date | null;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  lastError?: string | null;
  deliveredAt?: Date | null;
  createdAt: Date;
}

export interface OAuthClientRecord {
  id: string;
  organizationId: string;
  name: string;
  clientSecretHash: string | null;
  redirectUris: string[];
  isPublic: boolean;
  createdAt: Date;
  updatedAt?: Date;
}

export interface OAuthAuthorizationCodeRecord {
  code: string;
  clientId: string;
  userId: string;
  organizationId: string;
  redirectUri: string;
  scopes: ApiKeyScope[];
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  expiresAt: Date;
  isUsed: boolean;
  usedAt?: Date | null;
  createdAt: Date;
}

export interface OAuthTokenRecord {
  id?: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  clientId: string;
  userId: string;
  organizationId: string;
  scopes: ApiKeyScope[];
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

// Row mappers from PostgreSQL snake_case columns to canonical TypeScript records
export function mapUserRow(row: Record<string, any>): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    fullName: row.full_name,
    phoneNumber: row.phone_number ?? undefined,
    isEmailVerified: Boolean(row.is_email_verified),
    isActive: Boolean(row.is_active),
    twoFactorSecret: row.two_factor_secret ?? undefined,
    twoFactorEnabled: Boolean(row.two_factor_enabled),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapOrgRow(row: Record<string, any>): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    countryCode: row.country_code,
    timezone: row.timezone,
    planTier: row.plan_tier,
    isActive: Boolean(row.is_active),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapMembershipRow(row: Record<string, any>): UserOrganizationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role as UserRole,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapDeviceRow(row: Record<string, any>): DeviceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    label: row.label,
    deviceModel: row.device_model,
    manufacturer: row.manufacturer,
    androidVersion: row.android_version,
    appVersion: row.app_version,
    publicKeyPem: row.public_key_pem,
    deviceTokenHash: row.device_token_hash,
    status: row.status as DeviceStatus,
    ingestionMode: row.ingestion_mode as DeviceIngestionMode,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    revokedById: row.revoked_by_id ?? null,
    revocationReason: row.revocation_reason ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapTelemetryRow(row: Record<string, any>): DeviceTelemetryRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    batteryPct: Number(row.battery_pct),
    isCharging: Boolean(row.is_charging),
    networkType: row.network_type,
    signalStrengthDbm: row.signal_strength_dbm !== null ? Number(row.signal_strength_dbm) : null,
    pendingOfflineCount: Number(row.pending_offline_count ?? 0),
    recordedAt: new Date(row.recorded_at),
  };
}

export function mapInvoiceRow(row: Record<string, any>): InvoiceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerId: row.customer_id ?? null,
    referenceNumber: row.reference_number,
    totalAmountCents: BigInt(row.total_amount_cents),
    paidAmountCents: BigInt(row.paid_amount_cents ?? 0),
    balanceCents: BigInt(row.balance_cents),
    currency: row.currency,
    status: row.status as InvoiceStatus,
    customerPhone: row.customer_phone ?? null,
    customerName: row.customer_name ?? null,
    dueDate: row.due_date ? new Date(row.due_date) : null,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapNormalizedPaymentRow(row: Record<string, any>): NormalizedPaymentRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    deviceId: row.device_id ?? null,
    rawEvidenceId: row.raw_evidence_id,
    provider: row.provider as PaymentProvider,
    reference: row.reference,
    amountCents: BigInt(row.amount_cents),
    currency: row.currency,
    senderPhone: row.sender_phone,
    senderName: row.sender_name ?? null,
    recipientAccount: row.recipient_account ?? null,
    customerMemo: row.customer_memo ?? null,
    providerTimestamp: new Date(row.provider_timestamp),
    parserVersion: row.parser_version ?? '1.0.0',
    state: row.state as TransactionState,
    confidenceTier: row.confidence_tier ?? null,
    deduplicationHash: row.deduplication_hash,
    candidateInvoiceId: row.candidate_invoice_id ?? null,
    matchedInvoiceId: row.matched_invoice_id ?? null,
    reviewReason: row.review_reason ?? null,
    verifiedAt: row.verified_at ? new Date(row.verified_at) : null,
    verifiedById: row.verified_by_id ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapRawEvidenceRow(row: Record<string, any>): RawPaymentEvidenceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sourceType: row.source_type as EvidenceSourceType,
    deviceId: row.device_id ?? null,
    senderAddress: row.sender_address,
    rawPayload: row.raw_payload,
    simSlot: Number(row.sim_slot ?? 1),
    deviceTimestamp: new Date(row.device_timestamp),
    signature: row.signature ?? null,
    nonce: row.nonce ?? null,
    sequenceNumber: row.sequence_number !== null && row.sequence_number !== undefined ? BigInt(row.sequence_number) : null,
    parserVersion: row.parser_version ?? '1.0.0',
    parseStatus: row.parse_status ?? 'OBSERVED',
    receivedAt: new Date(row.received_at),
  };
}

export function mapOutboxRow(row: Record<string, any>): OutboxEventRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventType: row.event_type as BusinessEventType,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}),
    status: (row.status as OutboxStatus) ?? OutboxStatus.PENDING,
    isDelivered: Boolean(row.is_delivered),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 5),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : new Date(row.created_at),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : null,
    lockedAt: row.locked_at ? new Date(row.locked_at) : null,
    lockedBy: row.locked_by ?? null,
    lastError: row.last_error ?? null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Authoritative PostgreSQL Persistence Store.
 * Contains ZERO in-memory Maps or fallback caches. All reads and writes hit PostgreSQL directly.
 */
export class PostgresStore {
  async reset(): Promise<void> {
    await resetTestDatabaseState();
  }

  async seedDefaultCatalog(tx?: SqlExecutor): Promise<void> {
    await seedCommercialCatalog(tx);
  }

  // --- Users ---
  async createUser(
    data: { email: string; passwordHash: string; fullName: string; phoneNumber?: string },
    tx: SqlExecutor = sql,
  ): Promise<UserRecord> {
    const emailNorm = data.email.trim().toLowerCase();
    const id = randomUUID();
    const rows = await tx`
      INSERT INTO "users" ("id", "email", "password_hash", "full_name", "phone_number", "is_email_verified", "is_active")
      VALUES (${id}, ${emailNorm}, ${data.passwordHash}, ${data.fullName}, ${data.phoneNumber ?? null}, false, true)
      RETURNING *
    `;
    return mapUserRow(rows[0]!);
  }

  async findUserByEmail(email: string, tx: SqlExecutor = sql): Promise<UserRecord | null> {
    const emailNorm = email.trim().toLowerCase();
    const rows = await tx`SELECT * FROM "users" WHERE "email" = ${emailNorm} LIMIT 1`;
    return rows[0] ? mapUserRow(rows[0]) : null;
  }

  async findUserById(id: string, tx: SqlExecutor = sql): Promise<UserRecord | null> {
    const rows = await tx`SELECT * FROM "users" WHERE "id" = ${id} LIMIT 1`;
    return rows[0] ? mapUserRow(rows[0]) : null;
  }

  // --- Organizations ---
  async createOrganization(
    data: { name: string; slug: string; creatorUserId: string; countryCode?: string },
    existingTx?: SqlExecutor,
  ): Promise<{ org: OrganizationRecord; membership: UserOrganizationRecord }> {
    return withTransaction(async (tx) => {
      const slugNorm = data.slug.trim().toLowerCase();
      const orgId = randomUUID();
      const orgRows = await tx`
        INSERT INTO "organizations" ("id", "name", "slug", "country_code", "timezone", "plan_tier", "is_active")
        VALUES (${orgId}, ${data.name}, ${slugNorm}, ${data.countryCode || 'TZA'}, 'Africa/Dar_es_Salaam', 'STARTER', true)
        RETURNING *
      `;
      const org = mapOrgRow(orgRows[0]!);

      const membershipId = randomUUID();
      const memRows = await tx`
        INSERT INTO "users_organizations" ("id", "organization_id", "user_id", "role")
        VALUES (${membershipId}, ${orgId}, ${data.creatorUserId}, ${UserRole.OWNER}::"UserRole")
        RETURNING *
      `;
      const membership = mapMembershipRow(memRows[0]!);

      await this.recordAudit(
        {
          organizationId: orgId,
          actorId: data.creatorUserId,
          actorType: 'USER',
          action: 'ORGANIZATION_CREATED',
          resourceType: 'ORGANIZATION',
          resourceId: orgId,
        },
        tx,
      );

      return { org, membership };
    }, existingTx);
  }

  async seedOrganizationDirect(org: Partial<OrganizationRecord> & { id: string; name: string; slug: string }): Promise<OrganizationRecord> {
    const rows = await sql`
      INSERT INTO "organizations" ("id", "name", "slug", "country_code", "timezone", "plan_tier", "is_active")
      VALUES (
        ${org.id},
        ${org.name},
        ${org.slug},
        ${org.countryCode || 'TZA'},
        ${org.timezone || 'Africa/Dar_es_Salaam'},
        ${org.planTier || 'STARTER'},
        ${org.isActive ?? true}
      )
      ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "plan_tier" = EXCLUDED."plan_tier"
      RETURNING *
    `;
    return mapOrgRow(rows[0]!);
  }

  async findOrgById(orgId: string, tx: SqlExecutor = sql): Promise<OrganizationRecord | null> {
    const rows = await tx`SELECT * FROM "organizations" WHERE "id" = ${orgId} LIMIT 1`;
    return rows[0] ? mapOrgRow(rows[0]) : null;
  }

  async getUserOrganizations(userId: string, tx: SqlExecutor = sql): Promise<{ org: OrganizationRecord; role: UserRole }[]> {
    const rows = await tx`
      SELECT o.*, uo."role" AS "member_role"
      FROM "users_organizations" uo
      JOIN "organizations" o ON o."id" = uo."organization_id"
      WHERE uo."user_id" = ${userId} AND o."is_active" = true
      ORDER BY uo."created_at" ASC
    `;
    return rows.map((r) => ({
      org: mapOrgRow(r),
      role: r.member_role as UserRole,
    }));
  }

  async getMembership(organizationId: string, userId: string, tx: SqlExecutor = sql): Promise<UserOrganizationRecord | null> {
    const rows = await tx`
      SELECT * FROM "users_organizations"
      WHERE "organization_id" = ${organizationId} AND "user_id" = ${userId}
      LIMIT 1
    `;
    return rows[0] ? mapMembershipRow(rows[0]) : null;
  }

  async addMember(
    data: { organizationId: string; userId: string; role: UserRole; actorId: string },
    existingTx?: SqlExecutor,
  ): Promise<UserOrganizationRecord> {
    assertTenantContext({ organizationId: data.organizationId });
    return withTransaction(async (tx) => {
      const id = randomUUID();
      const rows = await tx`
        INSERT INTO "users_organizations" ("id", "organization_id", "user_id", "role")
        VALUES (${id}, ${data.organizationId}, ${data.userId}, ${data.role}::"UserRole")
        RETURNING *
      `;
      const record = mapMembershipRow(rows[0]!);

      await this.recordAudit(
        {
          organizationId: data.organizationId,
          actorId: data.actorId,
          actorType: 'USER',
          action: 'MEMBER_INVITED',
          resourceType: 'USER_ORGANIZATION',
          resourceId: id,
          metadata: { userId: data.userId, role: data.role },
        },
        tx,
      );

      return record;
    }, existingTx);
  }

  async updateMemberRole(
    data: { organizationId: string; userId: string; newRole: UserRole; actorId: string },
    existingTx?: SqlExecutor,
  ): Promise<UserOrganizationRecord> {
    assertTenantContext({ organizationId: data.organizationId });
    return withTransaction(async (tx) => {
      const rows = await tx`
        UPDATE "users_organizations"
        SET "role" = ${data.newRole}::"UserRole", "updated_at" = NOW()
        WHERE "organization_id" = ${data.organizationId} AND "user_id" = ${data.userId}
        RETURNING *
      `;
      if (!rows[0]) {
        throw new Error('Member not found in organization');
      }
      const mem = mapMembershipRow(rows[0]);

      await this.recordAudit(
        {
          organizationId: data.organizationId,
          actorId: data.actorId,
          actorType: 'USER',
          action: 'MEMBER_ROLE_UPDATED',
          resourceType: 'USER_ORGANIZATION',
          resourceId: mem.id,
          metadata: { userId: data.userId, newRole: data.newRole },
        },
        tx,
      );

      return mem;
    }, existingTx);
  }

  async removeMember(organizationId: string, userId: string, actorId: string, existingTx?: SqlExecutor): Promise<void> {
    assertTenantContext({ organizationId });
    await withTransaction(async (tx) => {
      const rows = await tx<{ id: string }>`
        DELETE FROM "users_organizations"
        WHERE "organization_id" = ${organizationId} AND "user_id" = ${userId}
        RETURNING "id"
      `;
      if (!rows[0]) {
        throw new Error('Member not found in organization');
      }

      await this.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'MEMBER_REMOVED',
          resourceType: 'USER_ORGANIZATION',
          resourceId: rows[0].id,
          metadata: { userId },
        },
        tx,
      );
    }, existingTx);
  }

  async getOrgMembers(organizationId: string, tx: SqlExecutor = sql): Promise<{ user: UserRecord; role: UserRole }[]> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT u.*, uo."role" AS "member_role"
      FROM "users_organizations" uo
      JOIN "users" u ON u."id" = uo."user_id"
      WHERE uo."organization_id" = ${organizationId}
      ORDER BY uo."created_at" ASC
    `;
    return rows.map((r) => ({
      user: mapUserRow(r),
      role: r.member_role as UserRole,
    }));
  }

  async countOrgMembers(organizationId: string, tx: SqlExecutor = sql): Promise<number> {
    assertTenantContext({ organizationId });
    const rows = await tx<{ count: string }>`
      SELECT COUNT(*)::text AS "count" FROM "users_organizations" WHERE "organization_id" = ${organizationId}
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  // --- Devices ---
  async createPairingToken(
    data: { organizationId: string; createdById: string; token: string; ttlSeconds?: number },
    tx: SqlExecutor = sql,
  ): Promise<PairingTokenRecord> {
    assertTenantContext({ organizationId: data.organizationId });
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + (data.ttlSeconds || 300) * 1000);
    const rows = await tx`
      INSERT INTO "pairing_tokens" ("id", "token", "organization_id", "created_by_id", "expires_at")
      VALUES (${id}, ${data.token}, ${data.organizationId}, ${data.createdById}, ${expiresAt})
      RETURNING *
    `;
    const r = rows[0]!;
    return {
      id: r.id,
      token: r.token,
      organizationId: r.organization_id,
      createdById: r.created_by_id,
      expiresAt: new Date(r.expires_at),
      usedAt: r.used_at ? new Date(r.used_at) : null,
      usedByDeviceId: r.used_by_device_id ?? null,
      createdAt: new Date(r.created_at),
    };
  }

  async getPairingToken(token: string, tx: SqlExecutor = sql): Promise<PairingTokenRecord | null> {
    const rows = await tx`
      SELECT * FROM "pairing_tokens"
      WHERE "token" = ${token} AND "used_at" IS NULL AND "expires_at" > NOW()
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      token: r.token,
      organizationId: r.organization_id,
      createdById: r.created_by_id,
      expiresAt: new Date(r.expires_at),
      usedAt: r.used_at ? new Date(r.used_at) : null,
      usedByDeviceId: r.used_by_device_id ?? null,
      createdAt: new Date(r.created_at),
    };
  }

  async cleanupExpiredPairingTokens(tx: SqlExecutor = sql): Promise<number> {
    const rows = await tx<{ id: string }>`
      DELETE FROM "pairing_tokens"
      WHERE "expires_at" <= NOW() AND "used_at" IS NULL
      RETURNING "id"
    `;
    return rows.length;
  }

  async registerDevice(
    data: {
      id?: string;
      organizationId: string;
      label: string;
      deviceModel: string;
      manufacturer: string;
      androidVersion: string;
      appVersion: string;
      publicKeyPem: string;
      ingestionMode: DeviceIngestionMode;
      tokenHash: string;
      status?: DeviceStatus;
    },
    existingTx?: SqlExecutor,
  ): Promise<DeviceRecord> {
    assertTenantContext({ organizationId: data.organizationId });
    return withTransaction(async (tx) => {
      const id = data.id || randomUUID();
      const status = data.status || DeviceStatus.ACTIVE;
      const rows = await tx`
        INSERT INTO "devices" (
          "id", "organization_id", "label", "device_model", "manufacturer",
          "android_version", "app_version", "public_key_pem", "device_token_hash",
          "status", "ingestion_mode", "last_sync_at"
        )
        VALUES (
          ${id}, ${data.organizationId}, ${data.label}, ${data.deviceModel}, ${data.manufacturer},
          ${data.androidVersion}, ${data.appVersion}, ${data.publicKeyPem}, ${data.tokenHash},
          ${status}::"DeviceStatus", ${data.ingestionMode}::"DeviceIngestionMode", NOW()
        )
        RETURNING *
      `;
      const device = mapDeviceRow(rows[0]!);

      await this.recordAudit(
        {
          organizationId: data.organizationId,
          actorId: id,
          actorType: 'DEVICE',
          action: 'DEVICE_REGISTERED',
          resourceType: 'DEVICE',
          resourceId: id,
          metadata: { model: data.deviceModel, mode: data.ingestionMode },
        },
        tx,
      );

      return device;
    }, existingTx);
  }

  async getOrgDevices(organizationId: string, tx: SqlExecutor = sql): Promise<DeviceRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "devices"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" ASC
    `;
    return rows.map(mapDeviceRow);
  }

  async getDeviceById(deviceId: string, organizationId?: string, tx: SqlExecutor = sql): Promise<DeviceRecord | null> {
    if (organizationId) {
      const rows = await tx`
        SELECT * FROM "devices" WHERE "id" = ${deviceId} AND "organization_id" = ${organizationId} LIMIT 1
      `;
      return rows[0] ? mapDeviceRow(rows[0]) : null;
    }
    const rows = await tx`SELECT * FROM "devices" WHERE "id" = ${deviceId} LIMIT 1`;
    return rows[0] ? mapDeviceRow(rows[0]) : null;
  }

  async getDeviceByTokenHash(tokenHash: string, tx: SqlExecutor = sql): Promise<DeviceRecord | null> {
    const rows = await tx`
      SELECT * FROM "devices"
      WHERE "device_token_hash" = ${tokenHash}
      LIMIT 1
    `;
    return rows[0] ? mapDeviceRow(rows[0]) : null;
  }

  async recordTelemetry(
    data: {
      deviceId: string;
      batteryPct: number;
      isCharging: boolean;
      networkType: string;
      signalStrengthDbm: number | null;
      pendingOfflineCount: number;
    },
    existingTx?: SqlExecutor,
  ): Promise<DeviceTelemetryRecord> {
    return withTransaction(async (tx) => {
      const devRows = await tx`
        SELECT * FROM "devices" WHERE "id" = ${data.deviceId} FOR UPDATE
      `;
      if (!devRows[0] || devRows[0].status === DeviceStatus.REVOKED) {
        throw new Error('Device is not active or has been revoked');
      }

      const id = randomUUID();
      const telRows = await tx`
        INSERT INTO "device_telemetry" (
          "id", "device_id", "battery_pct", "is_charging", "network_type",
          "signal_strength_dbm", "pending_offline_count"
        )
        VALUES (
          ${id}, ${data.deviceId}, ${data.batteryPct}, ${data.isCharging},
          ${data.networkType}, ${data.signalStrengthDbm}, ${data.pendingOfflineCount}
        )
        RETURNING *
      `;

      await tx`
        UPDATE "devices"
        SET "last_sync_at" = NOW(), "updated_at" = NOW()
        WHERE "id" = ${data.deviceId}
      `;

      return mapTelemetryRow(telRows[0]!);
    }, existingTx);
  }

  async getDeviceTelemetry(deviceId: string, limit: number = 20, tx: SqlExecutor = sql): Promise<DeviceTelemetryRecord[]> {
    const rows = await tx`
      SELECT * FROM "device_telemetry"
      WHERE "device_id" = ${deviceId}
      ORDER BY "recorded_at" DESC
      LIMIT ${limit}
    `;
    return rows.map(mapTelemetryRow);
  }

  async revokeDevice(
    deviceId: string,
    organizationId: string,
    actorId: string,
    reason?: string,
    existingTx?: SqlExecutor,
  ): Promise<DeviceRecord> {
    assertTenantContext({ organizationId });
    return withTransaction(async (tx) => {
      const rows = await tx`
        UPDATE "devices"
        SET
          "status" = 'REVOKED'::"DeviceStatus",
          "revoked_at" = NOW(),
          "revoked_by_id" = ${actorId},
          "revocation_reason" = ${reason ?? 'Revoked by administrator'},
          "updated_at" = NOW()
        WHERE "id" = ${deviceId} AND "organization_id" = ${organizationId}
        RETURNING *
      `;
      if (!rows[0]) {
        throw new Error('Device not found in organization');
      }

      await this.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'DEVICE_REVOKED',
          resourceType: 'DEVICE',
          resourceId: deviceId,
        },
        tx,
      );

      return mapDeviceRow(rows[0]);
    }, existingTx);
  }

  // --- Dynamic Subscription & Commercial Catalog ---
  async getFeatureDefinitions(tx: SqlExecutor = sql): Promise<FeatureDefinitionRecord[]> {
    const rows = await tx`SELECT * FROM "feature_definitions" ORDER BY "key" ASC`;
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description ?? null,
      type: r.type as EntitlementType,
      defaultValue: r.default_value,
      createdAt: new Date(r.created_at),
    }));
  }

  async setFeatureDefinitionDefaultValue(featureKey: string, defaultValue: string, tx: SqlExecutor = sql): Promise<void> {
    await tx`
      UPDATE "feature_definitions" SET "default_value" = ${defaultValue} WHERE "key" = ${featureKey}
    `;
  }

  async getPublicCatalog(tx: SqlExecutor = sql): Promise<
    Array<{
      product: CommercialProductRecord;
      plans: Array<{
        plan: SubscriptionPlanRecord;
        currentVersion: PlanVersionRecord;
        prices: PlanPriceRecord[];
        entitlements: PlanEntitlementRecord[];
      }>;
    }>
  > {
    const prodRows = await tx`
      SELECT * FROM "commercial_products" WHERE "is_active" = true ORDER BY "created_at" ASC
    `;
    const catalog: Array<{
      product: CommercialProductRecord;
      plans: Array<{
        plan: SubscriptionPlanRecord;
        currentVersion: PlanVersionRecord;
        prices: PlanPriceRecord[];
        entitlements: PlanEntitlementRecord[];
      }>;
    }> = [];

    for (const pr of prodRows) {
      const product: CommercialProductRecord = {
        id: pr.id,
        code: pr.code,
        name: pr.name,
        description: pr.description ?? null,
        productType: pr.product_type as ProductType,
        isActive: Boolean(pr.is_active),
        createdAt: new Date(pr.created_at),
        updatedAt: new Date(pr.updated_at),
      };

      const planRows = await tx`
        SELECT * FROM "subscription_plans"
        WHERE "product_id" = ${product.id} AND "is_public" = true
        ORDER BY "created_at" ASC
      `;

      const prodPlans: Array<{
        plan: SubscriptionPlanRecord;
        currentVersion: PlanVersionRecord;
        prices: PlanPriceRecord[];
        entitlements: PlanEntitlementRecord[];
      }> = [];

      for (const plr of planRows) {
        const plan: SubscriptionPlanRecord = {
          id: plr.id,
          productId: plr.product_id,
          code: plr.code,
          name: plr.name,
          description: plr.description ?? null,
          isPublic: Boolean(plr.is_public),
          createdAt: new Date(plr.created_at),
          updatedAt: new Date(plr.updated_at),
        };

        const currentVersion = await this.getActivePlanVersion(plan.id, tx);
        if (!currentVersion) continue;

        const prices = await this.getPlanPrices(currentVersion.id, tx);
        const entitlements = await this.getPlanEntitlements(currentVersion.id, tx);

        prodPlans.push({
          plan,
          currentVersion,
          prices,
          entitlements,
        });
      }

      catalog.push({ product, plans: prodPlans });
    }

    return catalog;
  }

  async getPlanByCode(code: string, tx: SqlExecutor = sql): Promise<SubscriptionPlanRecord | null> {
    const rows = await tx`SELECT * FROM "subscription_plans" WHERE "code" = ${code} LIMIT 1`;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      productId: r.product_id,
      code: r.code,
      name: r.name,
      description: r.description ?? null,
      isPublic: Boolean(r.is_public),
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  async getPlanById(id: string, tx: SqlExecutor = sql): Promise<SubscriptionPlanRecord | null> {
    const rows = await tx`SELECT * FROM "subscription_plans" WHERE "id" = ${id} LIMIT 1`;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      productId: r.product_id,
      code: r.code,
      name: r.name,
      description: r.description ?? null,
      isPublic: Boolean(r.is_public),
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  async getActivePlanVersion(planId: string, tx: SqlExecutor = sql): Promise<PlanVersionRecord | null> {
    const rows = await tx`
      SELECT * FROM "plan_versions"
      WHERE "plan_id" = ${planId} AND "is_active" = true AND "effective_to" IS NULL
      ORDER BY "version_number" DESC
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      planId: r.plan_id,
      versionNumber: Number(r.version_number),
      effectiveFrom: new Date(r.effective_from),
      effectiveTo: r.effective_to ? new Date(r.effective_to) : null,
      isActive: Boolean(r.is_active),
      trialPeriodDays: Number(r.trial_period_days),
      gracePeriodDays: Number(r.grace_period_days),
      createdAt: new Date(r.created_at),
    };
  }

  async getPlanVersionById(versionId: string, tx: SqlExecutor = sql): Promise<PlanVersionRecord | null> {
    const rows = await tx`SELECT * FROM "plan_versions" WHERE "id" = ${versionId} LIMIT 1`;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      planId: r.plan_id,
      versionNumber: Number(r.version_number),
      effectiveFrom: new Date(r.effective_from),
      effectiveTo: r.effective_to ? new Date(r.effective_to) : null,
      isActive: Boolean(r.is_active),
      trialPeriodDays: Number(r.trial_period_days),
      gracePeriodDays: Number(r.grace_period_days),
      createdAt: new Date(r.created_at),
    };
  }

  async getPlanPrices(versionId: string, tx: SqlExecutor = sql): Promise<PlanPriceRecord[]> {
    const rows = await tx`
      SELECT * FROM "plan_prices"
      WHERE "plan_version_id" = ${versionId} AND "is_active" = true
      ORDER BY "created_at" ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      planVersionId: r.plan_version_id,
      currency: r.currency,
      amountCents: BigInt(r.amount_cents),
      billingInterval: r.billing_interval as BillingInterval,
      isActive: Boolean(r.is_active),
      createdAt: new Date(r.created_at),
    }));
  }

  async getPlanEntitlements(versionId: string, tx: SqlExecutor = sql): Promise<PlanEntitlementRecord[]> {
    const rows = await tx`
      SELECT * FROM "plan_entitlements"
      WHERE "plan_version_id" = ${versionId}
      ORDER BY "feature_key" ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      planVersionId: r.plan_version_id,
      featureKey: r.feature_key,
      value: r.value,
      createdAt: new Date(r.created_at),
    }));
  }

  async getOrganizationSubscription(organizationId: string, tx: SqlExecutor = sql): Promise<OrganizationSubscriptionRecord | null> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "organization_subscriptions" WHERE "organization_id" = ${organizationId} LIMIT 1
    `;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      planVersionId: r.plan_version_id,
      status: r.status as SubscriptionStatus,
      currency: r.currency,
      unitPriceCents: BigInt(r.unit_price_cents),
      billingInterval: r.billing_interval as BillingInterval,
      currentPeriodStart: new Date(r.current_period_start),
      currentPeriodEnd: new Date(r.current_period_end),
      trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at) : null,
      canceledAt: r.canceled_at ? new Date(r.canceled_at) : null,
      cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  async saveSubscription(
    sub: OrganizationSubscriptionRecord,
    tx: SqlExecutor = sql,
  ): Promise<OrganizationSubscriptionRecord> {
    assertTenantContext({ organizationId: sub.organizationId });
    const rows = await tx`
      INSERT INTO "organization_subscriptions" (
        "id", "organization_id", "plan_version_id", "status", "currency",
        "unit_price_cents", "billing_interval", "current_period_start",
        "current_period_end", "trial_ends_at", "canceled_at", "cancel_at_period_end", "updated_at"
      )
      VALUES (
        ${sub.id}, ${sub.organizationId}, ${sub.planVersionId}, ${sub.status}::"SubscriptionStatus", ${sub.currency},
        ${sub.unitPriceCents.toString()}::bigint, ${sub.billingInterval}::"BillingInterval", ${sub.currentPeriodStart},
        ${sub.currentPeriodEnd}, ${sub.trialEndsAt}, ${sub.canceledAt}, ${sub.cancelAtPeriodEnd}, NOW()
      )
      ON CONFLICT ("organization_id") DO UPDATE SET
        "plan_version_id" = EXCLUDED."plan_version_id",
        "status" = EXCLUDED."status",
        "currency" = EXCLUDED."currency",
        "unit_price_cents" = EXCLUDED."unit_price_cents",
        "billing_interval" = EXCLUDED."billing_interval",
        "current_period_start" = EXCLUDED."current_period_start",
        "current_period_end" = EXCLUDED."current_period_end",
        "trial_ends_at" = EXCLUDED."trial_ends_at",
        "canceled_at" = EXCLUDED."canceled_at",
        "cancel_at_period_end" = EXCLUDED."cancel_at_period_end",
        "updated_at" = NOW()
      RETURNING *
    `;
    const r = rows[0]!;
    return {
      id: r.id,
      organizationId: r.organization_id,
      planVersionId: r.plan_version_id,
      status: r.status as SubscriptionStatus,
      currency: r.currency,
      unitPriceCents: BigInt(r.unit_price_cents),
      billingInterval: r.billing_interval as BillingInterval,
      currentPeriodStart: new Date(r.current_period_start),
      currentPeriodEnd: new Date(r.current_period_end),
      trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at) : null,
      canceledAt: r.canceled_at ? new Date(r.canceled_at) : null,
      cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  async createSubscriptionInvoice(
    invoice: SubscriptionBillingInvoiceRecord,
    tx: SqlExecutor = sql,
  ): Promise<SubscriptionBillingInvoiceRecord> {
    assertTenantContext({ organizationId: invoice.organizationId });
    const rows = await tx`
      INSERT INTO "subscription_billing_invoices" (
        "id", "organization_id", "subscription_id", "invoice_number",
        "amount_cents", "currency", "period_start", "period_end",
        "is_paid", "paid_at", "payment_provider_ref"
      )
      VALUES (
        ${invoice.id}, ${invoice.organizationId}, ${invoice.subscriptionId}, ${invoice.invoiceNumber},
        ${invoice.amountCents.toString()}::bigint, ${invoice.currency}, ${invoice.periodStart}, ${invoice.periodEnd},
        ${invoice.isPaid}, ${invoice.paidAt}, ${invoice.paymentProviderRef}
      )
      RETURNING *
    `;
    const r = rows[0]!;
    return {
      id: r.id,
      organizationId: r.organization_id,
      subscriptionId: r.subscription_id,
      invoiceNumber: r.invoice_number,
      amountCents: BigInt(r.amount_cents),
      currency: r.currency,
      periodStart: new Date(r.period_start),
      periodEnd: new Date(r.period_end),
      isPaid: Boolean(r.is_paid),
      paidAt: r.paid_at ? new Date(r.paid_at) : null,
      paymentProviderRef: r.payment_provider_ref ?? null,
      createdAt: new Date(r.created_at),
    };
  }

  async getSubscriptionInvoices(organizationId: string, tx: SqlExecutor = sql): Promise<SubscriptionBillingInvoiceRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "subscription_billing_invoices"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      subscriptionId: r.subscription_id,
      invoiceNumber: r.invoice_number,
      amountCents: BigInt(r.amount_cents),
      currency: r.currency,
      periodStart: new Date(r.period_start),
      periodEnd: new Date(r.period_end),
      isPaid: Boolean(r.is_paid),
      paidAt: r.paid_at ? new Date(r.paid_at) : null,
      paymentProviderRef: r.payment_provider_ref ?? null,
      createdAt: new Date(r.created_at),
    }));
  }

  async adminCreatePlan(
    data: {
      productCode: string;
      code: string;
      name: string;
      description?: string;
      isPublic?: boolean;
      trialPeriodDays?: number;
      gracePeriodDays?: number;
      prices: Array<{ currency: string; amountCents: bigint; billingInterval: BillingInterval }>;
      entitlements: Record<string, string>;
    },
    existingTx?: SqlExecutor,
  ): Promise<{ plan: SubscriptionPlanRecord; version: PlanVersionRecord }> {
    return withTransaction(async (tx) => {
      const prodRows = await tx`SELECT "id" FROM "commercial_products" WHERE "code" = ${data.productCode} LIMIT 1`;
      if (!prodRows[0]) {
        throw new Error(`Product '${data.productCode}' not found`);
      }
      const prodId = prodRows[0].id as string;

      const planId = randomUUID();
      const planRows = await tx`
        INSERT INTO "subscription_plans" ("id", "product_id", "code", "name", "description", "is_public")
        VALUES (${planId}, ${prodId}, ${data.code}, ${data.name}, ${data.description ?? null}, ${data.isPublic ?? true})
        RETURNING *
      `;
      const plr = planRows[0]!;
      const plan: SubscriptionPlanRecord = {
        id: plr.id,
        productId: plr.product_id,
        code: plr.code,
        name: plr.name,
        description: plr.description ?? null,
        isPublic: Boolean(plr.is_public),
        createdAt: new Date(plr.created_at),
        updatedAt: new Date(plr.updated_at),
      };

      const versionId = randomUUID();
      const verRows = await tx`
        INSERT INTO "plan_versions" ("id", "plan_id", "version_number", "is_active", "trial_period_days", "grace_period_days")
        VALUES (${versionId}, ${plan.id}, 1, true, ${data.trialPeriodDays ?? 0}, ${data.gracePeriodDays ?? 3})
        RETURNING *
      `;
      const vr = verRows[0]!;
      const version: PlanVersionRecord = {
        id: vr.id,
        planId: vr.plan_id,
        versionNumber: Number(vr.version_number),
        effectiveFrom: new Date(vr.effective_from),
        effectiveTo: vr.effective_to ? new Date(vr.effective_to) : null,
        isActive: Boolean(vr.is_active),
        trialPeriodDays: Number(vr.trial_period_days),
        gracePeriodDays: Number(vr.grace_period_days),
        createdAt: new Date(vr.created_at),
      };

      for (const p of data.prices) {
        await tx`
          INSERT INTO "plan_prices" ("id", "plan_version_id", "currency", "amount_cents", "billing_interval", "is_active")
          VALUES (${randomUUID()}, ${version.id}, ${p.currency}, ${p.amountCents.toString()}::bigint, ${p.billingInterval}::"BillingInterval", true)
        `;
      }

      for (const [key, val] of Object.entries(data.entitlements)) {
        await tx`
          INSERT INTO "plan_entitlements" ("id", "plan_version_id", "feature_key", "value")
          VALUES (${randomUUID()}, ${version.id}, ${key}, ${val})
        `;
      }

      return { plan, version };
    }, existingTx);
  }

  async adminCreateNewPlanVersion(
    data: {
      planCode: string;
      prices: Array<{ currency: string; amountCents: bigint; billingInterval: BillingInterval }>;
      entitlements: Record<string, string>;
      trialPeriodDays?: number;
      gracePeriodDays?: number;
    },
    existingTx?: SqlExecutor,
  ): Promise<PlanVersionRecord> {
    return withTransaction(async (tx) => {
      const plan = await this.getPlanByCode(data.planCode, tx);
      if (!plan) {
        throw new Error(`Plan '${data.planCode}' not found`);
      }

      const oldVersion = await this.getActivePlanVersion(plan.id, tx);
      let nextVersionNumber = 1;
      if (oldVersion) {
        await tx`
          UPDATE "plan_versions" SET "effective_to" = NOW() WHERE "id" = ${oldVersion.id}
        `;
        nextVersionNumber = oldVersion.versionNumber + 1;
      }

      const newVersionId = randomUUID();
      const verRows = await tx`
        INSERT INTO "plan_versions" ("id", "plan_id", "version_number", "is_active", "trial_period_days", "grace_period_days")
        VALUES (
          ${newVersionId},
          ${plan.id},
          ${nextVersionNumber},
          true,
          ${data.trialPeriodDays ?? (oldVersion?.trialPeriodDays ?? 0)},
          ${data.gracePeriodDays ?? (oldVersion?.gracePeriodDays ?? 3)}
        )
        RETURNING *
      `;
      const vr = verRows[0]!;
      const newVersion: PlanVersionRecord = {
        id: vr.id,
        planId: vr.plan_id,
        versionNumber: Number(vr.version_number),
        effectiveFrom: new Date(vr.effective_from),
        effectiveTo: vr.effective_to ? new Date(vr.effective_to) : null,
        isActive: Boolean(vr.is_active),
        trialPeriodDays: Number(vr.trial_period_days),
        gracePeriodDays: Number(vr.grace_period_days),
        createdAt: new Date(vr.created_at),
      };

      for (const p of data.prices) {
        await tx`
          INSERT INTO "plan_prices" ("id", "plan_version_id", "currency", "amount_cents", "billing_interval", "is_active")
          VALUES (${randomUUID()}, ${newVersion.id}, ${p.currency}, ${p.amountCents.toString()}::bigint, ${p.billingInterval}::"BillingInterval", true)
        `;
      }

      for (const [key, val] of Object.entries(data.entitlements)) {
        await tx`
          INSERT INTO "plan_entitlements" ("id", "plan_version_id", "feature_key", "value")
          VALUES (${randomUUID()}, ${newVersion.id}, ${key}, ${val})
        `;
      }

      return newVersion;
    }, existingTx);
  }

  // --- Audit Logs (Immutable) ---
  async recordAudit(
    data: {
      organizationId: string;
      actorId: string;
      actorType: 'USER' | 'DEVICE' | 'SYSTEM' | 'API_KEY';
      action: string;
      resourceType: string;
      resourceId: string;
      previousState?: Record<string, unknown> | null;
      newState?: Record<string, unknown> | null;
      metadata?: Record<string, unknown>;
    },
    tx: SqlExecutor = sql,
  ): Promise<AuditLogRecord> {
    assertTenantContext({ organizationId: data.organizationId });
    const id = randomUUID();
    const rows = await tx`
      INSERT INTO "audit_logs" (
        "id", "organization_id", "actor_id", "actor_type", "action",
        "resource_type", "resource_id", "previous_state", "new_state", "metadata"
      )
      VALUES (
        ${id},
        ${data.organizationId},
        ${data.actorId},
        ${data.actorType},
        ${data.action},
        ${data.resourceType},
        ${data.resourceId},
        ${data.previousState ? JSON.stringify(data.previousState) : null}::jsonb,
        ${data.newState ? JSON.stringify(data.newState) : null}::jsonb,
        ${data.metadata ? JSON.stringify(data.metadata) : null}::jsonb
      )
      RETURNING *
    `;
    const r = rows[0]!;
    return {
      id: r.id,
      organizationId: r.organization_id,
      actorId: r.actor_id,
      actorType: r.actor_type,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      previousState: typeof r.previous_state === 'string' ? JSON.parse(r.previous_state) : (r.previous_state ?? null),
      newState: typeof r.new_state === 'string' ? JSON.parse(r.new_state) : (r.new_state ?? null),
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? undefined),
      createdAt: new Date(r.created_at),
    };
  }

  async getAuditLogs(organizationId: string, tx: SqlExecutor = sql): Promise<AuditLogRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "audit_logs"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      actorId: r.actor_id,
      actorType: r.actor_type,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      previousState: typeof r.previous_state === 'string' ? JSON.parse(r.previous_state) : (r.previous_state ?? null),
      newState: typeof r.new_state === 'string' ? JSON.parse(r.new_state) : (r.new_state ?? null),
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? undefined),
      createdAt: new Date(r.created_at),
    }));
  }

  // --- Transactional Outbox Helpers ---
  async insertOutboxEvent(
    data: {
      id?: string;
      organizationId: string;
      eventType: BusinessEventType;
      payload: Record<string, unknown>;
      maxAttempts?: number;
    },
    tx: SqlExecutor = sql,
  ): Promise<OutboxEventRecord> {
    assertTenantContext({ organizationId: data.organizationId });
    const id = data.id || randomUUID();
    const rows = await tx`
      INSERT INTO "outbox_events" (
        "id", "organization_id", "event_type", "payload", "status", "is_delivered", "attempt_count", "max_attempts", "next_attempt_at"
      )
      VALUES (
        ${id},
        ${data.organizationId},
        ${data.eventType},
        ${JSON.stringify(data.payload)}::jsonb,
        'PENDING'::"OutboxStatus",
        false,
        0,
        ${data.maxAttempts ?? 5},
        NOW()
      )
      RETURNING *
    `;
    return mapOutboxRow(rows[0]!);
  }

  async getOutboxEvents(organizationId: string, tx: SqlExecutor = sql): Promise<OutboxEventRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "outbox_events"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" ASC
    `;
    return rows.map(mapOutboxRow);
  }

  async getOutboxEventsByOrg(organizationId: string, tx: SqlExecutor = sql): Promise<OutboxEventRecord[]> {
    return this.getOutboxEvents(organizationId, tx);
  }

  async getRawEvidencesByOrg(organizationId: string, tx: SqlExecutor = sql): Promise<RawPaymentEvidenceRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "raw_payment_evidence"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "received_at" ASC
    `;
    return rows.map(mapRawEvidenceRow);
  }

  async getNormalizedPaymentsByOrg(organizationId: string, tx: SqlExecutor = sql): Promise<NormalizedPaymentRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "normalized_payments"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" ASC
    `;
    return rows.map(mapNormalizedPaymentRow);
  }
}

export const dbStore = new PostgresStore();
