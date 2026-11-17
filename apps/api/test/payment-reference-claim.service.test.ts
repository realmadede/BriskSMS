import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaimEventAction,
  ClaimEvidenceTier,
  ClaimStatus,
  InvoiceStatus,
  PaymentProvider,
  PaymentVerificationState,
  TransactionState,
  VerificationMethod,
} from '@brisksms/shared';
import { resolveDbConnectionConfig, sql, SqlPool, withTransaction } from '@brisksms/db';
import { dbStore } from '../src/core/store.js';
import { HttpException } from '../src/core/http.js';
import {
  paymentReferenceClaimService,
} from '../src/modules/reconciliation/payment-reference-claim.service.js';

describe('PaymentReferenceClaimService — Unified Global Claim Boundary', () => {
  const service = paymentReferenceClaimService;

  const orgA = randomUUID();
  const orgB = randomUUID();
  const orgC = randomUUID();

  async function createTestPayment(
    orgId: string,
    reference: string,
    state: TransactionState = TransactionState.OBSERVED,
  ): Promise<string> {
    const rawId = randomUUID();
    const payId = randomUUID();

    await sql`
      INSERT INTO "raw_payment_evidence" (
        "id", "organization_id", "source_type", "sender_address",
        "raw_payload", "device_timestamp", "received_at"
      )
      VALUES (
        ${rawId}, ${orgId}, 'ANDROID_NOTIFICATION_RELAY'::"EvidenceSourceType",
        'MPESA', 'raw payload', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `;

    await sql`
      INSERT INTO "normalized_payments" (
        "id", "organization_id", "raw_evidence_id", "provider", "reference",
        "amount_cents", "currency", "sender_phone", "provider_timestamp",
        "state", "deduplication_hash"
      )
      VALUES (
        ${payId}, ${orgId}, ${rawId}, 'MPESA'::"PaymentProvider", ${reference},
        100000, 'TZS', '255754000000', CURRENT_TIMESTAMP,
        ${state}::"TransactionState", ${'dedup_' + randomUUID()}
      )
    `;

    return payId;
  }

  beforeEach(async () => {
    await dbStore.reset();

    await dbStore.seedOrganizationDirect({
      id: orgA,
      name: 'Organization Alpha',
      slug: `org-alpha-${orgA.slice(0, 8)}`,
      countryCode: 'TZA',
    });

    await dbStore.seedOrganizationDirect({
      id: orgB,
      name: 'Organization Beta',
      slug: `org-beta-${orgB.slice(0, 8)}`,
      countryCode: 'TZA',
    });

    await dbStore.seedOrganizationDirect({
      id: orgC,
      name: 'Organization Gamma',
      slug: `org-gamma-${orgC.slice(0, 8)}`,
      countryCode: 'TZA',
    });
  });

  describe('1. Reference Normalization and Input Validation', () => {
    it('normalizes provider references by trimming and uppercasing', () => {
      assert.equal(service.normalizeReference('  mpesa12345  '), 'MPESA12345');
      assert.equal(service.normalizeReference('abc_xyz'), 'ABC_XYZ');
    });

    it('rejects empty, whitespace-only, or invalid references with HTTP 400', () => {
      assert.throws(
        () => service.normalizeReference(''),
        (err: any) => err instanceof HttpException && err.statusCode === 400 && err.code === 'INVALID_PAYMENT_REFERENCE',
      );
      assert.throws(
        () => service.normalizeReference('    '),
        (err: any) => err instanceof HttpException && err.statusCode === 400 && err.code === 'INVALID_PAYMENT_REFERENCE',
      );
      assert.throws(
        () => service.normalizeReference(null as any),
        (err: any) => err instanceof HttpException && err.statusCode === 400,
      );
    });
  });

  describe('2. Provisional Claim Acquisition Lifecycle', () => {
    it('acquires a clean provisional claim and logs append-only event', async () => {
      const ref = 'REF_PROV_01';
      const paymentId = await createTestPayment(orgA, ref);

      const result = await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId,
        });
      });

      assert.equal(result.outcome, 'CLAIM_ACQUIRED');
      assert.equal(result.status, ClaimStatus.PROVISIONAL);
      assert.equal(result.paymentId, paymentId);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.ok(claim);
      assert.equal(claim.providerReference, ref);
      assert.equal(claim.organizationId, orgA);
      assert.equal(claim.status, ClaimStatus.PROVISIONAL);
      assert.equal(claim.evidenceTier, ClaimEvidenceTier.CLIENT_REPORTED);
      assert.equal(claim.version, 1);
      assert.ok(claim.expiresAt);

      // Verify event log
      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "claim_id" = ${claim.id}
        ORDER BY "created_at" ASC
      `;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.action, ClaimEventAction.PROVISIONALLY_CLAIMED);
      assert.equal(events[0]!.new_status, ClaimStatus.PROVISIONAL);
      assert.equal(events[0]!.previous_status, null);
    });

    it('idempotently returns CLAIM_ACQUIRED when same org replays same paymentId', async () => {
      const ref = 'REF_IDEMPOTENT_01';
      const paymentId = await createTestPayment(orgA, ref);

      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId,
        });
      });

      const replay = await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId,
        });
      });

      assert.equal(replay.outcome, 'CLAIM_ACQUIRED');
      assert.equal(replay.status, ClaimStatus.PROVISIONAL);

      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "provider_reference" = ${ref}
      `;
      assert.equal(events.length, 1); // No duplicate event
    });

    it('returns SUPPLEMENTARY_MATCH when same org submits different paymentId', async () => {
      const ref = 'REF_SUPP_01';
      const paymentId1 = await createTestPayment(orgA, ref);
      const paymentId2 = await createTestPayment(orgA, ref);

      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId: paymentId1,
        });
      });

      const secondary = await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId: paymentId2,
        });
      });

      assert.equal(secondary.outcome, 'SUPPLEMENTARY_MATCH');
      assert.equal(secondary.status, ClaimStatus.PROVISIONAL);
      assert.equal(secondary.paymentId, paymentId1);
    });

    it('rejects cross-tenant acquisition of active provisional claim with HTTP 409', async () => {
      const ref = 'REF_CROSS_01';
      const paymentIdA = await createTestPayment(orgA, ref);
      const paymentIdB = await createTestPayment(orgB, ref);

      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId: paymentIdA,
        });
      });

      await assert.rejects(
        async () => {
          await withTransaction(async (tx) => {
            return service.acquireProvisionalClaim(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgB,
              paymentId: paymentIdB,
            });
          });
        },
        (err: any) =>
          err instanceof HttpException &&
          err.statusCode === 409 &&
          err.code === 'REFERENCE_CLAIMED_BY_ANOTHER_ORG',
      );
    });
  });

  describe('3. Expired Claims and Anti-Theft Invariant', () => {
    it('allows original tenant to refresh its own expired provisional claim', async () => {
      const ref = 'REF_EXPIRE_REFRESH_01';
      const paymentId1 = await createTestPayment(orgA, ref);
      const paymentId2 = await createTestPayment(orgA, ref);

      // Create expired claim directly
      const claimId = randomUUID();
      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id",
          "payment_id", "status", "evidence_tier", "claimed_at", "expires_at", "version"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          ${orgA},
          ${paymentId1},
          'EXPIRED'::"claim_status",
          'CLIENT_REPORTED'::"claim_evidence_tier",
          CURRENT_TIMESTAMP - INTERVAL '3 hours',
          CURRENT_TIMESTAMP - INTERVAL '1 hour',
          1
        )
      `;

      const result = await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId: paymentId2,
        });
      });

      assert.equal(result.outcome, 'RECLAIMED_IN_PLACE');
      assert.equal(result.status, ClaimStatus.PROVISIONAL);
      assert.equal(result.paymentId, paymentId2);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.PROVISIONAL);
      assert.equal(claim?.version, 2);

      // Verify event log
      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "claim_id" = ${claimId}
        ORDER BY "created_at" DESC
      `;
      assert.equal(events[0]!.action, ClaimEventAction.PROVISIONALLY_CLAIMED);
      assert.equal(events[0]!.previous_status, ClaimStatus.EXPIRED);
      assert.equal(events[0]!.new_status, ClaimStatus.PROVISIONAL);
    });

    it('enforces anti-theft: competing tenant SMS on expired claim transitions to DISPUTED', async () => {
      const ref = 'REF_EXPIRE_THEFT_01';
      const paymentIdA = await createTestPayment(orgA, ref);
      const paymentIdB = await createTestPayment(orgB, ref);

      const claimId = randomUUID();
      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id",
          "payment_id", "status", "evidence_tier", "claimed_at", "expires_at", "version"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          ${orgA},
          ${paymentIdA},
          'EXPIRED'::"claim_status",
          'CLIENT_REPORTED'::"claim_evidence_tier",
          CURRENT_TIMESTAMP - INTERVAL '3 hours',
          CURRENT_TIMESTAMP - INTERVAL '1 hour',
          1
        )
      `;

      const result = await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgB,
          paymentId: paymentIdB,
        });
      });

      assert.equal(result.outcome, 'DISPUTE_RAISED');
      assert.equal(result.status, ClaimStatus.DISPUTED);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.DISPUTED);

      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "claim_id" = ${claimId}
        ORDER BY "created_at" DESC
      `;
      assert.equal(events[0]!.action, ClaimEventAction.DISPUTE_RAISED);
      assert.equal(events[0]!.new_status, ClaimStatus.DISPUTED);
    });
  });

  describe('4. Permanent Confirmed Carrier Claims (Anti-Replay)', () => {
    it('confirms provider reference from carrier STK callback', async () => {
      const ref = 'REF_CONFIRM_01';
      const checkoutId = randomUUID();
      const paymentId = await createTestPayment(orgA, ref);

      const result = await withTransaction(async (tx) => {
        return service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          checkoutId,
          paymentId,
          amountCents: 500000n,
          currency: 'TZS',
        });
      });

      assert.equal(result.outcome, 'CONFIRMED');
      assert.equal(result.status, ClaimStatus.CONFIRMED_PROVIDER);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);
      assert.equal(claim?.evidenceTier, ClaimEvidenceTier.AUTHORITATIVE_PROVIDER);
      assert.ok(claim?.confirmedAt);

      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "claim_id" = ${claim!.id}
      `;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.action, ClaimEventAction.CONFIRMED_PROVIDER);
    });

    it('rejects cross-tenant claim against already confirmed reference with HTTP 409', async () => {
      const ref = 'REF_ALREADY_CONFIRMED_01';
      const checkoutId = randomUUID();
      const paymentIdA = await createTestPayment(orgA, ref);
      const paymentIdB = await createTestPayment(orgB, ref);

      await withTransaction(async (tx) => {
        return service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          checkoutId,
          paymentId: paymentIdA,
          amountCents: 100000n,
          currency: 'TZS',
        });
      });

      // Org B attempts to acquire provisional claim
      await assert.rejects(
        async () => {
          await withTransaction(async (tx) => {
            return service.acquireProvisionalClaim(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgB,
              paymentId: paymentIdB,
            });
          });
        },
        (err: any) =>
          err instanceof HttpException &&
          err.statusCode === 409 &&
          err.code === 'REFERENCE_ALREADY_SETTLED',
      );

      // Org B attempts to confirm via callback
      await assert.rejects(
        async () => {
          await withTransaction(async (tx) => {
            return service.confirmProviderReference(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgB,
              checkoutId: randomUUID(),
              paymentId: paymentIdB,
              amountCents: 100000n,
              currency: 'TZS',
            });
          });
        },
        (err: any) =>
          err instanceof HttpException &&
          err.statusCode === 409 &&
          err.code === 'REFERENCE_ALREADY_SETTLED',
      );
    });

    it('rejects different checkout in same org claiming already confirmed reference', async () => {
      const ref = 'REF_SAME_ORG_DIFF_CHECKOUT_01';
      const checkoutId1 = randomUUID();
      const checkoutId2 = randomUUID();
      const paymentId = await createTestPayment(orgA, ref);

      await withTransaction(async (tx) => {
        return service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          checkoutId: checkoutId1,
          paymentId,
          amountCents: 100000n,
          currency: 'TZS',
        });
      });

      await assert.rejects(
        async () => {
          await withTransaction(async (tx) => {
            return service.confirmProviderReference(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgA,
              checkoutId: checkoutId2,
              paymentId: await createTestPayment(orgA, ref),
              amountCents: 100000n,
              currency: 'TZS',
            });
          });
        },
        (err: any) =>
          err instanceof HttpException &&
          err.statusCode === 409 &&
          err.code === 'REFERENCE_ALREADY_USED',
      );
    });
  });

  describe('5. Superseded Eviction and Contradictory Callbacks', () => {
    it('evicts unconfirmed provisional claim of Org B when Org A receives authentic STK callback', async () => {
      const ref = 'REF_EVICT_01';
      const paymentIdB = await createTestPayment(orgB, ref);
      const paymentIdA = await createTestPayment(orgA, ref);
      const checkoutIdA = randomUUID();

      // Org B holds unconfirmed provisional claim
      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgB,
          paymentId: paymentIdB,
        });
      });

      // Authentic STK callback arrives for Org A
      const result = await withTransaction(async (tx) => {
        return service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          checkoutId: checkoutIdA,
          paymentId: paymentIdA,
          amountCents: 200000n,
          currency: 'TZS',
        });
      });

      assert.equal(result.outcome, 'SUPERSEDED_EVICTED');
      assert.equal(result.status, ClaimStatus.CONFIRMED_PROVIDER);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.organizationId, orgA);
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);
      assert.equal(claim?.evidenceTier, ClaimEvidenceTier.AUTHORITATIVE_PROVIDER);

      // Verify audit event
      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "claim_id" = ${claim!.id}
        ORDER BY "created_at" DESC
      `;
      assert.equal(events[0]!.action, ClaimEventAction.SUPERSEDED_EVICTION);
      assert.equal(events[0]!.new_status, ClaimStatus.CONFIRMED_PROVIDER);
    });

    it('raises DISPUTE when authentic STK callback contradicts locally settled payment in Org B', async () => {
      const ref = 'REF_CONTRADICT_01';
      const paymentIdB = await createTestPayment(orgB, ref, TransactionState.VERIFIED);
      const checkoutIdA = randomUUID();
      const paymentIdA = await createTestPayment(orgA, ref);

      // Org B holds claim
      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgB,
          paymentId: paymentIdB,
        });
      });

      // Later, authentic STK callback arrives for Org A
      const result = await withTransaction(async (tx) => {
        return service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          checkoutId: checkoutIdA,
          paymentId: paymentIdA,
          amountCents: 200000n,
          currency: 'TZS',
        });
      });

      assert.equal(result.outcome, 'DISPUTE_RAISED');
      assert.equal(result.status, ClaimStatus.DISPUTED);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.DISPUTED);

      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "claim_id" = ${claim!.id}
        ORDER BY "created_at" DESC
      `;
      assert.equal(events[0]!.action, ClaimEventAction.DISPUTE_RAISED);
      assert.equal(events[0]!.new_status, ClaimStatus.DISPUTED);
    });
  });

  describe('6. Collision Quarantine and Adjudication', () => {
    it('quarantines collisions and blocks both provisional and confirmed claims', async () => {
      const ref = 'REF_COLLISION_01';
      const claimId = randomUUID();

      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id",
          "status", "evidence_tier", "claimed_at"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          NULL,
          'UNRESOLVED_COLLISION'::"claim_status",
          'UNRESOLVED'::"claim_evidence_tier",
          CURRENT_TIMESTAMP
        )
      `;

      await sql`
        INSERT INTO "payment_reference_claim_collisions" (
          "claim_id", "provider", "provider_reference", "competing_records", "status"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          '[]'::jsonb,
          'UNRESOLVED'
        )
      `;

      const payA = await createTestPayment(orgA, ref);

      // Ingestion attempt blocks
      await assert.rejects(
        async () => {
          await withTransaction(async (tx) => {
            return service.acquireProvisionalClaim(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgA,
              paymentId: payA,
            });
          });
        },
        (err: any) =>
          err instanceof HttpException &&
          err.statusCode === 409 &&
          err.code === 'COLLISION_QUARANTINED',
      );

      // Callback confirmation attempt blocks
      await assert.rejects(
        async () => {
          await withTransaction(async (tx) => {
            return service.confirmProviderReference(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgA,
              checkoutId: randomUUID(),
              paymentId: payA,
              amountCents: 100000n,
              currency: 'TZS',
            });
          });
        },
        (err: any) =>
          err instanceof HttpException &&
          err.statusCode === 409 &&
          err.code === 'COLLISION_QUARANTINED',
      );
    });

    it('adjudicates collision by awarding to Organization A', async () => {
      const ref = 'REF_ADJUDICATE_AWARD_01';
      const claimId = randomUUID();
      const adjudicatorId = randomUUID();

      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id",
          "status", "evidence_tier", "claimed_at"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          NULL,
          'UNRESOLVED_COLLISION'::"claim_status",
          'UNRESOLVED'::"claim_evidence_tier",
          CURRENT_TIMESTAMP
        )
      `;

      await sql`
        INSERT INTO "payment_reference_claim_collisions" (
          "claim_id", "provider", "provider_reference", "competing_records", "status"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          '[]'::jsonb,
          'UNRESOLVED'
        )
      `;

      const result = await withTransaction(async (tx) => {
        return service.adjudicateCollision(tx, {
          claimId,
          awardedOrganizationId: orgA,
          adjudicatorId,
          rationale: 'Verified official bank statement confirming payment belongs to Org A',
        });
      });

      assert.equal(result.outcome, 'CONFIRMED');
      assert.equal(result.status, ClaimStatus.CONFIRMED_PROVIDER);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);
      assert.equal(claim?.organizationId, orgA);
      assert.equal(claim?.confirmedById, adjudicatorId);

      const collision = await sql`
        SELECT * FROM "payment_reference_claim_collisions" WHERE "claim_id" = ${claimId}
      `;
      assert.equal(collision[0]!.status, 'ADJUDICATED');
      assert.equal(collision[0]!.awarded_organization_id, orgA);
    });

    it('adjudicates collision by formal release and permits subsequent in-place reclaim', async () => {
      const ref = 'REF_ADJUDICATE_RELEASE_01';
      const claimId = randomUUID();
      const adjudicatorId = randomUUID();

      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id",
          "status", "evidence_tier", "claimed_at"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          NULL,
          'UNRESOLVED_COLLISION'::"claim_status",
          'UNRESOLVED'::"claim_evidence_tier",
          CURRENT_TIMESTAMP
        )
      `;

      await sql`
        INSERT INTO "payment_reference_claim_collisions" (
          "claim_id", "provider", "provider_reference", "competing_records", "status"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          '[]'::jsonb,
          'UNRESOLVED'
        )
      `;

      // Formal release
      const result = await withTransaction(async (tx) => {
        return service.adjudicateCollision(tx, {
          claimId,
          adjudicatorId,
          rationale: 'Investigation proved provider transaction never occurred; safe release',
        });
      });

      assert.equal(result.outcome, 'RECLAIMED_IN_PLACE');
      assert.equal(result.status, ClaimStatus.RELEASED);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.RELEASED);
      assert.equal(claim?.organizationId, null);

      // Now Organization C can reclaim in-place
      const paymentIdC = await createTestPayment(orgC, ref);
      const reclaimResult = await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgC,
          paymentId: paymentIdC,
        });
      });

      assert.equal(reclaimResult.outcome, 'RECLAIMED_IN_PLACE');
      assert.equal(reclaimResult.status, ClaimStatus.PROVISIONAL);
      assert.equal(reclaimResult.claimId, claimId);

      const reclaimedClaim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(reclaimedClaim?.organizationId, orgC);
      assert.equal(reclaimedClaim?.status, ClaimStatus.PROVISIONAL);
    });
  });

  describe('7. Background Sweeper (expireProvisionalClaims)', () => {
    it('transitions lapsed provisional claims to EXPIRED and logs events', async () => {
      const ref = 'REF_SWEEP_01';
      const claimId = randomUUID();
      const paymentId = await createTestPayment(orgA, ref);

      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id", "payment_id",
          "status", "evidence_tier", "claimed_at", "expires_at", "version"
        )
        VALUES (
          ${claimId},
          'MPESA'::"PaymentProvider",
          ${ref},
          ${orgA},
          ${paymentId},
          'PROVISIONAL'::"claim_status",
          'CLIENT_REPORTED'::"claim_evidence_tier",
          CURRENT_TIMESTAMP - INTERVAL '3 hours',
          CURRENT_TIMESTAMP - INTERVAL '1 hour',
          1
        )
      `;

      const sweptCount = await withTransaction(async (tx) => {
        return service.expireProvisionalClaims(tx);
      });

      assert.ok(sweptCount >= 1);

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.EXPIRED);
      assert.equal(claim?.organizationId, orgA); // Still belongs to Org A!

      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "claim_id" = ${claimId}
        ORDER BY "created_at" DESC
      `;
      assert.equal(events[0]!.action, ClaimEventAction.EXPIRED);
    });
  });

  describe('8. Supplementary Evidence Attachment', () => {
    it('attaches supplementary evidence and logs event with metadata', async () => {
      const ref = 'REF_ATTACH_01';
      const paymentId = await createTestPayment(orgA, ref);
      const rawEvidenceId = randomUUID();

      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId,
        });
      });

      const result = await withTransaction(async (tx) => {
        return service.attachSupplementaryEvidence(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          amountCents: 500000n,
          currency: 'TZS',
          senderPhone: '255754000111',
          rawEvidenceId,
        });
      });

      assert.equal(result.outcome, 'SUPPLEMENTARY_MATCH');

      const events = await sql`
        SELECT * FROM "payment_reference_claim_events"
        WHERE "provider_reference" = ${ref} AND "action" = 'SUPPLEMENTARY_ATTACHED'::"claim_event_action"
      `;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.evidence_id, rawEvidenceId);
    });

    it('rejects supplementary evidence attachment from different organization', async () => {
      const ref = 'REF_ATTACH_REJECT_01';
      const paymentId = await createTestPayment(orgA, ref);

      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId,
        });
      });

      await assert.rejects(
        async () => {
          await withTransaction(async (tx) => {
            return service.attachSupplementaryEvidence(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgB,
              amountCents: 500000n,
              currency: 'TZS',
              rawEvidenceId: randomUUID(),
            });
          });
        },
        (err: any) =>
          err instanceof HttpException &&
          err.statusCode === 409 &&
          err.code === 'REFERENCE_CLAIMED_BY_ANOTHER_ORG',
      );
    });
  });

  describe('9. PostgreSQL Immutability Trigger (trg_claim_events_immutable)', () => {
    it('blocks UPDATE operations on payment_reference_claim_events via trigger', async () => {
      const ref = 'REF_IMMUTABLE_01';
      const paymentId = await createTestPayment(orgA, ref);

      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId,
        });
      });

      const events = await sql`
        SELECT "id" FROM "payment_reference_claim_events"
        WHERE "provider_reference" = ${ref}
        LIMIT 1
      `;
      assert.equal(events.length, 1);
      const eventId = events[0]!.id;

      await assert.rejects(
        async () => {
          await sql`
            UPDATE "payment_reference_claim_events"
            SET "reason" = 'tampered'
            WHERE "id" = ${eventId}
          `;
        },
        /immutable/i,
      );
    });

    it('blocks DELETE operations on payment_reference_claim_events via trigger', async () => {
      const ref = 'REF_IMMUTABLE_DEL_01';
      const paymentId = await createTestPayment(orgA, ref);

      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId,
        });
      });

      const events = await sql`
        SELECT "id" FROM "payment_reference_claim_events"
        WHERE "provider_reference" = ${ref}
        LIMIT 1
      `;
      assert.equal(events.length, 1);
      const eventId = events[0]!.id;

      await assert.rejects(
        async () => {
          await sql`
            DELETE FROM "payment_reference_claim_events"
            WHERE "id" = ${eventId}
          `;
        },
        /immutable/i,
      );
    });
  });

  describe('10. Organization Deletion Foreign Key Integrity', () => {
    it('blocks deletion of organization holding claims with ON DELETE RESTRICT', async () => {
      const ref = 'REF_ORG_RESTRICT_01';
      const paymentId = await createTestPayment(orgA, ref);

      await withTransaction(async (tx) => {
        return service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId,
        });
      });

      await assert.rejects(
        async () => {
          await sql`
            DELETE FROM "organizations" WHERE "id" = ${orgA}
          `;
        },
        /violates (?:RESTRICT setting of )?foreign key constraint/i,
      );
    });
  });

  describe('11. Multi-Replica Advisory Lock & Concurrency Serialization', () => {
    it('serializes 10 concurrent claim attempts for the same reference across connections', async () => {
      const ref = 'REF_CONCURRENT_RACE_01';

      // Pre-seed payments for all 10 tasks so foreign keys pass and distinct paymentIds are used
      const payments = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          createTestPayment(i % 2 === 0 ? orgA : orgB, ref),
        ),
      );

      // 10 concurrent requests from alternating orgs
      const tasks = Array.from({ length: 10 }, (_, i) => {
        const org = i % 2 === 0 ? orgA : orgB;
        const paymentId = payments[i]!;
        return withTransaction(async (tx) => {
          return service.acquireProvisionalClaim(tx, {
            provider: PaymentProvider.MPESA,
            reference: ref,
            organizationId: org,
            paymentId,
          });
        }).then(
          (res) => ({ status: 'fulfilled' as const, value: res, org }),
          (err) => ({ status: 'rejected' as const, reason: err, org }),
        );
      });

      const results = await Promise.all(tasks);

      // Exactly 1 winner should acquire the initial claim
      const acquired = results.filter(
        (r) => r.status === 'fulfilled' && r.value.outcome === 'CLAIM_ACQUIRED',
      );
      assert.equal(acquired.length, 1);
      const winnerOrg = acquired[0]!.org;

      // Same-org attempts could be CLAIM_ACQUIRED or SUPPLEMENTARY_MATCH, other-org must be rejected with 409
      for (const r of results) {
        if (r.status === 'rejected') {
          assert.equal(r.reason?.statusCode, 409);
        } else {
          assert.equal(r.org, winnerOrg);
        }
      }
    });
  });

  // ===========================================================================
  // P0.2 Adversarial Hardening Scenarios
  // ===========================================================================

  async function createSettledInvoiceAndVerification(
    orgId: string,
    paymentId: string,
    options: {
      paymentState?: TransactionState;
      createVerification?: boolean;
      createInvoicePayment?: boolean;
      amountCents?: bigint;
    } = {},
  ): Promise<{ verificationId?: string; invoiceId?: string; invoicePaymentId?: string }> {
    const amountCents = options.amountCents ?? 100000n;
    if (options.paymentState) {
      await sql`
        UPDATE "normalized_payments"
        SET "state" = ${options.paymentState}::"TransactionState"
        WHERE "id" = ${paymentId} AND "organization_id" = ${orgId}
      `;
    }

    let verificationId: string | undefined;
    let invoiceId: string | undefined;
    let invoicePaymentId: string | undefined;

    if (options.createVerification) {
      verificationId = randomUUID();
      await sql`
        INSERT INTO "payment_verifications" (
          "id", "organization_id", "payment_id", "verification_method",
          "decision", "external_verification_ref", "notes", "previous_state", "new_state"
        )
        VALUES (
          ${verificationId},
          ${orgId},
          ${paymentId},
          ${VerificationMethod.MANUAL_FINANCE_APPROVAL}::"VerificationMethod",
          'APPROVED',
          'EXT_VER_REF_01',
          'Human finance verification attested against carrier portal',
          'OBSERVED'::"TransactionState",
          ${options.paymentState ?? TransactionState.VERIFIED}::"TransactionState"
        )
      `;
    }

    if (options.createInvoicePayment) {
      invoiceId = randomUUID();
      invoicePaymentId = randomUUID();
      await sql`
        INSERT INTO "invoices" (
          "id", "organization_id", "reference_number", "total_amount_cents",
          "paid_amount_cents", "balance_cents", "currency", "status"
        )
        VALUES (
          ${invoiceId},
          ${orgId},
          ${'INV_' + invoiceId.slice(0, 8)},
          ${amountCents.toString()}::bigint,
          ${amountCents.toString()}::bigint,
          0,
          'TZS',
          ${InvoiceStatus.PAID}::"InvoiceStatus"
        )
      `;
      await sql`
        INSERT INTO "invoice_payments" (
          "id", "organization_id", "invoice_id", "payment_id",
          "verification_id", "applied_amount_cents"
        )
        VALUES (
          ${invoicePaymentId},
          ${orgId},
          ${invoiceId},
          ${paymentId},
          ${verificationId ?? null},
          ${amountCents.toString()}::bigint
        )
      `;
    }

    return { verificationId, invoiceId, invoicePaymentId };
  }

  function openIndependentClient(): SqlPool {
    const g = globalThis as unknown as { Bun: { SQL: new (opts: Record<string, unknown>) => SqlPool } };
    const cfg = resolveDbConnectionConfig();
    return new g.Bun.SQL({ ...cfg.options, max: 1 });
  }

  describe('12. Canonical Normalization & Database Constraint Enforcement', () => {
    it('treats lowercase, uppercase, and padded references identically across all claim operations', async () => {
      const paymentId = await createTestPayment(orgA, '  abc_case_01  ');

      const acq = await withTransaction((tx) =>
        service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: '  abc_case_01 ',
          organizationId: orgA,
          paymentId,
        }),
      );
      assert.equal(acq.outcome, 'CLAIM_ACQUIRED');

      // Competing tenant with lowercase variant must be blocked by canonical lock & row
      const payB = await createTestPayment(orgB, 'abc_case_01');
      await assert.rejects(
        () =>
          withTransaction((tx) =>
            service.acquireProvisionalClaim(tx, {
              provider: PaymentProvider.MPESA,
              reference: 'AbC_cAsE_01',
              organizationId: orgB,
              paymentId: payB,
            }),
          ),
        (err: any) => err instanceof HttpException && err.statusCode === 409 && err.code === 'REFERENCE_CLAIMED_BY_ANOTHER_ORG',
      );

      // Attach supplementary with mixed case
      const supp = await withTransaction((tx) =>
        service.attachSupplementaryEvidence(tx, {
          provider: PaymentProvider.MPESA,
          reference: 'aBc_CaSe_01 ',
          organizationId: orgA,
          amountCents: 100000n,
          currency: 'TZS',
          rawEvidenceId: randomUUID(),
        }),
      );
      assert.equal(supp.outcome, 'SUPPLEMENTARY_MATCH');

      // Confirm via callback with canonicalized uppercase
      const conf = await withTransaction((tx) =>
        service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ' abc_case_01',
          organizationId: orgA,
          checkoutId: randomUUID(),
          paymentId,
          amountCents: 100000n,
          currency: 'TZS',
        }),
      );
      assert.equal(conf.outcome, 'CONFIRMED');
      const claim = await service.getClaim(PaymentProvider.MPESA, 'ABC_CASE_01');
      assert.equal(claim?.providerReference, 'ABC_CASE_01');
    });

    it('rejects embedded whitespace, control chars, >100 char refs, and invalid providers cleanly with HTTP 400', () => {
      assert.throws(
        () => service.normalizeReference('ABC 123'),
        (err: any) => err instanceof HttpException && err.statusCode === 400 && err.code === 'INVALID_PAYMENT_REFERENCE',
      );
      assert.throws(
        () => service.normalizeReference('ABC\n123'),
        (err: any) => err instanceof HttpException && err.statusCode === 400 && err.code === 'INVALID_PAYMENT_REFERENCE',
      );
      assert.throws(
        () => service.normalizeReference('A'.repeat(101)),
        (err: any) => err instanceof HttpException && err.statusCode === 400 && err.code === 'INVALID_PAYMENT_REFERENCE',
      );
      assert.throws(
        () => service.normalizeProvider('UNKNOWN_MNO' as PaymentProvider),
        (err: any) => err instanceof HttpException && err.statusCode === 400 && err.code === 'INVALID_PAYMENT_PROVIDER',
      );
    });

    it('enforces DB CHECK constraints rejecting non-canonical casing and invalid NULL organization ownership', async () => {
      await assert.rejects(
        () =>
          sql`
            INSERT INTO "payment_reference_claims" (
              "provider", "provider_reference", "organization_id", "status", "evidence_tier"
            )
            VALUES ('MPESA'::"PaymentProvider", 'lowercase_ref', ${orgA}, 'PROVISIONAL'::"claim_status", 'CLIENT_REPORTED'::"claim_evidence_tier")
          `,
        /chk_claim_provider_ref_canonical/i,
      );

      await assert.rejects(
        () =>
          sql`
            INSERT INTO "payment_reference_claims" (
              "provider", "provider_reference", "organization_id", "status", "evidence_tier"
            )
            VALUES ('MPESA'::"PaymentProvider", 'VALID_NULL_ORG_BLOCK', NULL, 'PROVISIONAL'::"claim_status", 'CLIENT_REPORTED'::"claim_evidence_tier")
          `,
        /chk_claim_org_nullability/i,
      );

      await assert.rejects(
        () =>
          sql`
            INSERT INTO "payment_reference_claims" (
              "provider", "provider_reference", "organization_id", "status", "evidence_tier"
            )
            VALUES ('MPESA'::"PaymentProvider", 'VALID_NONNULL_COLLISION', ${orgA}, 'UNRESOLVED_COLLISION'::"claim_status", 'UNRESOLVED'::"claim_evidence_tier")
          `,
        /chk_claim_org_nullability/i,
      );
    });
  });

  describe('13. Historical Migration Case-Variant Collision Quarantine Verification', () => {
    it('quarantines cross-tenant case-variant historical collisions without picking an arbitrary winner', async () => {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const migrationSqlPath = join(
        currentDir,
        '../../../packages/db/prisma/migrations/20261114000000_harden_payment_reference_claims/migration.sql',
      );
      const migrationSql = readFileSync(migrationSqlPath, 'utf8');
      const tempSchema = `_p02_hist_verify_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const client = openIndependentClient();

      try {
        // Seed isolated pre-hardening schema in committed state before running migration transaction
        await client.unsafe(`CREATE SCHEMA "${tempSchema}"`);
        await client.unsafe(`
          CREATE TABLE "${tempSchema}"."organizations" ("id" UUID PRIMARY KEY);
          CREATE TABLE "${tempSchema}"."normalized_payments" (
            "id" UUID PRIMARY KEY,
            "organization_id" UUID NOT NULL,
            "provider" "PaymentProvider" NOT NULL,
            "reference" VARCHAR(100) NOT NULL,
            "amount_cents" BIGINT NOT NULL,
            "sender_phone" VARCHAR(50) NOT NULL,
            "state" "TransactionState" NOT NULL,
            "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE "${tempSchema}"."stk_push_transactions" (
            "id" VARCHAR(64) PRIMARY KEY,
            "organization_id" UUID NOT NULL,
            "provider" "PaymentProvider" NOT NULL,
            "status" VARCHAR(32) NOT NULL,
            "provider_reference" VARCHAR(100),
            "amount_cents" BIGINT NOT NULL,
            "settled_payment_id" UUID,
            "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE "${tempSchema}"."payment_reference_claims" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "provider" "PaymentProvider" NOT NULL,
            "provider_reference" VARCHAR(100) NOT NULL,
            "organization_id" UUID REFERENCES "${tempSchema}"."organizations"("id") ON DELETE RESTRICT,
            "checkout_id" VARCHAR(64),
            "payment_id" UUID REFERENCES "${tempSchema}"."normalized_payments"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
            "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "status" "claim_status" NOT NULL DEFAULT 'PROVISIONAL',
            "evidence_tier" "claim_evidence_tier" NOT NULL DEFAULT 'CLIENT_REPORTED',
            "expires_at" TIMESTAMPTZ(6),
            "confirmed_at" TIMESTAMPTZ(6),
            "confirmed_by_id" UUID,
            "release_reason" VARCHAR(255),
            "version" INTEGER NOT NULL DEFAULT 1,
            "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "payment_reference_claims_unique" UNIQUE ("provider", "provider_reference")
          );
          CREATE TABLE "${tempSchema}"."payment_reference_claim_events" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "claim_id" UUID NOT NULL REFERENCES "${tempSchema}"."payment_reference_claims"("id") ON DELETE CASCADE,
            "provider" "PaymentProvider" NOT NULL,
            "provider_reference" VARCHAR(100) NOT NULL,
            "organization_id" UUID REFERENCES "${tempSchema}"."organizations"("id") ON DELETE RESTRICT,
            "action" "claim_event_action" NOT NULL,
            "previous_status" "claim_status",
            "new_status" "claim_status" NOT NULL,
            "evidence_tier" "claim_evidence_tier" NOT NULL,
            "evidence_id" UUID,
            "actor_id" UUID,
            "actor_type" VARCHAR(32) NOT NULL DEFAULT 'SYSTEM',
            "reason" VARCHAR(255),
            "metadata" JSONB,
            "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE "${tempSchema}"."payment_reference_claim_collisions" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "claim_id" UUID NOT NULL REFERENCES "${tempSchema}"."payment_reference_claims"("id") ON DELETE CASCADE,
            "provider" "PaymentProvider" NOT NULL,
            "provider_reference" VARCHAR(100) NOT NULL,
            "competing_records" JSONB NOT NULL,
            "status" VARCHAR(32) NOT NULL DEFAULT 'UNRESOLVED',
            "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "adjudicated_at" TIMESTAMPTZ(6),
            "adjudicated_by_id" UUID,
            "adjudication_rationale" TEXT,
            "awarded_organization_id" UUID REFERENCES "${tempSchema}"."organizations"("id") ON DELETE RESTRICT
          );
        `);

        const payCaseA = randomUUID();
        const payCaseB = randomUUID();
        const payCleanA = randomUUID();
        await client.unsafe(
          `INSERT INTO "${tempSchema}"."organizations" ("id") VALUES ($1), ($2)`,
          [orgA, orgB],
        );
        await client.unsafe(
          `INSERT INTO "${tempSchema}"."normalized_payments" ("id", "organization_id", "provider", "reference", "amount_cents", "sender_phone", "state")
           VALUES
             ($1, $2, 'MPESA'::"PaymentProvider", 'case_col_99', 50000, '255754000001', 'VERIFIED'::"TransactionState"),
             ($3, $4, 'MPESA'::"PaymentProvider", '  CASE_COL_99 ', 50000, '255754000002', 'OBSERVED'::"TransactionState"),
             ($5, $2, 'MPESA'::"PaymentProvider", '  single_clean_88  ', 25000, '255754000003', 'OBSERVED'::"TransactionState")`,
          [payCaseA, orgA, payCaseB, orgB, payCleanA],
        );
        await client.unsafe(
          `INSERT INTO "${tempSchema}"."payment_reference_claims" ("provider", "provider_reference", "organization_id", "payment_id", "status", "evidence_tier")
           VALUES
             ('MPESA'::"PaymentProvider", 'case_col_99', $1, $2, 'PROVISIONAL'::"claim_status", 'CLIENT_REPORTED'::"claim_evidence_tier"),
             ('MPESA'::"PaymentProvider", '  single_clean_88  ', $1, $3, 'PROVISIONAL'::"claim_status", 'CLIENT_REPORTED'::"claim_evidence_tier")`,
          [orgA, payCaseA, payCleanA],
        );

        await client.begin(async (tx) => {
          await tx.unsafe!(`SET LOCAL search_path = "${tempSchema}", public`);
          await tx.unsafe!(migrationSql);

          const colClaims = await tx`
            SELECT * FROM "payment_reference_claims" WHERE "provider_reference" = 'CASE_COL_99'
          `;
          assert.equal(colClaims.length, 1);
          assert.equal(colClaims[0]!.status, 'UNRESOLVED_COLLISION');
          assert.equal(colClaims[0]!.organization_id, null);
          assert.equal(colClaims[0]!.evidence_tier, 'UNRESOLVED');

          const collisions = await tx`
            SELECT * FROM "payment_reference_claim_collisions" WHERE "provider_reference" = 'CASE_COL_99'
          `;
          assert.equal(collisions.length, 1);
          assert.equal(collisions[0]!.status, 'UNRESOLVED');
          assert.equal(collisions[0]!.competing_records.normalized_payments.length, 2);

          const cleanClaims = await tx`
            SELECT * FROM "payment_reference_claims" WHERE "provider_reference" = 'SINGLE_CLEAN_88'
          `;
          assert.equal(cleanClaims.length, 1);
          assert.equal(cleanClaims[0]!.status, 'PROVISIONAL');
          assert.equal(cleanClaims[0]!.organization_id, orgA);

          const events = await tx`
            SELECT * FROM "payment_reference_claim_events"
            WHERE "provider_reference" = 'CASE_COL_99' AND "action" = 'COLLISION_QUARANTINED'
          `;
          assert.equal(events.length, 1);
        });
      } finally {
        await client.unsafe(`DROP SCHEMA IF EXISTS "${tempSchema}" CASCADE`).catch(() => {});
        await client.close();
      }
    });
  });

  describe('14. Provisional Eviction Guard vs Human Attestation and Settled States', () => {
    it('escalates confirmProviderReference and transferProvisionalOwnership to DISPUTED on human-attested unsettled payment', async () => {
      for (const mode of ['confirmProviderReference', 'transferProvisionalOwnership'] as const) {
        const ref = `REF_ATTEST_UNSETTLED_${mode}`;
        const payB = await createTestPayment(orgB, ref, TransactionState.OBSERVED);
        const payA = await createTestPayment(orgA, ref, TransactionState.OBSERVED);
        await createSettledInvoiceAndVerification(orgB, payB, {
          paymentState: TransactionState.OBSERVED,
          createVerification: true,
          createInvoicePayment: false,
        });

        await withTransaction((tx) =>
          service.acquireProvisionalClaim(tx, {
            provider: PaymentProvider.MPESA,
            reference: ref,
            organizationId: orgB,
            paymentId: payB,
          }),
        );

        const result = await withTransaction((tx) =>
          mode === 'confirmProviderReference'
            ? service.confirmProviderReference(tx, {
                provider: PaymentProvider.MPESA,
                reference: ref,
                organizationId: orgA,
                checkoutId: randomUUID(),
                paymentId: payA,
                amountCents: 100000n,
                currency: 'TZS',
              })
            : service.transferProvisionalOwnership(tx, {
                provider: PaymentProvider.MPESA,
                reference: ref,
                newOrganizationId: orgA,
                newCheckoutId: randomUUID(),
                newPaymentId: payA,
              }),
        );

        assert.equal(result.outcome, 'DISPUTE_RAISED');
        assert.equal(result.status, ClaimStatus.DISPUTED);

        const claim = await service.getClaim(PaymentProvider.MPESA, ref);
        assert.equal(claim?.status, ClaimStatus.DISPUTED);
        assert.equal(claim?.organizationId, orgB); // Not stolen from Org B!
      }
    });

    it('protects already FULFILLED / FULFILLMENT_PENDING payments and invoice_payments from eviction without reversal', async () => {
      for (const settledState of [TransactionState.FULFILLMENT_PENDING, TransactionState.FULFILLED, TransactionState.FULFILLMENT_FAILED]) {
        const ref = `REF_SETTLED_${settledState}`;
        const payB = await createTestPayment(orgB, ref, TransactionState.VERIFIED);
        await createSettledInvoiceAndVerification(orgB, payB, {
          paymentState: settledState,
          createVerification: true,
          createInvoicePayment: true,
        });
        const payA = await createTestPayment(orgA, ref, TransactionState.OBSERVED);

        // Intentionally acquire claim WITHOUT paymentId on the claim row to verify full (org, provider, ref) scan!
        await withTransaction((tx) =>
          service.acquireProvisionalClaim(tx, {
            provider: PaymentProvider.MPESA,
            reference: ref,
            organizationId: orgB,
          }),
        );

        const res = await withTransaction((tx) =>
          service.confirmProviderReference(tx, {
            provider: PaymentProvider.MPESA,
            reference: ref,
            organizationId: orgA,
            checkoutId: randomUUID(),
            paymentId: payA,
            amountCents: 100000n,
            currency: 'TZS',
          }),
        );

        assert.equal(res.outcome, 'DISPUTE_RAISED');
        assert.equal(res.status, ClaimStatus.DISPUTED);

        const payRows = await sql`SELECT "state", "review_reason" FROM "normalized_payments" WHERE "id" = ${payB}`;
        assert.equal(payRows[0]!.state, settledState); // Never downgraded or reversed!
        assert.match(payRows[0]!.review_reason ?? '', /CROSS_TENANT_CARRIER_DISPUTE/);

        const ipRows = await sql`SELECT COUNT(*)::int AS cnt FROM "invoice_payments" WHERE "payment_id" = ${payB}`;
        assert.equal(ipRows[0]!.cnt, 1); // Accounting link preserved!
      }
    });

    it('honors caller-supplied holdingTenantEvidence even when DB payment is not yet transitioned', async () => {
      const ref = 'REF_CALLER_ATTESTED_01';
      const payB = await createTestPayment(orgB, ref, TransactionState.MATCHED);
      const payA = await createTestPayment(orgA, ref, TransactionState.OBSERVED);

      await withTransaction((tx) =>
        service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgB,
          paymentId: payB,
        }),
      );

      const res = await withTransaction((tx) =>
        service.transferProvisionalOwnership(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          newOrganizationId: orgA,
          newCheckoutId: randomUUID(),
          newPaymentId: payA,
          holdingTenantEvidence: {
            verificationState: PaymentVerificationState.HUMAN_ATTESTED,
            isHumanAttested: true,
          },
        }),
      );

      assert.equal(res.outcome, 'DISPUTE_RAISED');
      assert.equal(res.status, ClaimStatus.DISPUTED);
    });
  });

  describe('15. Idempotent Callback Replay, Release Lifecycle, and Atomicity / Rollback', () => {
    it('processes duplicate carrier callback deliveries idempotently without duplicating events', async () => {
      const ref = 'REF_DUP_CALLBACK_01';
      const checkoutId = randomUUID();
      const paymentId = await createTestPayment(orgA, ref);

      await withTransaction((tx) =>
        service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          checkoutId,
          paymentId,
          amountCents: 150000n,
          currency: 'TZS',
        }),
      );

      const replay = await withTransaction((tx) =>
        service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          checkoutId,
          paymentId,
          amountCents: 150000n,
          currency: 'TZS',
        }),
      );

      assert.equal(replay.outcome, 'CONFIRMED');
      assert.equal(replay.status, ClaimStatus.CONFIRMED_PROVIDER);

      const events = await sql`
        SELECT * FROM "payment_reference_claim_events" WHERE "provider_reference" = ${ref}
      `;
      assert.equal(events.length, 1);
    });

    it('rolls back adjudication atomically on failure leaving collision untouched and logs zero partial events', async () => {
      const ref = 'REF_ADJ_ROLLBACK_01';
      const claimId = randomUUID();
      const nonExistentOrg = randomUUID();

      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id", "status", "evidence_tier"
        )
        VALUES (${claimId}, 'MPESA'::"PaymentProvider", ${ref}, NULL, 'UNRESOLVED_COLLISION'::"claim_status", 'UNRESOLVED'::"claim_evidence_tier")
      `;
      await sql`
        INSERT INTO "payment_reference_claim_collisions" (
          "claim_id", "provider", "provider_reference", "competing_records", "status"
        )
        VALUES (${claimId}, 'MPESA'::"PaymentProvider", ${ref}, '[]'::jsonb, 'UNRESOLVED')
      `;

      // FK violation on nonExistentOrg must rollback entire tx
      await assert.rejects(() =>
        withTransaction((tx) =>
          service.adjudicateCollision(tx, {
            claimId,
            awardedOrganizationId: nonExistentOrg,
            adjudicatorId: randomUUID(),
            rationale: 'Awarding to non-existent tenant triggers FK rollback',
          }),
        ),
      );

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.UNRESOLVED_COLLISION);
      assert.equal(claim?.organizationId, null);

      const events = await sql`SELECT * FROM "payment_reference_claim_events" WHERE "claim_id" = ${claimId}`;
      assert.equal(events.length, 0);
    });

    it('rejects autocommit executor without active transaction (TRANSACTION_REQUIRED)', async () => {
      await assert.rejects(
        () =>
          service.acquireProvisionalClaim(sql, {
            provider: PaymentProvider.MPESA,
            reference: 'REF_AUTOCOMMIT_BLOCK',
            organizationId: orgA,
          }),
        (err: any) => err instanceof HttpException && err.statusCode === 500 && err.code === 'TRANSACTION_REQUIRED',
      );
    });

    it('rolls back both claim mutation and audit event on mid-transaction error', async () => {
      const ref = 'REF_TX_ATOMIC_ROLLBACK_01';
      const payA = await createTestPayment(orgA, ref);

      await assert.rejects(
        () =>
          withTransaction(async (tx) => {
            await service.acquireProvisionalClaim(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgA,
              paymentId: payA,
            });
            throw new Error('SIMULATED_MID_TX_FAILURE');
          }),
        /SIMULATED_MID_TX_FAILURE/,
      );

      const claim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim, null);
      const events = await sql`SELECT * FROM "payment_reference_claim_events" WHERE "provider_reference" = ${ref}`;
      assert.equal(events.length, 0);
    });

    it('enforces RELEASED invariants and restricts deletion of claims and referenced payments', async () => {
      const ref = 'REF_RESTRICT_DEL_01';
      const payA = await createTestPayment(orgA, ref);
      const acq = await withTransaction((tx) =>
        service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgA,
          paymentId: payA,
        }),
      );

      // Cannot delete normalized_payments referenced by claim
      await assert.rejects(
        () => sql`DELETE FROM "normalized_payments" WHERE "id" = ${payA}`,
        /violates (?:RESTRICT setting of )?foreign key constraint/i,
      );

      // Cannot delete payment_reference_claims protected by RESTRICT on claim_events
      await assert.rejects(
        () => sql`DELETE FROM "payment_reference_claims" WHERE "id" = ${acq.claimId}`,
        /violates (?:RESTRICT setting of )?foreign key constraint/i,
      );

      // Move to DISPUTED -> release -> verify supplementary blocked on RELEASED
      const payB = await createTestPayment(orgB, ref);
      await sql`
        UPDATE "payment_reference_claims"
        SET "status" = 'DISPUTED'::"claim_status", "version" = "version" + 1
        WHERE "id" = ${acq.claimId}
      `;
      const rel = await withTransaction((tx) =>
        service.adjudicateCollision(tx, {
          claimId: acq.claimId,
          adjudicatorId: randomUUID(),
          rationale: 'Transaction confirmed cancelled by provider reconciliation report',
        }),
      );
      assert.equal(rel.status, ClaimStatus.RELEASED);

      const releasedClaim = await service.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(releasedClaim?.organizationId, null);
      assert.equal(releasedClaim?.paymentId, null);

      await assert.rejects(
        () =>
          withTransaction((tx) =>
            service.attachSupplementaryEvidence(tx, {
              provider: PaymentProvider.MPESA,
              reference: ref,
              organizationId: orgB,
              amountCents: 100000n,
              currency: 'TZS',
              rawEvidenceId: randomUUID(),
            }),
          ),
        (err: any) => err instanceof HttpException && err.statusCode === 409 && err.code === 'CLAIM_RELEASED',
      );

      // Org B can now freshly confirm on released claim in-place preserving claimId
      const confirmed = await withTransaction((tx) =>
        service.confirmProviderReference(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref,
          organizationId: orgB,
          checkoutId: randomUUID(),
          paymentId: payB,
          amountCents: 100000n,
          currency: 'TZS',
        }),
      );
      assert.equal(confirmed.claimId, acq.claimId);
      assert.equal(confirmed.status, ClaimStatus.CONFIRMED_PROVIDER);
    });
  });

  describe('16. Sweeper Concurrency and Deterministic Multi-Reference Advisory Locking', () => {
    it('sweeper skips references locked at Level 1 without blocking and expires unlocked lapsed claims', async () => {
      const busyRef = 'REF_SWEEP_BUSY_01';
      const freeRef = 'REF_SWEEP_FREE_01';
      const pay1 = await createTestPayment(orgA, busyRef);
      const pay2 = await createTestPayment(orgA, freeRef);
      const busyId = randomUUID();
      const freeId = randomUUID();

      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id", "payment_id",
          "status", "evidence_tier", "claimed_at", "expires_at"
        )
        VALUES
          (${busyId}, 'MPESA'::"PaymentProvider", ${busyRef}, ${orgA}, ${pay1}, 'PROVISIONAL'::"claim_status", 'CLIENT_REPORTED'::"claim_evidence_tier", CURRENT_TIMESTAMP - INTERVAL '3 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour'),
          (${freeId}, 'MPESA'::"PaymentProvider", ${freeRef}, ${orgA}, ${pay2}, 'PROVISIONAL'::"claim_status", 'CLIENT_REPORTED'::"claim_evidence_tier", CURRENT_TIMESTAMP - INTERVAL '3 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour')
      `;

      const holder = openIndependentClient();
      try {
        let markLocked!: () => void;
        let releaseHolder!: () => void;
        const lockedPromise = new Promise<void>((resolve) => { markLocked = resolve; });
        const releasePromise = new Promise<void>((resolve) => { releaseHolder = resolve; });

        const holderTx = holder.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || 'MPESA' || ':' || ${busyRef}))`;
          markLocked();
          await releasePromise;
        });

        await lockedPromise;

        const sweptCount = await withTransaction((tx) => service.expireProvisionalClaims(tx));
        assert.equal(sweptCount, 1);

        releaseHolder();
        await holderTx;

        const busyClaim = await service.getClaim(PaymentProvider.MPESA, busyRef);
        const freeClaim = await service.getClaim(PaymentProvider.MPESA, freeRef);
        assert.equal(busyClaim?.status, ClaimStatus.PROVISIONAL); // Skipped cleanly
        assert.equal(freeClaim?.status, ClaimStatus.EXPIRED); // Expired cleanly
      } finally {
        await holder.close();
      }
    });

    it('acquires multi-reference advisory locks in canonical ascending order without deadlock across opposing batches', async () => {
      const refsA = [
        { provider: PaymentProvider.MPESA, reference: 'multi_z' },
        { provider: PaymentProvider.MPESA, reference: 'multi_a' },
      ];
      const refsB = [
        { provider: PaymentProvider.MPESA, reference: 'MULTI_A' },
        { provider: PaymentProvider.MPESA, reference: ' MULTI_Z ' },
      ];

      const [res1, res2] = await Promise.all([
        withTransaction((tx) => service.acquireAdvisoryLocksOrdered(tx, refsA)),
        withTransaction((tx) => service.acquireAdvisoryLocksOrdered(tx, refsB)),
      ]);

      assert.deepEqual(
        res1.map((r) => r.reference),
        ['MULTI_A', 'MULTI_Z'],
      );
      assert.deepEqual(
        res2.map((r) => r.reference),
        ['MULTI_A', 'MULTI_Z'],
      );
    });
  });

  describe('17. Deadlock (40P01) & Serialization Failure (40001) Retry Without Duplicate Events', () => {
    it('forbids wrapping an existing caller transaction in executeWithSerializationRetry', async () => {
      await assert.rejects(
        () =>
          withTransaction((tx) =>
            service.executeWithSerializationRetry(
              async () => 'should-fail',
              { existingTx: tx },
            ),
          ),
        (err: any) => err instanceof HttpException && err.statusCode === 500 && err.code === 'NESTED_TRANSACTION_RETRY_FORBIDDEN',
      );
    });

    it('retries real PostgreSQL 40001 serialization conflict cleanly without duplicating claim events', async () => {
      const ref1 = 'REF_SERIAL_A';
      const ref2 = 'REF_SERIAL_B';
      await createTestPayment(orgA, ref1);
      await createTestPayment(orgB, ref2);

      // Seed both rows so SERIALIZABLE predicate/row conflict can occur reliably
      await withTransaction((tx) =>
        service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref1,
          organizationId: orgA,
        }),
      );
      await withTransaction((tx) =>
        service.acquireProvisionalClaim(tx, {
          provider: PaymentProvider.MPESA,
          reference: ref2,
          organizationId: orgB,
        }),
      );

      // Barrier ensuring both SERIALIZABLE transactions take overlapping snapshots before committing
      let bothRead!: () => void;
      let readCount = 0;
      const barrier = new Promise<void>((resolve) => { bothRead = resolve; });
      let tx1Attempts = 0;
      let tx2Attempts = 0;

      const runTx1 = service.executeWithSerializationRetry(
        async (tx, attempt) => {
          tx1Attempts = attempt;
          await tx`SELECT * FROM "payment_reference_claims" WHERE "provider_reference" = ${ref2}`;
          if (attempt === 1) {
            readCount++;
            if (readCount === 2) bothRead();
            await barrier;
          }
          return service.confirmProviderReference(tx, {
            provider: PaymentProvider.MPESA,
            reference: ref1,
            organizationId: orgA,
            checkoutId: randomUUID(),
            amountCents: 100000n,
            currency: 'TZS',
          });
        },
        { isolationLevel: 'SERIALIZABLE', maxAttempts: 5, baseDelayMs: 10 },
      );

      const runTx2 = service.executeWithSerializationRetry(
        async (tx, attempt) => {
          tx2Attempts = attempt;
          await tx`SELECT * FROM "payment_reference_claims" WHERE "provider_reference" = ${ref1}`;
          if (attempt === 1) {
            readCount++;
            if (readCount === 2) bothRead();
            await barrier;
          }
          return service.confirmProviderReference(tx, {
            provider: PaymentProvider.MPESA,
            reference: ref2,
            organizationId: orgB,
            checkoutId: randomUUID(),
            amountCents: 100000n,
            currency: 'TZS',
          });
        },
        { isolationLevel: 'SERIALIZABLE', maxAttempts: 5, baseDelayMs: 10 },
      );

      const [r1, r2] = await Promise.all([runTx1, runTx2]);
      assert.equal(r1.status, ClaimStatus.CONFIRMED_PROVIDER);
      assert.equal(r2.status, ClaimStatus.CONFIRMED_PROVIDER);
      // At least one of the two concurrent rw-antidependency cycles must hit 40001 and retry!
      assert.ok(tx1Attempts > 1 || tx2Attempts > 1, `Expected serialization retry; attempts=(${tx1Attempts}, ${tx2Attempts})`);

      // Strictly 2 events per claim (1 PROVISIONALLY_CLAIMED + 1 CONFIRMED_PROVIDER): zero duplicate events from retry!
      const ev1 = await sql`SELECT * FROM "payment_reference_claim_events" WHERE "provider_reference" = ${ref1}`;
      const ev2 = await sql`SELECT * FROM "payment_reference_claim_events" WHERE "provider_reference" = ${ref2}`;
      assert.equal(ev1.length, 2);
      assert.equal(ev2.length, 2);
    });

    it('retries real PostgreSQL 40P01 deadlock cleanly without duplicating events', async () => {
      const refX = 'REF_DEADLOCK_X';
      const refY = 'REF_DEADLOCK_Y';
      const targetRef = 'REF_DEADLOCK_OUTCOME';
      await createTestPayment(orgA, refX);
      await createTestPayment(orgB, refY);
      await createTestPayment(orgA, targetRef);

      let lockedBothFirst!: () => void;
      let firstStepCount = 0;
      const syncFirstStep = new Promise<void>((resolve) => { lockedBothFirst = resolve; });

      let attempts1 = 0;
      let attempts2 = 0;

      // Intentionally acquire opposite advisory lock orders on first attempt only to provoke 40P01 deadlock
      const t1 = service.executeWithSerializationRetry(
        async (tx, attempt) => {
          attempts1 = attempt;
          if (attempt === 1) {
            await tx`SELECT pg_advisory_xact_lock(hashtext('dl:' || ${refX}))`;
            firstStepCount++;
            if (firstStepCount === 2) lockedBothFirst();
            await syncFirstStep;
            await tx`SELECT pg_advisory_xact_lock(hashtext('dl:' || ${refY}))`;
          }
          return service.acquireProvisionalClaim(tx, {
            provider: PaymentProvider.MPESA,
            reference: targetRef,
            organizationId: orgA,
          });
        },
        { maxAttempts: 5, baseDelayMs: 15 },
      );

      const t2 = service.executeWithSerializationRetry(
        async (tx, attempt) => {
          attempts2 = attempt;
          if (attempt === 1) {
            await tx`SELECT pg_advisory_xact_lock(hashtext('dl:' || ${refY}))`;
            firstStepCount++;
            if (firstStepCount === 2) lockedBothFirst();
            await syncFirstStep;
            await tx`SELECT pg_advisory_xact_lock(hashtext('dl:' || ${refX}))`;
          }
          // Same org retry to verify idempotency and exact event uniqueness
          return service.acquireProvisionalClaim(tx, {
            provider: PaymentProvider.MPESA,
            reference: targetRef,
            organizationId: orgA,
          });
        },
        { maxAttempts: 5, baseDelayMs: 15 },
      );

      await Promise.all([t1, t2]);
      assert.ok(attempts1 > 1 || attempts2 > 1, `Expected 40P01 deadlock retry; attempts=(${attempts1}, ${attempts2})`);

      const events = await sql`SELECT * FROM "payment_reference_claim_events" WHERE "provider_reference" = ${targetRef}`;
      assert.equal(events.length, 1);
    });
  });

  describe('18. Independent Multi-Connection Concurrency Races', () => {
    it('serializes competing STK checkouts, companion SMS, and callbacks across distinct PostgreSQL connections', async () => {
      const refStk = 'REF_INDEP_STK_01';
      const refMix = 'REF_INDEP_MIX_01';
      const clients = Array.from({ length: 4 }, () => openIndependentClient());

      try {
        // Race 1: Two independent DB connections racing two different STK checkouts on same ref
        const stkOutcomes = await Promise.all([
          clients[0]!.begin((tx) =>
            service.confirmProviderReference(tx, {
              provider: PaymentProvider.MPESA,
              reference: refStk,
              organizationId: orgA,
              checkoutId: randomUUID(),
              amountCents: 100000n,
              currency: 'TZS',
            }),
          ).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })),
          clients[1]!.begin((tx) =>
            service.confirmProviderReference(tx, {
              provider: PaymentProvider.MPESA,
              reference: refStk,
              organizationId: orgB,
              checkoutId: randomUUID(),
              amountCents: 100000n,
              currency: 'TZS',
            }),
          ).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })),
        ]);

        const stkWins = stkOutcomes.filter((o) => o.ok);
        const stkLosses = stkOutcomes.filter((o) => !o.ok);
        assert.equal(stkWins.length, 1);
        assert.equal(stkLosses.length, 1);
        assert.equal((stkLosses[0] as any).e?.code, 'REFERENCE_ALREADY_SETTLED');

        // Race 2: Companion SMS (Org B) vs Authoritative STK callback (Org A) across independent connections
        const paySmsB = await createTestPayment(orgB, refMix);
        const payStkA = await createTestPayment(orgA, refMix);

        const mixOutcomes = await Promise.all([
          clients[2]!.begin((tx) =>
            service.acquireProvisionalClaim(tx, {
              provider: PaymentProvider.MPESA,
              reference: '  ' + refMix.toLowerCase() + ' ',
              organizationId: orgB,
              paymentId: paySmsB,
            }),
          ).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })),
          clients[3]!.begin((tx) =>
            service.confirmProviderReference(tx, {
              provider: PaymentProvider.MPESA,
              reference: refMix,
              organizationId: orgA,
              checkoutId: randomUUID(),
              paymentId: payStkA,
              amountCents: 100000n,
              currency: 'TZS',
            }),
          ).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })),
        ]);

        const stkRes = mixOutcomes[1]!;
        assert.equal(stkRes.ok, true);
        assert.equal((stkRes as any).v.status, ClaimStatus.CONFIRMED_PROVIDER);

        // Final persistent truth: Org A owns CONFIRMED_PROVIDER regardless of execution interleaving
        const finalClaim = await service.getClaim(PaymentProvider.MPESA, refMix);
        assert.equal(finalClaim?.organizationId, orgA);
        assert.equal(finalClaim?.status, ClaimStatus.CONFIRMED_PROVIDER);
      } finally {
        await Promise.all(clients.map((c) => c.close()));
      }
    });
  });
});
