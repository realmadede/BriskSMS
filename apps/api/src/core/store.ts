import { randomUUID } from 'node:crypto';
import {
  UserRole,
  DeviceStatus,
  DeviceIngestionMode,
  ProductType,
  BillingInterval,
  SubscriptionStatus,
  EntitlementType,
  FeatureKey,
  GatewayMode,
  CreditLedgerEntryType,
  SmsStatus,
  CampaignStatus,
  EvidenceSourceType,
  TransactionState,
  PaymentProvider,
  InvoiceStatus,
  ApiKeyScope,
  BusinessEventType,
} from '@brisksms/shared';
import { assertTenantContext } from '@brisksms/db';

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

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  phoneNumber?: string;
  isEmailVerified: boolean;
  isActive: boolean;
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
  token: string;
  organizationId: string;
  createdById: string;
  expiresAt: Date;
  usedAt?: Date;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  userId: string;
  jti: string;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface AuditLogRecord {
  id: string;
  organizationId: string;
  actorId: string;
  actorType: 'USER' | 'DEVICE' | 'SYSTEM' | 'API_KEY';
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface MessagingAccountRecord {
  id: string;
  organizationId: string;
  creditBalance: number;
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
  referenceId: string | null;
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
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SmsCampaignRecord {
  id: string;
  organizationId: string;
  senderIdId: string;
  name: string;
  messageTemplate: string;
  status: CampaignStatus;
  recipientCount: number;
  scheduledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
  state: TransactionState;
  deduplicationHash: string;
  matchedInvoiceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoiceRecord {
  id: string;
  organizationId: string;
  customerId?: string | null;
  referenceNumber: string;
  totalAmountCents: bigint;
  paidAmountCents: bigint;
  currency: string;
  status: InvoiceStatus;
  customerPhone?: string | null;
  customerName?: string | null;
  dueDate?: Date | null;
  createdAt: Date;
  updatedAt: Date;
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

export interface OutboxEventRecord {
  id: string;
  organizationId: string;
  eventType: BusinessEventType;
  payload: Record<string, unknown>;
  isDelivered: boolean;
  attemptCount: number;
  lastAttemptAt?: Date | null;
  createdAt: Date;
}

export interface OAuthClientRecord {
  id: string; // client_id
  organizationId: string;
  name: string;
  clientSecretHash: string | null;
  redirectUris: string[];
  isPublic: boolean;
  createdAt: Date;
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
  createdAt: Date;
}

export interface OAuthTokenRecord {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  userId: string;
  organizationId: string;
  scopes: ApiKeyScope[];
  expiresAt: Date;
  refreshExpiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export class MemoryStore {
  users = new Map<string, UserRecord>();
  usersByEmail = new Map<string, string>(); // email -> userId

  organizations = new Map<string, OrganizationRecord>();
  orgsBySlug = new Map<string, string>(); // slug -> orgId

  memberships = new Map<string, UserOrganizationRecord>(); // id -> record
  userOrgLookup = new Map<string, string>(); // `${orgId}:${userId}` -> membershipId

  devices = new Map<string, DeviceRecord>();
  deviceTokenIndex = new Map<string, string>(); // tokenHash -> deviceId

  telemetry: DeviceTelemetryRecord[] = [];
  pairingTokens = new Map<string, PairingTokenRecord>();
  refreshTokens = new Map<string, RefreshTokenRecord>(); // tokenHash -> record
  auditLogs: AuditLogRecord[] = [];

  // Commercial Catalog & Subscription Maps
  products = new Map<string, CommercialProductRecord>();
  productsByCode = new Map<string, string>(); // code -> id

  plans = new Map<string, SubscriptionPlanRecord>();
  plansByCode = new Map<string, string>(); // code -> id

  planVersions = new Map<string, PlanVersionRecord>(); // id -> record
  planPrices = new Map<string, PlanPriceRecord>(); // id -> record
  featureDefinitions = new Map<string, FeatureDefinitionRecord>(); // key -> record
  planEntitlements = new Map<string, PlanEntitlementRecord>(); // `${planVersionId}:${featureKey}` -> record

  subscriptions = new Map<string, OrganizationSubscriptionRecord>(); // organizationId -> record
  subscriptionInvoices: SubscriptionBillingInvoiceRecord[] = [];

  // Product B: Messaging Maps
  messagingAccounts = new Map<string, MessagingAccountRecord>(); // organizationId -> record
  messagingLedgers: MessagingCreditLedgerRecord[] = [];
  smsMessages = new Map<string, SmsMessageRecord>();
  smsCampaigns = new Map<string, SmsCampaignRecord>();

  // Universal Ingestion & Financial Reconciliation Maps
  rawEvidences: RawPaymentEvidenceRecord[] = [];
  normalizedPayments = new Map<string, NormalizedPaymentRecord>(); // id -> record
  paymentsByDeduplication = new Map<string, string>(); // `${orgId}:${dedupHash}` -> paymentId
  invoices = new Map<string, InvoiceRecord>(); // id -> record
  invoicesByReference = new Map<string, string>(); // `${orgId}:${refNumber}` -> invoiceId

  // Developer Platform, Scoped API Keys & Outbox Webhooks
  apiKeys = new Map<string, ApiKeyRecord>(); // id -> record
  apiKeysByHash = new Map<string, string>(); // keyHash -> id
  webhookEndpoints = new Map<string, WebhookEndpointRecord>(); // id -> record
  outboxEvents: OutboxEventRecord[] = [];

  // OAuth 2.0 PKCE Server Maps
  oauthClients = new Map<string, OAuthClientRecord>(); // clientId -> record
  oauthCodes = new Map<string, OAuthAuthorizationCodeRecord>(); // code -> record
  oauthTokens = new Map<string, OAuthTokenRecord>(); // accessToken -> record
  oauthTokensByRefresh = new Map<string, string>(); // refreshToken -> accessToken

  constructor() {
    this.seedDefaultCatalog();
  }

  // Reset store for testing
  reset(): void {
    this.users.clear();
    this.usersByEmail.clear();
    this.organizations.clear();
    this.orgsBySlug.clear();
    this.memberships.clear();
    this.userOrgLookup.clear();
    this.devices.clear();
    this.deviceTokenIndex.clear();
    this.telemetry = [];
    this.pairingTokens.clear();
    this.refreshTokens.clear();
    this.auditLogs = [];

    this.subscriptions.clear();
    this.subscriptionInvoices = [];
    this.messagingAccounts.clear();
    this.messagingLedgers = [];
    this.smsMessages.clear();
    this.smsCampaigns.clear();

    this.rawEvidences = [];
    this.normalizedPayments.clear();
    this.paymentsByDeduplication.clear();
    this.invoices.clear();
    this.invoicesByReference.clear();
    this.apiKeys.clear();
    this.apiKeysByHash.clear();
    this.webhookEndpoints.clear();
    this.outboxEvents = [];

    this.oauthClients.clear();
    this.oauthCodes.clear();
    this.oauthTokens.clear();
    this.oauthTokensByRefresh.clear();

    this.seedDefaultCatalog();
  }

  seedDefaultCatalog(): void {
    this.products.clear();
    this.productsByCode.clear();
    this.plans.clear();
    this.plansByCode.clear();
    this.planVersions.clear();
    this.planPrices.clear();
    this.featureDefinitions.clear();
    this.planEntitlements.clear();

    const now = new Date();

    // 1. Seed Products (Product A vs Product B)
    const paymentIntelProd: CommercialProductRecord = {
      id: randomUUID(),
      code: 'PROD_PAYMENT_INTEL',
      name: 'BriskSMS Payment Intelligence & Reconciliation',
      description: 'Automated Tanzanian mobile money & bank reconciliation SaaS platform',
      productType: ProductType.PAYMENT_INTELLIGENCE,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(paymentIntelProd.id, paymentIntelProd);
    this.productsByCode.set(paymentIntelProd.code, paymentIntelProd.id);

    const bulkSmsProd: CommercialProductRecord = {
      id: randomUUID(),
      code: 'PROD_BULK_MESSAGING',
      name: 'BriskSMS Bulk Messaging Engine',
      description: 'Prepaid SMS messaging engine powered by BriskSMS cellular gateway and carrier SIM relay',
      productType: ProductType.BULK_MESSAGING,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(bulkSmsProd.id, bulkSmsProd);
    this.productsByCode.set(bulkSmsProd.code, bulkSmsProd.id);

    // 2. Seed Canonical Feature Definitions
    const features: Array<{ key: string; name: string; type: EntitlementType; defaultValue: string }> = [
      { key: FeatureKey.MAX_CONNECTED_DEVICES, name: 'Maximum Connected Relay Devices', type: EntitlementType.NUMERIC_LIMIT, defaultValue: '1' },
      { key: FeatureKey.MAX_ORGANIZATION_MEMBERS, name: 'Maximum Organization Members', type: EntitlementType.NUMERIC_LIMIT, defaultValue: '5' },
      { key: FeatureKey.MAX_PAYMENT_ACCOUNTS, name: 'Maximum Connected Payment Accounts', type: EntitlementType.NUMERIC_LIMIT, defaultValue: '1' },
      { key: FeatureKey.API_ACCESS, name: 'Developer REST API Access', type: EntitlementType.BOOLEAN_FLAG, defaultValue: 'false' },
      { key: FeatureKey.WEBHOOK_ACCESS, name: 'Outbound HMAC Webhooks', type: EntitlementType.BOOLEAN_FLAG, defaultValue: 'false' },
      { key: FeatureKey.ZAPIER_INTEGRATION, name: 'BriskSMS Zapier Application', type: EntitlementType.BOOLEAN_FLAG, defaultValue: 'false' },
      { key: FeatureKey.MIKROTIK_INTEGRATION, name: 'MikroTik Hotspot Auto-Provisioning', type: EntitlementType.BOOLEAN_FLAG, defaultValue: 'false' },
      { key: FeatureKey.RECONCILIATION_AUTOMATION, name: 'Deterministic Invoice Reconciliation', type: EntitlementType.BOOLEAN_FLAG, defaultValue: 'true' },
      { key: FeatureKey.BULK_MESSAGING_ENABLED, name: 'Bulk Messaging Service Access', type: EntitlementType.BOOLEAN_FLAG, defaultValue: 'false' },
      { key: FeatureKey.HISTORICAL_DATA_MONTHS, name: 'Historical Data Retention (Months)', type: EntitlementType.NUMERIC_LIMIT, defaultValue: '3' },
    ];

    for (const f of features) {
      const featRecord: FeatureDefinitionRecord = {
        id: randomUUID(),
        key: f.key,
        name: f.name,
        description: null,
        type: f.type,
        defaultValue: f.defaultValue,
        createdAt: now,
      };
      this.featureDefinitions.set(featRecord.key, featRecord);
    }

    // 3. Helper to register a complete plan with version, prices, and entitlements
    const registerPlanWithVersion = (
      planCode: string,
      planName: string,
      description: string,
      prices: Array<{ currency: string; amountCents: bigint; billingInterval: BillingInterval }>,
      entitlementValues: Record<string, string>,
    ) => {
      const planId = randomUUID();
      const plan: SubscriptionPlanRecord = {
        id: planId,
        productId: paymentIntelProd.id,
        code: planCode,
        name: planName,
        description,
        isPublic: true,
        createdAt: now,
        updatedAt: now,
      };
      this.plans.set(plan.id, plan);
      this.plansByCode.set(plan.code, plan.id);

      const versionId = randomUUID();
      const version: PlanVersionRecord = {
        id: versionId,
        planId: plan.id,
        versionNumber: 1,
        effectiveFrom: now,
        effectiveTo: null,
        isActive: true,
        trialPeriodDays: 14,
        gracePeriodDays: 3,
        createdAt: now,
      };
      this.planVersions.set(version.id, version);

      for (const p of prices) {
        const priceRecord: PlanPriceRecord = {
          id: randomUUID(),
          planVersionId: version.id,
          currency: p.currency,
          amountCents: p.amountCents,
          billingInterval: p.billingInterval,
          isActive: true,
          createdAt: now,
        };
        this.planPrices.set(priceRecord.id, priceRecord);
      }

      for (const [key, val] of Object.entries(entitlementValues)) {
        const entRecord: PlanEntitlementRecord = {
          id: randomUUID(),
          planVersionId: version.id,
          featureKey: key,
          value: val,
          createdAt: now,
        };
        this.planEntitlements.set(`${version.id}:${key}`, entRecord);
      }
    };

    // Starter Plan
    registerPlanWithVersion(
      'PLAN_STARTER',
      'Starter Business',
      'Ideal for single-store retail or individual service business',
      [
        { currency: 'TZS', amountCents: 2500000n, billingInterval: BillingInterval.MONTHLY },
        { currency: 'USD', amountCents: 1000n, billingInterval: BillingInterval.MONTHLY },
        { currency: 'TZS', amountCents: 25000000n, billingInterval: BillingInterval.ANNUALLY },
        { currency: 'USD', amountCents: 10000n, billingInterval: BillingInterval.ANNUALLY },
      ],
      {
        [FeatureKey.MAX_CONNECTED_DEVICES]: '1',
        [FeatureKey.MAX_ORGANIZATION_MEMBERS]: '2',
        [FeatureKey.MAX_PAYMENT_ACCOUNTS]: '1',
        [FeatureKey.API_ACCESS]: 'false',
        [FeatureKey.WEBHOOK_ACCESS]: 'false',
        [FeatureKey.ZAPIER_INTEGRATION]: 'false',
        [FeatureKey.MIKROTIK_INTEGRATION]: 'false',
        [FeatureKey.RECONCILIATION_AUTOMATION]: 'true',
        [FeatureKey.BULK_MESSAGING_ENABLED]: 'false',
        [FeatureKey.HISTORICAL_DATA_MONTHS]: '3',
      },
    );

    // Growth Plan
    registerPlanWithVersion(
      'PLAN_GROWTH',
      'Growth & Multi-Device',
      'For growing multi-till businesses, ISPs, and automated billing operations',
      [
        { currency: 'TZS', amountCents: 6500000n, billingInterval: BillingInterval.MONTHLY },
        { currency: 'USD', amountCents: 2500n, billingInterval: BillingInterval.MONTHLY },
        { currency: 'TZS', amountCents: 65000000n, billingInterval: BillingInterval.ANNUALLY },
        { currency: 'USD', amountCents: 25000n, billingInterval: BillingInterval.ANNUALLY },
      ],
      {
        [FeatureKey.MAX_CONNECTED_DEVICES]: '3',
        [FeatureKey.MAX_ORGANIZATION_MEMBERS]: '5',
        [FeatureKey.MAX_PAYMENT_ACCOUNTS]: '3',
        [FeatureKey.API_ACCESS]: 'true',
        [FeatureKey.WEBHOOK_ACCESS]: 'true',
        [FeatureKey.ZAPIER_INTEGRATION]: 'true',
        [FeatureKey.MIKROTIK_INTEGRATION]: 'true',
        [FeatureKey.RECONCILIATION_AUTOMATION]: 'true',
        [FeatureKey.BULK_MESSAGING_ENABLED]: 'false',
        [FeatureKey.HISTORICAL_DATA_MONTHS]: '12',
      },
    );

    // Enterprise Plan
    registerPlanWithVersion(
      'PLAN_ENTERPRISE',
      'Enterprise Operations',
      'Unlimited high-throughput reconciliation, dedicated webhooks, and prioritized processing',
      [
        { currency: 'TZS', amountCents: 18000000n, billingInterval: BillingInterval.MONTHLY },
        { currency: 'USD', amountCents: 7500n, billingInterval: BillingInterval.MONTHLY },
        { currency: 'TZS', amountCents: 180000000n, billingInterval: BillingInterval.ANNUALLY },
        { currency: 'USD', amountCents: 75000n, billingInterval: BillingInterval.ANNUALLY },
      ],
      {
        [FeatureKey.MAX_CONNECTED_DEVICES]: '10',
        [FeatureKey.MAX_ORGANIZATION_MEMBERS]: '25',
        [FeatureKey.MAX_PAYMENT_ACCOUNTS]: '10',
        [FeatureKey.API_ACCESS]: 'true',
        [FeatureKey.WEBHOOK_ACCESS]: 'true',
        [FeatureKey.ZAPIER_INTEGRATION]: 'true',
        [FeatureKey.MIKROTIK_INTEGRATION]: 'true',
        [FeatureKey.RECONCILIATION_AUTOMATION]: 'true',
        [FeatureKey.BULK_MESSAGING_ENABLED]: 'true',
        [FeatureKey.HISTORICAL_DATA_MONTHS]: '36',
      },
    );
  }

  // --- Users ---
  createUser(data: { email: string; passwordHash: string; fullName: string; phoneNumber?: string }): UserRecord {
    const emailNorm = data.email.trim().toLowerCase();
    if (this.usersByEmail.has(emailNorm)) {
      throw new Error('User with this email already exists');
    }
    const id = randomUUID();
    const now = new Date();
    const record: UserRecord = {
      id,
      email: emailNorm,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      phoneNumber: data.phoneNumber,
      isEmailVerified: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(id, record);
    this.usersByEmail.set(emailNorm, id);
    return record;
  }

  findUserByEmail(email: string): UserRecord | null {
    const id = this.usersByEmail.get(email.trim().toLowerCase());
    return id ? this.users.get(id) ?? null : null;
  }

  findUserById(id: string): UserRecord | null {
    return this.users.get(id) ?? null;
  }

  // --- Organizations ---
  createOrganization(data: { name: string; slug: string; creatorUserId: string; countryCode?: string }): {
    org: OrganizationRecord;
    membership: UserOrganizationRecord;
  } {
    const slugNorm = data.slug.trim().toLowerCase();
    if (this.orgsBySlug.has(slugNorm)) {
      throw new Error(`Organization slug '${slugNorm}' is already in use`);
    }

    const orgId = randomUUID();
    const now = new Date();
    const org: OrganizationRecord = {
      id: orgId,
      name: data.name,
      slug: slugNorm,
      countryCode: data.countryCode || 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'STARTER',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.set(orgId, org);
    this.orgsBySlug.set(slugNorm, orgId);

    // Add creator as OWNER
    const membershipId = randomUUID();
    const membership: UserOrganizationRecord = {
      id: membershipId,
      organizationId: orgId,
      userId: data.creatorUserId,
      role: UserRole.OWNER,
      createdAt: now,
      updatedAt: now,
    };
    this.memberships.set(membershipId, membership);
    this.userOrgLookup.set(`${orgId}:${data.creatorUserId}`, membershipId);

    this.recordAudit({
      organizationId: orgId,
      actorId: data.creatorUserId,
      actorType: 'USER',
      action: 'ORGANIZATION_CREATED',
      resourceType: 'ORGANIZATION',
      resourceId: orgId,
    });

    return { org, membership };
  }

  findOrgById(orgId: string): OrganizationRecord | null {
    return this.organizations.get(orgId) ?? null;
  }

  getUserOrganizations(userId: string): { org: OrganizationRecord; role: UserRole }[] {
    const results: { org: OrganizationRecord; role: UserRole }[] = [];
    for (const mem of this.memberships.values()) {
      if (mem.userId === userId) {
        const org = this.organizations.get(mem.organizationId);
        if (org && org.isActive) {
          results.push({ org, role: mem.role });
        }
      }
    }
    return results;
  }

  getMembership(organizationId: string, userId: string): UserOrganizationRecord | null {
    const key = `${organizationId}:${userId}`;
    const id = this.userOrgLookup.get(key);
    return id ? this.memberships.get(id) ?? null : null;
  }

  addMember(data: { organizationId: string; userId: string; role: UserRole; actorId: string }): UserOrganizationRecord {
    assertTenantContext({ organizationId: data.organizationId });
    const key = `${data.organizationId}:${data.userId}`;
    if (this.userOrgLookup.has(key)) {
      throw new Error('User is already a member of this organization');
    }

    const id = randomUUID();
    const now = new Date();
    const record: UserOrganizationRecord = {
      id,
      organizationId: data.organizationId,
      userId: data.userId,
      role: data.role,
      createdAt: now,
      updatedAt: now,
    };
    this.memberships.set(id, record);
    this.userOrgLookup.set(key, id);

    this.recordAudit({
      organizationId: data.organizationId,
      actorId: data.actorId,
      actorType: 'USER',
      action: 'MEMBER_INVITED',
      resourceType: 'USER_ORGANIZATION',
      resourceId: id,
      metadata: { userId: data.userId, role: data.role },
    });

    return record;
  }

  updateMemberRole(data: { organizationId: string; userId: string; newRole: UserRole; actorId: string }): UserOrganizationRecord {
    assertTenantContext({ organizationId: data.organizationId });
    const mem = this.getMembership(data.organizationId, data.userId);
    if (!mem) {
      throw new Error('Member not found in organization');
    }

    mem.role = data.newRole;
    mem.updatedAt = new Date();

    this.recordAudit({
      organizationId: data.organizationId,
      actorId: data.actorId,
      actorType: 'USER',
      action: 'MEMBER_ROLE_UPDATED',
      resourceType: 'USER_ORGANIZATION',
      resourceId: mem.id,
      metadata: { userId: data.userId, newRole: data.newRole },
    });

    return mem;
  }

  removeMember(organizationId: string, userId: string, actorId: string): void {
    assertTenantContext({ organizationId });
    const key = `${organizationId}:${userId}`;
    const id = this.userOrgLookup.get(key);
    if (!id) {
      throw new Error('Member not found in organization');
    }
    this.memberships.delete(id);
    this.userOrgLookup.delete(key);

    this.recordAudit({
      organizationId,
      actorId,
      actorType: 'USER',
      action: 'MEMBER_REMOVED',
      resourceType: 'USER_ORGANIZATION',
      resourceId: id,
      metadata: { userId },
    });
  }

  getOrgMembers(organizationId: string): { user: UserRecord; role: UserRole }[] {
    assertTenantContext({ organizationId });
    const members: { user: UserRecord; role: UserRole }[] = [];
    for (const mem of this.memberships.values()) {
      if (mem.organizationId === organizationId) {
        const user = this.users.get(mem.userId);
        if (user) {
          members.push({ user, role: mem.role });
        }
      }
    }
    return members;
  }

  // --- Devices ---
  createPairingToken(data: { organizationId: string; createdById: string; token: string; ttlSeconds?: number }): PairingTokenRecord {
    assertTenantContext({ organizationId: data.organizationId });
    const expiresAt = new Date(Date.now() + (data.ttlSeconds || 300) * 1000);
    const record: PairingTokenRecord = {
      token: data.token,
      organizationId: data.organizationId,
      createdById: data.createdById,
      expiresAt,
    };
    this.pairingTokens.set(data.token, record);
    return record;
  }

  getPairingToken(token: string): PairingTokenRecord | null {
    const record = this.pairingTokens.get(token);
    if (!record) return null;
    if (record.usedAt || record.expiresAt < new Date()) {
      return null; // Expired or used
    }
    return record;
  }

  registerDevice(data: {
    organizationId: string;
    label: string;
    deviceModel: string;
    manufacturer: string;
    androidVersion: string;
    appVersion: string;
    publicKeyPem: string;
    ingestionMode: DeviceIngestionMode;
    tokenHash: string;
  }): DeviceRecord {
    assertTenantContext({ organizationId: data.organizationId });
    const id = randomUUID();
    const now = new Date();
    const device: DeviceRecord = {
      id,
      organizationId: data.organizationId,
      label: data.label,
      deviceModel: data.deviceModel,
      manufacturer: data.manufacturer,
      androidVersion: data.androidVersion,
      appVersion: data.appVersion,
      publicKeyPem: data.publicKeyPem,
      status: DeviceStatus.ACTIVE,
      ingestionMode: data.ingestionMode,
      deviceTokenHash: data.tokenHash,
      lastSyncAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.devices.set(id, device);
    this.deviceTokenIndex.set(data.tokenHash, id);

    this.recordAudit({
      organizationId: data.organizationId,
      actorId: id,
      actorType: 'DEVICE',
      action: 'DEVICE_REGISTERED',
      resourceType: 'DEVICE',
      resourceId: id,
      metadata: { model: data.deviceModel, mode: data.ingestionMode },
    });

    return device;
  }

  getOrgDevices(organizationId: string): DeviceRecord[] {
    assertTenantContext({ organizationId });
    const devices: DeviceRecord[] = [];
    for (const dev of this.devices.values()) {
      if (dev.organizationId === organizationId) {
        devices.push(dev);
      }
    }
    return devices;
  }

  getDeviceById(deviceId: string, organizationId?: string): DeviceRecord | null {
    const dev = this.devices.get(deviceId);
    if (!dev) return null;
    if (organizationId && dev.organizationId !== organizationId) {
      return null; // Multi-tenant isolation enforcement
    }
    return dev;
  }

  getDeviceByTokenHash(tokenHash: string): DeviceRecord | null {
    const id = this.deviceTokenIndex.get(tokenHash);
    return id ? this.devices.get(id) ?? null : null;
  }

  recordTelemetry(data: {
    deviceId: string;
    batteryPct: number;
    isCharging: boolean;
    networkType: string;
    signalStrengthDbm: number | null;
    pendingOfflineCount: number;
  }): DeviceTelemetryRecord {
    const dev = this.devices.get(data.deviceId);
    if (!dev || dev.status === DeviceStatus.REVOKED) {
      throw new Error('Device is not active or has been revoked');
    }

    const id = randomUUID();
    const now = new Date();
    const record: DeviceTelemetryRecord = {
      id,
      deviceId: data.deviceId,
      batteryPct: data.batteryPct,
      isCharging: data.isCharging,
      networkType: data.networkType,
      signalStrengthDbm: data.signalStrengthDbm,
      pendingOfflineCount: data.pendingOfflineCount,
      recordedAt: now,
    };
    this.telemetry.push(record);

    dev.lastSyncAt = now;
    dev.updatedAt = now;

    return record;
  }

  getDeviceTelemetry(deviceId: string, limit: number = 20): DeviceTelemetryRecord[] {
    return this.telemetry
      .filter((t) => t.deviceId === deviceId)
      .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
      .slice(0, limit);
  }

  revokeDevice(deviceId: string, organizationId: string, actorId: string): DeviceRecord {
    assertTenantContext({ organizationId });
    const dev = this.getDeviceById(deviceId, organizationId);
    if (!dev) {
      throw new Error('Device not found in organization');
    }

    dev.status = DeviceStatus.REVOKED;
    dev.revokedAt = new Date();
    dev.updatedAt = new Date();

    // Invalidate token
    this.deviceTokenIndex.delete(dev.deviceTokenHash);

    this.recordAudit({
      organizationId,
      actorId,
      actorType: 'USER',
      action: 'DEVICE_REVOKED',
      resourceType: 'DEVICE',
      resourceId: deviceId,
    });

    return dev;
  }

  // --- Dynamic Subscription & Commercial Catalog Methods ---

  getPublicCatalog(): Array<{
    product: CommercialProductRecord;
    plans: Array<{
      plan: SubscriptionPlanRecord;
      currentVersion: PlanVersionRecord;
      prices: PlanPriceRecord[];
      entitlements: PlanEntitlementRecord[];
    }>;
  }> {
    const catalog: Array<{
      product: CommercialProductRecord;
      plans: Array<{
        plan: SubscriptionPlanRecord;
        currentVersion: PlanVersionRecord;
        prices: PlanPriceRecord[];
        entitlements: PlanEntitlementRecord[];
      }>;
    }> = [];

    for (const prod of this.products.values()) {
      if (!prod.isActive) continue;
      const prodPlans: Array<{
        plan: SubscriptionPlanRecord;
        currentVersion: PlanVersionRecord;
        prices: PlanPriceRecord[];
        entitlements: PlanEntitlementRecord[];
      }> = [];

      for (const plan of this.plans.values()) {
        if (plan.productId !== prod.id || !plan.isPublic) continue;
        const currentVersion = this.getActivePlanVersion(plan.id);
        if (!currentVersion) continue;

        const prices = this.getPlanPrices(currentVersion.id);
        const entitlements = this.getPlanEntitlements(currentVersion.id);

        prodPlans.push({
          plan,
          currentVersion,
          prices,
          entitlements,
        });
      }

      catalog.push({
        product: prod,
        plans: prodPlans,
      });
    }

    return catalog;
  }

  getPlanByCode(code: string): SubscriptionPlanRecord | null {
    const id = this.plansByCode.get(code);
    return id ? (this.plans.get(id) ?? null) : null;
  }

  getPlanById(id: string): SubscriptionPlanRecord | null {
    return this.plans.get(id) ?? null;
  }

  getActivePlanVersion(planId: string): PlanVersionRecord | null {
    for (const v of this.planVersions.values()) {
      if (v.planId === planId && v.isActive && v.effectiveTo === null) {
        return v;
      }
    }
    return null;
  }

  getPlanVersionById(versionId: string): PlanVersionRecord | null {
    return this.planVersions.get(versionId) ?? null;
  }

  getPlanPrices(versionId: string): PlanPriceRecord[] {
    const prices: PlanPriceRecord[] = [];
    for (const p of this.planPrices.values()) {
      if (p.planVersionId === versionId && p.isActive) {
        prices.push(p);
      }
    }
    return prices;
  }

  getPlanEntitlements(versionId: string): PlanEntitlementRecord[] {
    const ents: PlanEntitlementRecord[] = [];
    for (const e of this.planEntitlements.values()) {
      if (e.planVersionId === versionId) {
        ents.push(e);
      }
    }
    return ents;
  }

  getOrganizationSubscription(organizationId: string): OrganizationSubscriptionRecord | null {
    assertTenantContext({ organizationId });
    return this.subscriptions.get(organizationId) ?? null;
  }

  saveSubscription(sub: OrganizationSubscriptionRecord): OrganizationSubscriptionRecord {
    assertTenantContext({ organizationId: sub.organizationId });
    this.subscriptions.set(sub.organizationId, sub);
    return sub;
  }

  createSubscriptionInvoice(invoice: SubscriptionBillingInvoiceRecord): SubscriptionBillingInvoiceRecord {
    assertTenantContext({ organizationId: invoice.organizationId });
    this.subscriptionInvoices.push(invoice);
    return invoice;
  }

  getSubscriptionInvoices(organizationId: string): SubscriptionBillingInvoiceRecord[] {
    assertTenantContext({ organizationId });
    return this.subscriptionInvoices
      .filter((inv) => inv.organizationId === organizationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // --- Administrative Catalog Management (Privileged) ---
  adminCreatePlan(data: {
    productCode: string;
    code: string;
    name: string;
    description?: string;
    isPublic?: boolean;
    trialPeriodDays?: number;
    gracePeriodDays?: number;
    prices: Array<{ currency: string; amountCents: bigint; billingInterval: BillingInterval }>;
    entitlements: Record<string, string>;
  }): { plan: SubscriptionPlanRecord; version: PlanVersionRecord } {
    const prodId = this.productsByCode.get(data.productCode);
    if (!prodId) {
      throw new Error(`Product '${data.productCode}' not found`);
    }

    if (this.plansByCode.has(data.code)) {
      throw new Error(`Plan code '${data.code}' already exists`);
    }

    const now = new Date();
    const planId = randomUUID();
    const plan: SubscriptionPlanRecord = {
      id: planId,
      productId: prodId,
      code: data.code,
      name: data.name,
      description: data.description ?? null,
      isPublic: data.isPublic ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(plan.id, plan);
    this.plansByCode.set(plan.code, plan.id);

    const versionId = randomUUID();
    const version: PlanVersionRecord = {
      id: versionId,
      planId: plan.id,
      versionNumber: 1,
      effectiveFrom: now,
      effectiveTo: null,
      isActive: true,
      trialPeriodDays: data.trialPeriodDays ?? 0,
      gracePeriodDays: data.gracePeriodDays ?? 3,
      createdAt: now,
    };
    this.planVersions.set(version.id, version);

    for (const p of data.prices) {
      const priceRecord: PlanPriceRecord = {
        id: randomUUID(),
        planVersionId: version.id,
        currency: p.currency,
        amountCents: p.amountCents,
        billingInterval: p.billingInterval,
        isActive: true,
        createdAt: now,
      };
      this.planPrices.set(priceRecord.id, priceRecord);
    }

    for (const [key, val] of Object.entries(data.entitlements)) {
      const entRecord: PlanEntitlementRecord = {
        id: randomUUID(),
        planVersionId: version.id,
        featureKey: key,
        value: val,
        createdAt: now,
      };
      this.planEntitlements.set(`${version.id}:${key}`, entRecord);
    }

    return { plan, version };
  }

  adminCreateNewPlanVersion(data: {
    planCode: string;
    prices: Array<{ currency: string; amountCents: bigint; billingInterval: BillingInterval }>;
    entitlements: Record<string, string>;
    trialPeriodDays?: number;
    gracePeriodDays?: number;
  }): PlanVersionRecord {
    const plan = this.getPlanByCode(data.planCode);
    if (!plan) {
      throw new Error(`Plan '${data.planCode}' not found`);
    }

    const now = new Date();
    // Mark prior active version as superseded
    const oldVersion = this.getActivePlanVersion(plan.id);
    let nextVersionNumber = 1;
    if (oldVersion) {
      oldVersion.effectiveTo = now;
      nextVersionNumber = oldVersion.versionNumber + 1;
    }

    const newVersionId = randomUUID();
    const newVersion: PlanVersionRecord = {
      id: newVersionId,
      planId: plan.id,
      versionNumber: nextVersionNumber,
      effectiveFrom: now,
      effectiveTo: null,
      isActive: true,
      trialPeriodDays: data.trialPeriodDays ?? (oldVersion?.trialPeriodDays ?? 0),
      gracePeriodDays: data.gracePeriodDays ?? (oldVersion?.gracePeriodDays ?? 3),
      createdAt: now,
    };
    this.planVersions.set(newVersion.id, newVersion);

    for (const p of data.prices) {
      const priceRecord: PlanPriceRecord = {
        id: randomUUID(),
        planVersionId: newVersion.id,
        currency: p.currency,
        amountCents: p.amountCents,
        billingInterval: p.billingInterval,
        isActive: true,
        createdAt: now,
      };
      this.planPrices.set(priceRecord.id, priceRecord);
    }

    for (const [key, val] of Object.entries(data.entitlements)) {
      const entRecord: PlanEntitlementRecord = {
        id: randomUUID(),
        planVersionId: newVersion.id,
        featureKey: key,
        value: val,
        createdAt: now,
      };
      this.planEntitlements.set(`${newVersion.id}:${key}`, entRecord);
    }

    return newVersion;
  }

  // --- Audit Logs (Immutable) ---
  recordAudit(data: {
    organizationId: string;
    actorId: string;
    actorType: 'USER' | 'DEVICE' | 'SYSTEM' | 'API_KEY';
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): AuditLogRecord {
    const id = randomUUID();
    const record: AuditLogRecord = {
      id,
      organizationId: data.organizationId,
      actorId: data.actorId,
      actorType: data.actorType,
      action: data.action,
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      metadata: data.metadata,
      createdAt: new Date(),
    };
    this.auditLogs.push(record);
    return record;
  }
}

export const dbStore = new MemoryStore();
