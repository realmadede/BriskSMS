import { randomUUID } from 'node:crypto';
import {
  BillingInterval,
  EntitlementType,
  FeatureKey,
  ProductType,
} from '@brisksms/shared';
import { SqlExecutor, sql, withTransaction } from './client.js';

export interface SeedCatalogSummary {
  featuresSeeded: number;
  productsSeeded: number;
  plansSeeded: number;
}

/**
 * Idempotently seeds the dynamic BriskSMS Commercial Catalog & Feature Definitions into PostgreSQL.
 * Safe to run multiple times on existing development or production databases.
 */
export async function seedCommercialCatalog(customExecutor?: SqlExecutor): Promise<SeedCatalogSummary> {
  return withTransaction(async (tx) => {
    const features: Array<{
      key: string;
      name: string;
      description: string | null;
      type: EntitlementType;
      defaultValue: string;
    }> = [
      {
        key: FeatureKey.MAX_CONNECTED_DEVICES,
        name: 'Maximum Connected Relay Devices',
        description: 'Number of concurrent Android payment relay devices allowed per organization',
        type: EntitlementType.NUMERIC_LIMIT,
        defaultValue: '1',
      },
      {
        key: FeatureKey.MAX_ORGANIZATION_MEMBERS,
        name: 'Maximum Organization Members',
        description: 'Maximum staff accounts per organization',
        type: EntitlementType.NUMERIC_LIMIT,
        defaultValue: '5',
      },
      {
        key: FeatureKey.MAX_PAYMENT_ACCOUNTS,
        name: 'Maximum Connected Payment Accounts',
        description: 'Maximum payment provider accounts monitored per organization',
        type: EntitlementType.NUMERIC_LIMIT,
        defaultValue: '1',
      },
      {
        key: FeatureKey.API_ACCESS,
        name: 'Developer REST API Access',
        description: 'Access to programmatic REST API and scoped API keys',
        type: EntitlementType.BOOLEAN_FLAG,
        defaultValue: 'false',
      },
      {
        key: FeatureKey.WEBHOOK_ACCESS,
        name: 'Outbound HMAC Webhooks',
        description: 'Ability to register outbound HMAC-signed webhook endpoints',
        type: EntitlementType.BOOLEAN_FLAG,
        defaultValue: 'false',
      },
      {
        key: FeatureKey.ZAPIER_INTEGRATION,
        name: 'BriskSMS Zapier Application',
        description: 'Connect payment and messaging workflows to Zapier, Make, and Google Sheets',
        type: EntitlementType.BOOLEAN_FLAG,
        defaultValue: 'false',
      },
      {
        key: FeatureKey.MIKROTIK_INTEGRATION,
        name: 'MikroTik Hotspot Auto-Provisioning',
        description: 'Automated subscriber provisioning upon verified payment',
        type: EntitlementType.BOOLEAN_FLAG,
        defaultValue: 'false',
      },
      {
        key: FeatureKey.RECONCILIATION_AUTOMATION,
        name: 'Deterministic Invoice Reconciliation',
        description: 'Automated multi-tier payment-to-invoice reconciliation',
        type: EntitlementType.BOOLEAN_FLAG,
        defaultValue: 'true',
      },
      {
        key: FeatureKey.BULK_MESSAGING_ENABLED,
        name: 'Bulk Messaging Service Access',
        description: 'Access to cellular SMS gateway and campaign engine',
        type: EntitlementType.BOOLEAN_FLAG,
        defaultValue: 'false',
      },
      {
        key: FeatureKey.HISTORICAL_DATA_MONTHS,
        name: 'Historical Data Retention (Months)',
        description: 'Number of months of historical payment and audit records retained online',
        type: EntitlementType.NUMERIC_LIMIT,
        defaultValue: '3',
      },
    ];

    for (const feat of features) {
      await tx`
        INSERT INTO "feature_definitions" ("id", "key", "name", "description", "type", "default_value")
        VALUES (${randomUUID()}, ${feat.key}, ${feat.name}, ${feat.description}, ${feat.type}::"EntitlementType", ${feat.defaultValue})
        ON CONFLICT ("key") DO UPDATE SET "default_value" = EXCLUDED."default_value"
      `;
    }

    // Seed Commercial Products
    const products = [
      {
        code: 'PROD_PAYMENT_INTEL',
        name: 'BriskSMS Payment Intelligence & Reconciliation',
        description: 'Automated Tanzanian mobile money & bank reconciliation SaaS platform',
        productType: ProductType.PAYMENT_INTELLIGENCE,
      },
      {
        code: 'PROD_BULK_MESSAGING',
        name: 'BriskSMS Bulk Messaging Engine',
        description: 'Prepaid SMS messaging engine powered by BriskSMS cellular gateway and carrier SIM relay',
        productType: ProductType.BULK_MESSAGING,
      },
    ];

    const productIdsByCode = new Map<string, string>();
    for (const prod of products) {
      const rows = await tx<{ id: string }>`
        INSERT INTO "commercial_products" ("id", "code", "name", "description", "product_type", "is_active")
        VALUES (${randomUUID()}, ${prod.code}, ${prod.name}, ${prod.description}, ${prod.productType}::"ProductType", true)
        ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name"
        RETURNING "id"
      `;
      productIdsByCode.set(prod.code, rows[0]!.id);
    }

    const paymentProdId = productIdsByCode.get('PROD_PAYMENT_INTEL')!;

    // Seed Default Plans under Payment Intelligence
    const plans: Array<{
      code: string;
      name: string;
      description: string;
      trialPeriodDays: number;
      gracePeriodDays: number;
      prices: Array<{ currency: string; amountCents: bigint; billingInterval: BillingInterval }>;
      entitlements: Record<string, string>;
    }> = [
      {
        code: 'PLAN_STARTER',
        name: 'Starter Business',
        description: 'Ideal for single-store retail or individual service business',
        trialPeriodDays: 14,
        gracePeriodDays: 3,
        prices: [
          { currency: 'TZS', amountCents: 2500000n, billingInterval: BillingInterval.MONTHLY },
          { currency: 'USD', amountCents: 1000n, billingInterval: BillingInterval.MONTHLY },
          { currency: 'TZS', amountCents: 25000000n, billingInterval: BillingInterval.ANNUALLY },
          { currency: 'USD', amountCents: 10000n, billingInterval: BillingInterval.ANNUALLY },
        ],
        entitlements: {
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
      },
      {
        code: 'PLAN_GROWTH',
        name: 'Growth & Multi-Device',
        description: 'For growing multi-till businesses, ISPs, and automated billing operations',
        trialPeriodDays: 14,
        gracePeriodDays: 3,
        prices: [
          { currency: 'TZS', amountCents: 6500000n, billingInterval: BillingInterval.MONTHLY },
          { currency: 'USD', amountCents: 2500n, billingInterval: BillingInterval.MONTHLY },
          { currency: 'TZS', amountCents: 65000000n, billingInterval: BillingInterval.ANNUALLY },
          { currency: 'USD', amountCents: 25000n, billingInterval: BillingInterval.ANNUALLY },
        ],
        entitlements: {
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
      },
      {
        code: 'PLAN_ENTERPRISE',
        name: 'Enterprise Operations',
        description: 'Unlimited high-throughput reconciliation, dedicated webhooks, and prioritized processing',
        trialPeriodDays: 14,
        gracePeriodDays: 3,
        prices: [
          { currency: 'TZS', amountCents: 18000000n, billingInterval: BillingInterval.MONTHLY },
          { currency: 'USD', amountCents: 7500n, billingInterval: BillingInterval.MONTHLY },
          { currency: 'TZS', amountCents: 180000000n, billingInterval: BillingInterval.ANNUALLY },
          { currency: 'USD', amountCents: 75000n, billingInterval: BillingInterval.ANNUALLY },
        ],
        entitlements: {
          [FeatureKey.MAX_CONNECTED_DEVICES]: '10',
          [FeatureKey.MAX_ORGANIZATION_MEMBERS]: '25',
          [FeatureKey.MAX_PAYMENT_ACCOUNTS]: '10',
          [FeatureKey.API_ACCESS]: 'true',
          [FeatureKey.WEBHOOK_ACCESS]: 'true',
          [FeatureKey.ZAPIER_INTEGRATION]: 'true',
          [FeatureKey.MIKROTIK_INTEGRATION]: 'true',
          [FeatureKey.RECONCILIATION_AUTOMATION]: 'true',
          [FeatureKey.BULK_MESSAGING_ENABLED]: 'true',
          [FeatureKey.HISTORICAL_DATA_MONTHS]: '60',
        },
      },
    ];

    for (const planDef of plans) {
      const existingPlans = await tx<{ id: string }>`
        SELECT "id" FROM "subscription_plans" WHERE "code" = ${planDef.code}
      `;
      let planId: string;
      if (existingPlans.length === 0) {
        const inserted = await tx<{ id: string }>`
          INSERT INTO "subscription_plans" ("id", "product_id", "code", "name", "description", "is_public")
          VALUES (${randomUUID()}, ${paymentProdId}, ${planDef.code}, ${planDef.name}, ${planDef.description}, true)
          RETURNING "id"
        `;
        planId = inserted[0]!.id;
      } else {
        planId = existingPlans[0]!.id;
      }

      const existingVersions = await tx<{ id: string }>`
        SELECT "id" FROM "plan_versions" WHERE "plan_id" = ${planId}
      `;
      if (existingVersions.length === 0) {
        const versionRows = await tx<{ id: string }>`
          INSERT INTO "plan_versions" ("id", "plan_id", "version_number", "is_active", "trial_period_days", "grace_period_days")
          VALUES (${randomUUID()}, ${planId}, 1, true, ${planDef.trialPeriodDays}, ${planDef.gracePeriodDays})
          RETURNING "id"
        `;
        const versionId = versionRows[0]!.id;

        for (const price of planDef.prices) {
          await tx`
            INSERT INTO "plan_prices" ("id", "plan_version_id", "currency", "amount_cents", "billing_interval", "is_active")
            VALUES (${randomUUID()}, ${versionId}, ${price.currency}, ${price.amountCents.toString()}::bigint, ${price.billingInterval}::"BillingInterval", true)
            ON CONFLICT ("plan_version_id", "currency", "billing_interval") DO NOTHING
          `;
        }

        for (const [featureKey, val] of Object.entries(planDef.entitlements)) {
          await tx`
            INSERT INTO "plan_entitlements" ("id", "plan_version_id", "feature_key", "value")
            VALUES (${randomUUID()}, ${versionId}, ${featureKey}, ${val})
            ON CONFLICT ("plan_version_id", "feature_key") DO NOTHING
          `;
        }
      }
    }

    return {
      featuresSeeded: features.length,
      productsSeeded: products.length,
      plansSeeded: plans.length,
    };
  }, customExecutor ?? sql);
}
