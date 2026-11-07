import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  sql,
  withTransaction,
  migrateDeploy,
  getAppliedMigrations,
  DatabaseUnavailableError,
  setSimulatedDatabaseOutage,
} from '@brisksms/db';
import {
  EvidenceSourceType,
  VerificationMethod,
  BillingInterval,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { MessagingService } from '../src/modules/messaging/messaging.service.js';
import { SubscriptionService } from '../src/modules/subscription/subscription.service.js';

describe('Milestone 1: Authoritative PostgreSQL Persistence, Constraints & Immutability', () => {
  beforeEach(async () => {
    setSimulatedDatabaseOutage(false);
    await dbStore.reset();
  });

  it('tracks version-controlled migrations in _prisma_migrations and executes idempotently', async () => {
    const result = await migrateDeploy();
    assert.equal(result.skipped.length >= 1, true);

    const applied = await getAppliedMigrations();
    assert.equal(applied.length >= 1, true);
    assert.equal(applied[0]?.migration_name, '20261107000000_init_foundation');
    assert.ok(applied[0]?.checksum);
    assert.ok(applied[0]?.finished_at);
  });

  it('persists domain state across fresh service instances without in-memory caching', async () => {
    const authServiceA = new AuthService();
    const reg = await authServiceA.register({
      email: 'persistence-check@brisksms.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Persistence Tester',
      organizationName: 'Persistence Corp',
    });

    // Instantiate a brand-new AuthService instance and verify data is read from PostgreSQL
    const authServiceB = new AuthService();
    const profile = await authServiceB.getMe(reg.user.id);
    assert.equal(profile.user.email, 'persistence-check@brisksms.co.tz');
    assert.equal(profile.organizations.length, 1);
    assert.equal(profile.organizations[0]?.id, reg.organizationId);
  });

  it('enforces database-level CHECK constraints against negative monetary amounts and balances', async () => {
    const orgId = randomUUID();
    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Constraint Org',
      slug: `constraint-org-${orgId.slice(0, 8)}`,
    });

    // 1. Negative invoice total_amount_cents must be rejected by PostgreSQL CHECK constraint
    await assert.rejects(
      async () => {
        await sql`
          INSERT INTO invoices (
            id, organization_id, reference_number, total_amount_cents, paid_amount_cents, balance_cents, currency, status
          ) VALUES (
            ${randomUUID()}, ${orgId}, 'NEG-INV-1', -5000, 0, -5000, 'TZS', 'UNPAID'
          )
        `;
      },
      /invoices_amounts_non_negative_check/,
    );

    // 2. Negative messaging credit balance must be rejected by PostgreSQL CHECK constraint
    await assert.rejects(
      async () => {
        await sql`
          INSERT INTO messaging_accounts (
            id, organization_id, credit_balance, reserved_credits
          ) VALUES (
            ${randomUUID()}, ${orgId}, -10, 0
          )
        `;
      },
      /messaging_accounts_non_negative_credits_check/,
    );

    // 3. Invalid battery percentage (> 100) must be rejected by PostgreSQL CHECK constraint
    const dev = await dbStore.registerDevice({
      organizationId: orgId,
      label: 'Test Phone',
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0',
      publicKeyPem: 'pem',
      ingestionMode: 'NOTIFICATION_LISTENER' as any,
      tokenHash: `hash_${randomUUID()}`,
    });

    await assert.rejects(
      async () => {
        await sql`
          INSERT INTO device_telemetry (id, device_id, battery_pct, is_charging, network_type)
          VALUES (${randomUUID()}, ${dev.id}, 150, false, 'WIFI')
        `;
      },
      /device_telemetry_battery_check/,
    );
  });

  it('enforces foreign key ON DELETE RESTRICT on organizations with financial records', async () => {
    const orgId = randomUUID();
    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Protected Financial Org',
      slug: `protected-org-${orgId.slice(0, 8)}`,
    });

    const recon = new ReconciliationService();
    await recon.createInvoice(orgId, {
      referenceNumber: 'INV-PROTECT-01',
      totalAmountCents: 1000000n,
    });

    // Attempting to delete an organization that owns invoices must fail due to ON DELETE RESTRICT
    await assert.rejects(
      async () => {
        await sql`DELETE FROM organizations WHERE id = ${orgId}`;
      },
      /violates (RESTRICT setting of )?foreign key constraint/,
    );
  });

  it('enforces append-only immutability triggers on raw_payment_evidence, messaging_credit_ledger, payment_verifications, audit_logs, and subscription_billing_invoices', async () => {
    const authService = new AuthService();
    const reg = await authService.register({
      email: 'immutable@brisksms.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Immutable Owner',
      organizationName: 'Immutable FinTech',
    });
    const orgId = reg.organizationId!;

    const recon = new ReconciliationService();
    const ingestion = new IngestionService(recon);
    const messaging = new MessagingService();
    const subService = new SubscriptionService();

    // 1. Raw Payment Evidence immutability
    const invoice = await recon.createInvoice(orgId, {
      referenceNumber: 'QA99IMMUT1',
      totalAmountCents: 5000000n,
    });

    const ack = await ingestion.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.DIRECT_PROVIDER_API,
      senderAddress: 'M-PESA',
      rawPayload: 'QA99IMMUT1 Imethibitishwa. Umepokea Tsh50,000 kutoka kwa John 255754123456 tarehe 05/11/2026 saa 12:00.',
      deviceTimestamp: new Date('2026-11-05T12:00:00Z'),
    });

    await assert.rejects(
      async () => {
        await sql`UPDATE raw_payment_evidence SET raw_payload = 'TAMPERED' WHERE id = ${ack.evidenceId}`;
      },
      /IMMUTABLE_RECORD_VIOLATION/,
    );
    await assert.rejects(
      async () => {
        await sql`DELETE FROM raw_payment_evidence WHERE id = ${ack.evidenceId}`;
      },
      /IMMUTABLE_RECORD_VIOLATION/,
    );

    // 2. Payment Verification immutability
    const verResult = await recon.verifyPayment(orgId, {
      paymentId: ack.paymentId!,
      invoiceId: invoice.id,
      verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
      verifiedById: reg.user.id,
    });

    await assert.rejects(
      async () => {
        await sql`DELETE FROM payment_verifications WHERE id = ${verResult.verification.id}`;
      },
      /IMMUTABLE_RECORD_VIOLATION/,
    );

    // 3. Messaging Credit Ledger immutability
    await messaging.purchaseCredits(orgId, 100, 'REF-IMMUT-1');
    const ledgers = await messaging.listLedgerEntries(orgId);
    assert.equal(ledgers.length, 1);

    await assert.rejects(
      async () => {
        await sql`UPDATE messaging_credit_ledger SET amount_credits = 99999 WHERE id = ${ledgers[0]!.id}`;
      },
      /IMMUTABLE_RECORD_VIOLATION/,
    );

    // 4. Audit Log immutability
    const audits = await dbStore.getAuditLogs(orgId);
    assert.equal(audits.length >= 1, true);
    await assert.rejects(
      async () => {
        await sql`DELETE FROM audit_logs WHERE id = ${audits[0]!.id}`;
      },
      /IMMUTABLE_RECORD_VIOLATION/,
    );

    // 5. Subscription Billing Invoice snapshot immutability
    await subService.checkoutSubscription(orgId, reg.user.id, {
      planCode: 'PLAN_STARTER',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });
    const subInvoices = await dbStore.getSubscriptionInvoices(orgId);
    assert.equal(subInvoices.length, 1);

    await assert.rejects(
      async () => {
        await sql`UPDATE subscription_billing_invoices SET amount_cents = 100 WHERE id = ${subInvoices[0]!.id}`;
      },
      /IMMUTABLE_SNAPSHOT_VIOLATION/,
    );
  });

  it('rolls back multi-record transactions completely on mid-transaction failure', async () => {
    const orgId = randomUUID();
    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Rollback Org',
      slug: `rollback-org-${orgId.slice(0, 8)}`,
    });

    await assert.rejects(async () => {
      await withTransaction(async (tx) => {
        await tx`
          INSERT INTO invoices (
            id, organization_id, reference_number, total_amount_cents, paid_amount_cents, balance_cents, currency, status
          ) VALUES (
            ${randomUUID()}, ${orgId}, 'INV-ROLLBACK-1', 100000, 0, 100000, 'TZS', 'UNPAID'
          )
        `;
        throw new Error('Simulated mid-transaction failure');
      });
    }, /Simulated mid-transaction failure/);

    const recon = new ReconciliationService();
    const invoices = await recon.listInvoices(orgId);
    assert.equal(invoices.length, 0, 'Rolled-back invoice must not exist in PostgreSQL');
  });

  it('throws DatabaseUnavailableError (503) when PostgreSQL is unavailable instead of falling back to memory', async () => {
    setSimulatedDatabaseOutage(true);
    try {
      const authService = new AuthService();
      await assert.rejects(
        async () => {
          await authService.register({
            email: 'outage@brisksms.co.tz',
            password: 'StrongPassword123!',
            fullName: 'Outage User',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DatabaseUnavailableError);
          assert.equal(err.statusCode, 503);
          assert.equal(err.code, 'DATABASE_UNAVAILABLE');
          return true;
        },
      );
    } finally {
      setSimulatedDatabaseOutage(false);
    }
  });
});
