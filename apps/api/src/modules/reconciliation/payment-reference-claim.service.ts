import { randomUUID } from 'node:crypto';
import {
  AcquireClaimLockTarget,
  AcquireProvisionalClaimParams,
  AdjudicateCollisionParams,
  AttachSupplementaryEvidenceParams,
  ClaimEventAction,
  ClaimEvidenceTier,
  ClaimStatus,
  ClaimTransitionResult,
  ConfirmProviderReferenceParams,
  HoldingTenantFinancialState,
  PaymentProvider,
  PaymentReferenceClaimRecord,
  PaymentVerificationState,
  SerializationRetryOptions,
  TransactionState,
  TransferProvisionalOwnershipParams,
} from '@brisksms/shared';
import { SqlExecutor, db, sql, withTransaction } from '@brisksms/db';
import { HttpException } from '../../core/http.js';

const VALID_PAYMENT_PROVIDERS = new Set<string>(Object.values(PaymentProvider));
const CANONICAL_REFERENCE_PATTERN = /^[\x21-\x7E]{1,100}$/;
const SETTLED_PAYMENT_STATES = new Set<string>([
  TransactionState.VERIFIED,
  TransactionState.FULFILLMENT_PENDING,
  TransactionState.FULFILLED,
  TransactionState.FULFILLMENT_FAILED,
]);
const SETTLED_PAYMENT_STATES_CSV = Array.from(SETTLED_PAYMENT_STATES).join(',');

const RETRYABLE_PG_CODES = new Set<string>(['40P01', '40001']);
const PG_SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function extractPgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const obj = err as { code?: unknown; errno?: unknown; cause?: unknown };
  // Bun.SQL sets code = 'ERR_POSTGRES_SERVER_ERROR' and puts the 5-char SQLSTATE in errno
  if (typeof obj.errno === 'string' && PG_SQLSTATE_PATTERN.test(obj.errno)) {
    return obj.errno;
  }
  if (typeof obj.code === 'string' && PG_SQLSTATE_PATTERN.test(obj.code)) {
    return obj.code;
  }
  if (obj.cause) {
    return extractPgErrorCode(obj.cause);
  }
  return undefined;
}

/**
 * Universal Global Payment Reference Claim Service
 * Defined in docs/reports/P0_2_UNIFIED_PAYMENT_REFERENCE_CLAIM_DESIGN.md
 *
 * Lock acquisition hierarchy (caller-owned explicit SQL transaction required on all mutations):
 *   Level 1: Global Reference Advisory Lock (pg_advisory_xact_lock on canonical provider + reference)
 *   Level 2: Canonical Claim Row Lock (payment_reference_claims FOR UPDATE)
 *   Level 3: Checkout Lock (stk_push_transactions FOR UPDATE, owned by STK caller before/around claim calls)
 *   Level 4: Tenant Normalized Payments Locks (normalized_payments ORDER BY id ASC FOR UPDATE)
 *   Level 5: Tenant Accounting / Settlement Locks (payment_verifications, invoice_payments, invoices FOR UPDATE)
 *   Level 6: Collision Quarantine Row Lock (payment_reference_claim_collisions FOR UPDATE)
 *
 * Note: Ascending lock acquisition order prevents many multi-reference deadlocks,
 * but cannot mathematically rule out every deadlock or SERIALIZABLE anomaly when callers
 * compose external locks or interleaved sequences; callers performing multi-step flows
 * should use executeWithSerializationRetry without an existing outer transaction.
 */
export class PaymentReferenceClaimService {
  /**
   * Normalizes and validates provider identifiers against the canonical PaymentProvider enum.
   */
  public normalizeProvider(provider: PaymentProvider | string): PaymentProvider {
    if (!provider || typeof provider !== 'string') {
      throw new HttpException(400, 'INVALID_PAYMENT_PROVIDER', 'Payment provider must be a non-empty string.');
    }
    const normalized = provider.trim().toUpperCase();
    if (!VALID_PAYMENT_PROVIDERS.has(normalized)) {
      throw new HttpException(
        400,
        'INVALID_PAYMENT_PROVIDER',
        `Unsupported payment provider '${provider}'.`,
      );
    }
    return normalized as PaymentProvider;
  }

  /**
   * Normalizes provider references by outer-trimming and uppercasing.
   * Fails closed on empty, whitespace-containing, oversized (>100), or control-character inputs.
   */
  public normalizeReference(reference: string): string {
    if (!reference || typeof reference !== 'string') {
      throw new HttpException(400, 'INVALID_PAYMENT_REFERENCE', 'Payment reference must be a non-empty string');
    }
    const trimmed = reference.trim();
    if (!trimmed) {
      throw new HttpException(400, 'INVALID_PAYMENT_REFERENCE', 'Payment reference must be a non-empty string');
    }
    const normalized = trimmed.toUpperCase();
    if (normalized.length > 100 || !CANONICAL_REFERENCE_PATTERN.test(normalized)) {
      throw new HttpException(
        400,
        'INVALID_PAYMENT_REFERENCE',
        'Payment reference contains invalid whitespace or non-printable characters or exceeds 100 characters.',
      );
    }
    return normalized;
  }

  /**
   * Verifies that the supplied executor is bound to an active explicit PostgreSQL transaction.
   * Prevents pg_advisory_xact_lock from silently releasing immediately under autocommit.
   */
  public async assertActiveTransaction(tx: SqlExecutor): Promise<void> {
    if (!tx || typeof tx !== 'function' || tx === sql || tx === (db as unknown)) {
      throw new HttpException(
        500,
        'TRANSACTION_REQUIRED',
        'Claim service mutations require an explicit caller-owned SQL transaction.',
      );
    }

    try {
      if (tx.unsafe) {
        await tx.unsafe('SAVEPOINT brisk_claim_tx_guard');
        await tx.unsafe('RELEASE SAVEPOINT brisk_claim_tx_guard');
      } else {
        await tx`SAVEPOINT brisk_claim_tx_guard`;
        await tx`RELEASE SAVEPOINT brisk_claim_tx_guard`;
      }
    } catch (err) {
      const pgCode = extractPgErrorCode(err);
      const message = err instanceof Error ? err.message : '';
      if (pgCode === '25P01' || /can only be used in transaction blocks/i.test(message)) {
        throw new HttpException(
          500,
          'TRANSACTION_REQUIRED',
          'Claim service mutations must execute inside an active BEGIN/COMMIT PostgreSQL transaction.',
        );
      }
      throw err;
    }
  }

  /**
   * Acquires Level 1 advisory locks for multiple (provider, reference) targets in a deterministic
   * ascending canonical order within the caller's active transaction.
   */
  public async acquireAdvisoryLocksOrdered(
    tx: SqlExecutor,
    targets: ReadonlyArray<AcquireClaimLockTarget>,
  ): Promise<Array<{ provider: PaymentProvider; reference: string }>> {
    await this.assertActiveTransaction(tx);

    const uniqueMap = new Map<string, { provider: PaymentProvider; reference: string }>();
    for (const target of targets) {
      const normProvider = this.normalizeProvider(target.provider);
      const normRef = this.normalizeReference(target.reference);
      const mapKey = `${normProvider}\0${normRef}`;
      if (!uniqueMap.has(mapKey)) {
        uniqueMap.set(mapKey, { provider: normProvider, reference: normRef });
      }
    }

    const sorted = Array.from(uniqueMap.values()).sort((a, b) => {
      if (a.provider !== b.provider) {
        return a.provider < b.provider ? -1 : 1;
      }
      if (a.reference !== b.reference) {
        return a.reference < b.reference ? -1 : 1;
      }
      return 0;
    });

    for (const item of sorted) {
      await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${item.provider} || ':' || ${item.reference}))`;
    }

    return sorted;
  }

  /**
   * Executes a claim transaction with explicit transaction ownership and bounded retries
   * on PostgreSQL deadlocks (40P01) or serialization failures (40001).
   * Rejects nested caller transactions to guarantee full rollback before each retry attempt,
   * preventing duplicate claim events or partial side effects.
   */
  public async executeWithSerializationRetry<T>(
    operation: (tx: SqlExecutor, attempt: number) => Promise<T>,
    options: SerializationRetryOptions & { existingTx?: SqlExecutor } = {},
  ): Promise<T> {
    if (options.existingTx) {
      throw new HttpException(
        500,
        'NESTED_TRANSACTION_RETRY_FORBIDDEN',
        'Serialization retry wrapper owns the top-level transaction and cannot wrap an existing caller transaction.',
      );
    }

    const maxAttempts = options.maxAttempts ?? 4;
    const baseDelayMs = options.baseDelayMs ?? 15;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new HttpException(400, 'INVALID_RETRY_CONFIGURATION', 'maxAttempts must be a positive integer.');
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await withTransaction(async (tx) => {
          if (options.isolationLevel && options.isolationLevel !== 'READ COMMITTED') {
            if (!tx.unsafe) {
              throw new HttpException(
                500,
                'TRANSACTION_ISOLATION_UNSUPPORTED',
                'Transaction executor does not support isolation level configuration.',
              );
            }
            await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
          }
          return await operation(tx, attempt);
        });
      } catch (err) {
        lastError = err;
        const pgCode = extractPgErrorCode(err);
        if (!pgCode || !RETRYABLE_PG_CODES.has(pgCode) || attempt === maxAttempts) {
          throw err;
        }
        const jitterMs = Math.floor(Math.random() * baseDelayMs);
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt + jitterMs));
      }
    }

    throw lastError;
  }

  private assertNonEmptyId(value: string | undefined | null, fieldName: string, errorCode: string): string {
    if (!value || typeof value !== 'string' || !value.trim()) {
      throw new HttpException(400, errorCode, `${fieldName} must be a non-empty identifier.`);
    }
    return value.trim();
  }

  private async lockClaimByCanonicalKey(
    tx: SqlExecutor,
    provider: PaymentProvider,
    normRef: string,
  ): Promise<any[]> {
    return tx`
      SELECT *, ("expires_at" IS NOT NULL AND "expires_at" <= CURRENT_TIMESTAMP) AS "is_expired"
      FROM "payment_reference_claims"
      WHERE "provider" = ${provider}::"PaymentProvider"
        AND "provider_reference" = ${normRef}
      FOR UPDATE
    `;
  }

  /**
   * Level 1 + Level 2 lock acquisition.
   * Acquires provisional reservation for companion SMS within a caller-owned transaction.
   * Throws 409 REFERENCE_CLAIMED_BY_ANOTHER_ORG if actively held by another org.
   * Throws 409 COLLISION_QUARANTINED if claim is UNRESOLVED_COLLISION.
   * Throws 409 CROSS_TENANT_DISPUTE if claim is DISPUTED.
   */
  public async acquireProvisionalClaim(
    tx: SqlExecutor,
    params: AcquireProvisionalClaimParams,
  ): Promise<ClaimTransitionResult> {
    await this.assertActiveTransaction(tx);
    const normProvider = this.normalizeProvider(params.provider);
    const normRef = this.normalizeReference(params.reference);
    const orgId = this.assertNonEmptyId(params.organizationId, 'organizationId', 'INVALID_ORGANIZATION_ID');
    const holdMs = params.holdDurationMs ?? 2 * 60 * 60 * 1000;
    if (!Number.isFinite(holdMs) || holdMs <= 0) {
      throw new HttpException(400, 'INVALID_HOLD_DURATION', 'holdDurationMs must be a positive finite number.');
    }

    // Level 1: Global Reference Advisory Lock
    await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${normProvider} || ':' || ${normRef}))`;

    // Level 2: Claim Row Lock
    const existing = await this.lockClaimByCanonicalKey(tx, normProvider, normRef);

    if (existing.length === 0) {
      const claimId = randomUUID();
      const expiresAt = new Date(Date.now() + holdMs);

      await tx`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id",
          "payment_id", "status", "evidence_tier", "claimed_at", "expires_at", "version"
        )
        VALUES (
          ${claimId},
          ${normProvider}::"PaymentProvider",
          ${normRef},
          ${orgId},
          ${params.paymentId ?? null},
          ${ClaimStatus.PROVISIONAL}::"claim_status",
          ${ClaimEvidenceTier.CLIENT_REPORTED}::"claim_evidence_tier",
          CURRENT_TIMESTAMP,
          ${expiresAt},
          1
        )
      `;

      await this.recordEvent(tx, {
        claimId,
        provider: normProvider,
        providerReference: normRef,
        organizationId: orgId,
        action: ClaimEventAction.PROVISIONALLY_CLAIMED,
        previousStatus: null,
        newStatus: ClaimStatus.PROVISIONAL,
        evidenceTier: ClaimEvidenceTier.CLIENT_REPORTED,
        evidenceId: params.paymentId ?? null,
        reason: 'Initial provisional claim acquired via companion ingestion',
      });

      return {
        outcome: 'CLAIM_ACQUIRED',
        claimId,
        status: ClaimStatus.PROVISIONAL,
        paymentId: params.paymentId ?? undefined,
      };
    }

    const claim = existing[0]!;

    if (claim.status === ClaimStatus.UNRESOLVED_COLLISION) {
      throw new HttpException(
        409,
        'COLLISION_QUARANTINED',
        `Reference '${normRef}' for provider '${normProvider}' is quarantined under an unresolved multi-tenant collision.`,
      );
    }

    if (claim.status === ClaimStatus.DISPUTED) {
      throw new HttpException(
        409,
        'CROSS_TENANT_DISPUTE',
        `Reference '${normRef}' for provider '${normProvider}' is locked in an active dispute.`,
      );
    }

    if (claim.status === ClaimStatus.CONFIRMED_PROVIDER) {
      if (claim.organization_id === orgId) {
        return {
          outcome: 'SUPPLEMENTARY_MATCH',
          claimId: claim.id,
          status: ClaimStatus.CONFIRMED_PROVIDER,
          paymentId: claim.payment_id ?? undefined,
        };
      }
      throw new HttpException(
        409,
        'REFERENCE_ALREADY_SETTLED',
        `Provider reference '${normRef}' has already been settled and confirmed by another organization.`,
        { settledOrganizationId: claim.organization_id },
      );
    }

    if (claim.status === ClaimStatus.RELEASED) {
      const expiresAt = new Date(Date.now() + holdMs);
      const newVersion = (claim.version || 1) + 1;

      await tx`
        UPDATE "payment_reference_claims"
        SET
          "organization_id" = ${orgId},
          "checkout_id" = NULL,
          "payment_id" = ${params.paymentId ?? null},
          "status" = ${ClaimStatus.PROVISIONAL}::"claim_status",
          "evidence_tier" = ${ClaimEvidenceTier.CLIENT_REPORTED}::"claim_evidence_tier",
          "claimed_at" = CURRENT_TIMESTAMP,
          "expires_at" = ${expiresAt},
          "confirmed_at" = NULL,
          "confirmed_by_id" = NULL,
          "release_reason" = NULL,
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      await this.recordEvent(tx, {
        claimId: claim.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: orgId,
        action: ClaimEventAction.PROVISIONALLY_CLAIMED,
        previousStatus: ClaimStatus.RELEASED,
        newStatus: ClaimStatus.PROVISIONAL,
        evidenceTier: ClaimEvidenceTier.CLIENT_REPORTED,
        evidenceId: params.paymentId ?? null,
        reason: 'Reclaimed previously released reference slot',
      });

      return {
        outcome: 'RECLAIMED_IN_PLACE',
        claimId: claim.id,
        status: ClaimStatus.PROVISIONAL,
        paymentId: params.paymentId ?? undefined,
      };
    }

    if (claim.status === ClaimStatus.EXPIRED) {
      if (claim.organization_id === orgId) {
        const expiresAt = new Date(Date.now() + holdMs);
        const newVersion = (claim.version || 1) + 1;
        const resolvedPaymentId = params.paymentId ?? claim.payment_id ?? null;

        await tx`
          UPDATE "payment_reference_claims"
          SET
            "payment_id" = ${resolvedPaymentId},
            "status" = ${ClaimStatus.PROVISIONAL}::"claim_status",
            "claimed_at" = CURRENT_TIMESTAMP,
            "expires_at" = ${expiresAt},
            "version" = ${newVersion},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${claim.id}
        `;

        await this.recordEvent(tx, {
          claimId: claim.id,
          provider: normProvider,
          providerReference: normRef,
          organizationId: orgId,
          action: ClaimEventAction.PROVISIONALLY_CLAIMED,
          previousStatus: ClaimStatus.EXPIRED,
          newStatus: ClaimStatus.PROVISIONAL,
          evidenceTier: ClaimEvidenceTier.CLIENT_REPORTED,
          evidenceId: resolvedPaymentId,
          reason: 'Same organization refreshed expired provisional claim',
        });

        return {
          outcome: 'RECLAIMED_IN_PLACE',
          claimId: claim.id,
          status: ClaimStatus.PROVISIONAL,
          paymentId: resolvedPaymentId ?? undefined,
        };
      }

      // Competing organization attempts to grab expired claim of another tenant via SMS!
      // Anti-theft invariant: Flag as DISPUTED and freeze settlement.
      const newVersion = (claim.version || 1) + 1;
      await tx`
        UPDATE "payment_reference_claims"
        SET
          "status" = ${ClaimStatus.DISPUTED}::"claim_status",
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      await this.recordEvent(tx, {
        claimId: claim.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: orgId,
        action: ClaimEventAction.DISPUTE_RAISED,
        previousStatus: ClaimStatus.EXPIRED,
        newStatus: ClaimStatus.DISPUTED,
        evidenceTier: ClaimEvidenceTier.CLIENT_REPORTED,
        evidenceId: params.paymentId ?? null,
        reason: `Cross-tenant ingestion collision: Org '${orgId}' attempted to claim expired reference of Org '${claim.organization_id}'`,
      });

      return {
        outcome: 'DISPUTE_RAISED',
        claimId: claim.id,
        status: ClaimStatus.DISPUTED,
      };
    }

    if (claim.status === ClaimStatus.PROVISIONAL) {
      if (claim.organization_id === orgId) {
        if (params.paymentId && claim.payment_id === params.paymentId) {
          return {
            outcome: 'CLAIM_ACQUIRED',
            claimId: claim.id,
            status: ClaimStatus.PROVISIONAL,
            paymentId: claim.payment_id,
          };
        }
        return {
          outcome: 'SUPPLEMENTARY_MATCH',
          claimId: claim.id,
          status: ClaimStatus.PROVISIONAL,
          paymentId: claim.payment_id ?? undefined,
        };
      }

      if (!claim.is_expired) {
        throw new HttpException(
          409,
          'REFERENCE_CLAIMED_BY_ANOTHER_ORG',
          `Provider reference '${normRef}' is actively reserved by another organization.`,
          { claimingOrganizationId: claim.organization_id },
        );
      }

      // Window lapsed in PostgreSQL clock before sweeper transitioned it
      const newVersion = (claim.version || 1) + 1;
      await tx`
        UPDATE "payment_reference_claims"
        SET
          "status" = ${ClaimStatus.DISPUTED}::"claim_status",
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      await this.recordEvent(tx, {
        claimId: claim.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: orgId,
        action: ClaimEventAction.DISPUTE_RAISED,
        previousStatus: ClaimStatus.PROVISIONAL,
        newStatus: ClaimStatus.DISPUTED,
        evidenceTier: ClaimEvidenceTier.CLIENT_REPORTED,
        evidenceId: params.paymentId ?? null,
        reason: `Cross-tenant ingestion collision: Org '${orgId}' attempted to claim lapsed provisional reference of Org '${claim.organization_id}'`,
      });

      return {
        outcome: 'DISPUTE_RAISED',
        claimId: claim.id,
        status: ClaimStatus.DISPUTED,
      };
    }

    throw new HttpException(500, 'UNHANDLED_CLAIM_STATE', `Unknown claim status '${claim.status}'`);
  }

  /**
   * Correlates secondary client evidence against an existing active claim.
   * Level 1 -> Level 2 -> Level 4 lock order.
   */
  public async attachSupplementaryEvidence(
    tx: SqlExecutor,
    params: AttachSupplementaryEvidenceParams,
  ): Promise<ClaimTransitionResult> {
    await this.assertActiveTransaction(tx);
    const normProvider = this.normalizeProvider(params.provider);
    const normRef = this.normalizeReference(params.reference);
    const orgId = this.assertNonEmptyId(params.organizationId, 'organizationId', 'INVALID_ORGANIZATION_ID');
    const rawEvidenceId = this.assertNonEmptyId(params.rawEvidenceId, 'rawEvidenceId', 'INVALID_EVIDENCE_ID');

    // Level 1: Advisory Lock
    await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${normProvider} || ':' || ${normRef}))`;

    // Level 2: Claim Lock
    const existing = await this.lockClaimByCanonicalKey(tx, normProvider, normRef);

    if (existing.length === 0) {
      throw new HttpException(404, 'CLAIM_NOT_FOUND', `No claim found for provider reference '${normRef}'.`);
    }

    const claim = existing[0]!;

    if (claim.status === ClaimStatus.UNRESOLVED_COLLISION) {
      throw new HttpException(
        409,
        'COLLISION_QUARANTINED',
        `Reference '${normRef}' for provider '${normProvider}' is quarantined under an unresolved multi-tenant collision.`,
      );
    }

    if (claim.status === ClaimStatus.DISPUTED) {
      throw new HttpException(
        409,
        'CROSS_TENANT_DISPUTE',
        `Reference '${normRef}' for provider '${normProvider}' is locked in an active dispute.`,
      );
    }

    if (claim.status === ClaimStatus.RELEASED) {
      throw new HttpException(
        409,
        'CLAIM_RELEASED',
        `Reference '${normRef}' was formally released and must be freshly claimed before attaching supplementary evidence.`,
      );
    }

    if (claim.organization_id !== orgId) {
      throw new HttpException(
        409,
        'REFERENCE_CLAIMED_BY_ANOTHER_ORG',
        `Provider reference '${normRef}' belongs to another organization.`,
        { claimingOrganizationId: claim.organization_id },
      );
    }

    // Level 4: Deterministically lock all matching tenant payments (ascending UUID order)
    await tx`
      SELECT "id" FROM "normalized_payments"
      WHERE "organization_id" = ${orgId}
        AND (
          "id" = ${claim.payment_id ?? null}
          OR ("provider" = ${normProvider}::"PaymentProvider" AND UPPER(BTRIM("reference")) = ${normRef})
        )
      ORDER BY "id" ASC
      FOR UPDATE
    `;

    await this.recordEvent(tx, {
      claimId: claim.id,
      provider: normProvider,
      providerReference: normRef,
      organizationId: orgId,
      action: ClaimEventAction.SUPPLEMENTARY_ATTACHED,
      previousStatus: claim.status,
      newStatus: claim.status,
      evidenceTier: ClaimEvidenceTier.CLIENT_REPORTED,
      evidenceId: rawEvidenceId,
      reason: 'Supplementary client evidence attached',
      metadata: {
        amountCents: params.amountCents.toString(),
        currency: params.currency,
        senderPhone: params.senderPhone ?? null,
      },
    });

    return {
      outcome: 'SUPPLEMENTARY_MATCH',
      claimId: claim.id,
      status: claim.status,
      paymentId: claim.payment_id ?? undefined,
    };
  }

  /**
   * Evaluates whether the provisional/expired holding organization has ANY human-attested,
   * verified, settled, fulfilled, or accounting-backed evidence for this canonical reference.
   * Executes under Level 1 -> Level 2 -> Level 4 -> Level 5 lock order.
   *
   * Never evicts or silently reverses human-attested or settled tenant records.
   */
  private async resolveCrossTenantProvisionalConflict(
    tx: SqlExecutor,
    options: {
      claim: any;
      normProvider: PaymentProvider;
      normRef: string;
      targetOrganizationId: string;
      targetCheckoutId?: string;
      targetPaymentId?: string;
      holdingTenantEvidence?: HoldingTenantFinancialState;
      triggerSource: 'PROVIDER_CALLBACK' | 'OWNERSHIP_TRANSFER';
    },
  ): Promise<ClaimTransitionResult> {
    const {
      claim,
      normProvider,
      normRef,
      targetOrganizationId,
      targetCheckoutId,
      targetPaymentId,
      holdingTenantEvidence,
      triggerSource,
    } = options;
    const holdingOrgId = claim.organization_id as string;

    // Level 4: Lock ALL tenant payments for holdingOrgId matching either claim.payment_id or canonical ref
    const holdingPayments = await tx`
      SELECT "id", "state", "verified_at", "verified_by_id", "review_reason"
      FROM "normalized_payments"
      WHERE "organization_id" = ${holdingOrgId}
        AND (
          "id" = ${claim.payment_id ?? null}
          OR ("provider" = ${normProvider}::"PaymentProvider" AND UPPER(BTRIM("reference")) = ${normRef})
        )
      ORDER BY "id" ASC
      FOR UPDATE
    `;

    const holdingPaymentIds = holdingPayments.map((p) => p.id as string);
    const holdingPaymentIdsCsv = holdingPaymentIds.join(',');

    // Level 5: Inspect & lock immutable verifications and invoice_payments linked to those payments
    const approvedVerifications =
      holdingPaymentIds.length > 0
        ? await tx`
            SELECT "id", "payment_id", "decision", "verification_method", "new_state"
            FROM "payment_verifications"
            WHERE "organization_id" = ${holdingOrgId}
              AND "payment_id" = ANY(string_to_array(${holdingPaymentIdsCsv}, ',')::uuid[])
              AND (
                "decision" = 'APPROVED'
                OR "new_state"::text = ANY(string_to_array(${SETTLED_PAYMENT_STATES_CSV}, ',')::text[])
              )
            ORDER BY "id" ASC
            FOR UPDATE
          `
        : [];

    const invoicePayments =
      holdingPaymentIds.length > 0
        ? await tx`
            SELECT "id", "invoice_id", "payment_id", "applied_amount_cents"
            FROM "invoice_payments"
            WHERE "organization_id" = ${holdingOrgId}
              AND "payment_id" = ANY(string_to_array(${holdingPaymentIdsCsv}, ',')::uuid[])
            ORDER BY "id" ASC
            FOR UPDATE
          `
        : [];

    const settledPayments = holdingPayments.filter(
      (p) =>
        SETTLED_PAYMENT_STATES.has(p.state) ||
        p.verified_at !== null ||
        p.verified_by_id !== null,
    );

    const callerIndicatesAttestedOrSettled = Boolean(
      holdingTenantEvidence &&
        (holdingTenantEvidence.verificationState === PaymentVerificationState.HUMAN_ATTESTED ||
          holdingTenantEvidence.verificationState === PaymentVerificationState.PROVIDER_AUTHENTICATED ||
          holdingTenantEvidence.isHumanAttested === true ||
          holdingTenantEvidence.isSettled === true ||
          holdingTenantEvidence.hasAccountingEntry === true),
    );

    const hasProtectedFinancialState =
      callerIndicatesAttestedOrSettled ||
      settledPayments.length > 0 ||
      approvedVerifications.length > 0 ||
      invoicePayments.length > 0;

    const newVersion = (claim.version || 1) + 1;

    if (hasProtectedFinancialState) {
      // CRITICAL FINANCIAL BOUNDARY:
      // Holding tenant has human-attested, verified, fulfilled, or invoice-settled evidence.
      // NEVER evict ownership or reverse tenant books; escalate to DISPUTED.
      await tx`
        UPDATE "payment_reference_claims"
        SET
          "status" = ${ClaimStatus.DISPUTED}::"claim_status",
          "evidence_tier" = ${ClaimEvidenceTier.AUTHORITATIVE_PROVIDER}::"claim_evidence_tier",
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      // Annotate review notes cleanly without altering settled payment state or invoice balances
      if (holdingPaymentIds.length > 0) {
        await tx`
          UPDATE "normalized_payments"
          SET
            "review_reason" = CASE
              WHEN "review_reason" IS NULL OR BTRIM("review_reason") = ''
                THEN 'CROSS_TENANT_CARRIER_DISPUTE'
              WHEN "review_reason" LIKE '%CROSS_TENANT_CARRIER_DISPUTE%'
                THEN "review_reason"
              ELSE "review_reason" || ' | CROSS_TENANT_CARRIER_DISPUTE'
            END,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ANY(string_to_array(${holdingPaymentIdsCsv}, ',')::uuid[])
            AND "organization_id" = ${holdingOrgId}
        `;
      }

      await this.recordEvent(tx, {
        claimId: claim.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: targetOrganizationId,
        action: ClaimEventAction.DISPUTE_RAISED,
        previousStatus: claim.status,
        newStatus: ClaimStatus.DISPUTED,
        evidenceTier: ClaimEvidenceTier.AUTHORITATIVE_PROVIDER,
        evidenceId: targetPaymentId ?? null,
        reason: `Contradictory ${triggerSource === 'PROVIDER_CALLBACK' ? 'carrier callback' : 'ownership transfer'} for Org '${targetOrganizationId}' conflicts with attested/settled records of Org '${holdingOrgId}'`,
        metadata: {
          triggerSource,
          holdingOrganizationId: holdingOrgId,
          contradictingOrganizationId: targetOrganizationId,
          settledPaymentIds: settledPayments.map((p) => p.id),
          approvedVerificationIds: approvedVerifications.map((v) => v.id),
          invoicePaymentIds: invoicePayments.map((ip) => ip.id),
          callerProvidedEvidence: holdingTenantEvidence ?? null,
        },
      });

      return {
        outcome: 'DISPUTE_RAISED',
        claimId: claim.id,
        status: ClaimStatus.DISPUTED,
      };
    }

    // Safe eviction: holding organization only holds unverified candidate evidence.
    await tx`
      UPDATE "payment_reference_claims"
      SET
        "organization_id" = ${targetOrganizationId},
        "checkout_id" = ${targetCheckoutId ?? null},
        "payment_id" = ${targetPaymentId ?? null},
        "status" = ${ClaimStatus.CONFIRMED_PROVIDER}::"claim_status",
        "evidence_tier" = ${ClaimEvidenceTier.AUTHORITATIVE_PROVIDER}::"claim_evidence_tier",
        "expires_at" = NULL,
        "confirmed_at" = CURRENT_TIMESTAMP,
        "release_reason" = NULL,
        "version" = ${newVersion},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${claim.id}
    `;

    // Route all evicted org's unverified payments for this canonical reference to REVIEW_REQUIRED
    if (holdingPaymentIds.length > 0) {
      await tx`
        UPDATE "normalized_payments"
        SET
          "state" = ${TransactionState.REVIEW_REQUIRED}::"TransactionState",
          "review_reason" = 'CLAIM_SUPERSEDED: Contested reference claimed by another org',
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ANY(string_to_array(${holdingPaymentIdsCsv}, ',')::uuid[])
          AND "organization_id" = ${holdingOrgId}
          AND "state"::text <> ALL(string_to_array(${SETTLED_PAYMENT_STATES_CSV}, ',')::text[])
      `;
    }

    await this.recordEvent(tx, {
      claimId: claim.id,
      provider: normProvider,
      providerReference: normRef,
      organizationId: targetOrganizationId,
      action: ClaimEventAction.SUPERSEDED_EVICTION,
      previousStatus: claim.status,
      newStatus: ClaimStatus.CONFIRMED_PROVIDER,
      evidenceTier: ClaimEvidenceTier.AUTHORITATIVE_PROVIDER,
      evidenceId: targetPaymentId ?? null,
      reason: `Authoritative carrier confirmation evicted unconfirmed provisional claim of Org '${holdingOrgId}'`,
      metadata: {
        triggerSource,
        evictedOrganizationId: holdingOrgId,
        evictedPaymentIds: holdingPaymentIds,
        awardedOrganizationId: targetOrganizationId,
      },
    });

    return {
      outcome: 'SUPERSEDED_EVICTED',
      claimId: claim.id,
      status: ClaimStatus.CONFIRMED_PROVIDER,
      paymentId: targetPaymentId ?? undefined,
    };
  }

  /**
   * Confirms provider-authenticated carrier callback.
   * Permanent terminal state across all tenants.
   */
  public async confirmProviderReference(
    tx: SqlExecutor,
    params: ConfirmProviderReferenceParams,
  ): Promise<ClaimTransitionResult> {
    await this.assertActiveTransaction(tx);
    const normProvider = this.normalizeProvider(params.provider);
    const normRef = this.normalizeReference(params.reference);
    const orgId = this.assertNonEmptyId(params.organizationId, 'organizationId', 'INVALID_ORGANIZATION_ID');

    // Level 1: Global Reference Advisory Lock
    await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${normProvider} || ':' || ${normRef}))`;

    // Level 2: Claim Row Lock
    const existing = await this.lockClaimByCanonicalKey(tx, normProvider, normRef);

    if (existing.length === 0) {
      const claimId = randomUUID();
      await tx`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id",
          "checkout_id", "payment_id", "status", "evidence_tier",
          "claimed_at", "confirmed_at", "version"
        )
        VALUES (
          ${claimId},
          ${normProvider}::"PaymentProvider",
          ${normRef},
          ${orgId},
          ${params.checkoutId ?? null},
          ${params.paymentId ?? null},
          ${ClaimStatus.CONFIRMED_PROVIDER}::"claim_status",
          ${ClaimEvidenceTier.AUTHORITATIVE_PROVIDER}::"claim_evidence_tier",
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          1
        )
      `;

      await this.recordEvent(tx, {
        claimId,
        provider: normProvider,
        providerReference: normRef,
        organizationId: orgId,
        action: ClaimEventAction.CONFIRMED_PROVIDER,
        previousStatus: null,
        newStatus: ClaimStatus.CONFIRMED_PROVIDER,
        evidenceTier: ClaimEvidenceTier.AUTHORITATIVE_PROVIDER,
        evidenceId: params.paymentId ?? null,
        reason: 'Direct authoritative carrier callback confirmation',
      });

      return {
        outcome: 'CONFIRMED',
        claimId,
        status: ClaimStatus.CONFIRMED_PROVIDER,
        paymentId: params.paymentId ?? undefined,
      };
    }

    const claim = existing[0]!;

    if (claim.status === ClaimStatus.UNRESOLVED_COLLISION) {
      throw new HttpException(
        409,
        'COLLISION_QUARANTINED',
        `Reference '${normRef}' for provider '${normProvider}' is quarantined under an unresolved multi-tenant collision.`,
      );
    }

    if (claim.status === ClaimStatus.CONFIRMED_PROVIDER) {
      if (claim.organization_id === orgId) {
        if (params.checkoutId && claim.checkout_id && claim.checkout_id !== params.checkoutId) {
          throw new HttpException(
            409,
            'REFERENCE_ALREADY_USED',
            `Provider reference '${normRef}' has already been claimed on platform for another checkout.`,
          );
        }
        // Idempotent duplicate callback delivery — zero duplicate events
        return {
          outcome: 'CONFIRMED',
          claimId: claim.id,
          status: ClaimStatus.CONFIRMED_PROVIDER,
          paymentId: claim.payment_id ?? params.paymentId ?? undefined,
        };
      }
      throw new HttpException(
        409,
        'REFERENCE_ALREADY_SETTLED',
        `Provider reference '${normRef}' has already been settled and confirmed by another organization.`,
        { settledOrganizationId: claim.organization_id },
      );
    }

    if (claim.status === ClaimStatus.RELEASED) {
      const newVersion = (claim.version || 1) + 1;
      await tx`
        UPDATE "payment_reference_claims"
        SET
          "organization_id" = ${orgId},
          "checkout_id" = ${params.checkoutId ?? null},
          "payment_id" = ${params.paymentId ?? null},
          "status" = ${ClaimStatus.CONFIRMED_PROVIDER}::"claim_status",
          "evidence_tier" = ${ClaimEvidenceTier.AUTHORITATIVE_PROVIDER}::"claim_evidence_tier",
          "expires_at" = NULL,
          "confirmed_at" = CURRENT_TIMESTAMP,
          "release_reason" = NULL,
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      await this.recordEvent(tx, {
        claimId: claim.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: orgId,
        action: ClaimEventAction.CONFIRMED_PROVIDER,
        previousStatus: ClaimStatus.RELEASED,
        newStatus: ClaimStatus.CONFIRMED_PROVIDER,
        evidenceTier: ClaimEvidenceTier.AUTHORITATIVE_PROVIDER,
        evidenceId: params.paymentId ?? null,
        reason: 'Carrier confirmation on previously released reference',
      });

      return {
        outcome: 'CONFIRMED',
        claimId: claim.id,
        status: ClaimStatus.CONFIRMED_PROVIDER,
        paymentId: params.paymentId ?? undefined,
      };
    }

    if (claim.status === ClaimStatus.PROVISIONAL || claim.status === ClaimStatus.EXPIRED) {
      if (claim.organization_id === orgId) {
        const newVersion = (claim.version || 1) + 1;
        const resolvedPaymentId = params.paymentId ?? claim.payment_id ?? null;
        const resolvedCheckoutId = params.checkoutId ?? claim.checkout_id ?? null;

        await tx`
          UPDATE "payment_reference_claims"
          SET
            "checkout_id" = ${resolvedCheckoutId},
            "payment_id" = ${resolvedPaymentId},
            "status" = ${ClaimStatus.CONFIRMED_PROVIDER}::"claim_status",
            "evidence_tier" = ${ClaimEvidenceTier.AUTHORITATIVE_PROVIDER}::"claim_evidence_tier",
            "expires_at" = NULL,
            "confirmed_at" = CURRENT_TIMESTAMP,
            "release_reason" = NULL,
            "version" = ${newVersion},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${claim.id}
        `;

        await this.recordEvent(tx, {
          claimId: claim.id,
          provider: normProvider,
          providerReference: normRef,
          organizationId: orgId,
          action: ClaimEventAction.CONFIRMED_PROVIDER,
          previousStatus: claim.status,
          newStatus: ClaimStatus.CONFIRMED_PROVIDER,
          evidenceTier: ClaimEvidenceTier.AUTHORITATIVE_PROVIDER,
          evidenceId: resolvedPaymentId,
          reason: 'Authoritative carrier confirmation for provisional claim',
        });

        return {
          outcome: 'CONFIRMED',
          claimId: claim.id,
          status: ClaimStatus.CONFIRMED_PROVIDER,
          paymentId: resolvedPaymentId ?? undefined,
        };
      }

      return this.resolveCrossTenantProvisionalConflict(tx, {
        claim,
        normProvider,
        normRef,
        targetOrganizationId: orgId,
        targetCheckoutId: params.checkoutId,
        targetPaymentId: params.paymentId,
        holdingTenantEvidence: params.holdingTenantEvidence,
        triggerSource: 'PROVIDER_CALLBACK',
      });
    }

    if (claim.status === ClaimStatus.DISPUTED) {
      throw new HttpException(
        409,
        'CROSS_TENANT_DISPUTE',
        `Reference '${normRef}' for provider '${normProvider}' is in active dispute.`,
      );
    }

    throw new HttpException(500, 'UNHANDLED_CLAIM_STATE', `Unknown claim status '${claim.status}'`);
  }

  /**
   * Transfers ownership of an unconfirmed provisional/expired claim to an authoritative carrier holder.
   * Rejects or routes to DISPUTED whenever the current claim holder has human-attested, verified,
   * fulfilled, or invoice-settled tenant evidence.
   */
  public async transferProvisionalOwnership(
    tx: SqlExecutor,
    params: TransferProvisionalOwnershipParams,
  ): Promise<ClaimTransitionResult> {
    await this.assertActiveTransaction(tx);
    const normProvider = this.normalizeProvider(params.provider);
    const normRef = this.normalizeReference(params.reference);
    const newOrgId = this.assertNonEmptyId(params.newOrganizationId, 'newOrganizationId', 'INVALID_ORGANIZATION_ID');

    // Level 1: Global Reference Advisory Lock
    await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${normProvider} || ':' || ${normRef}))`;

    // Level 2: Claim Row Lock
    const existing = await this.lockClaimByCanonicalKey(tx, normProvider, normRef);

    if (existing.length === 0) {
      throw new HttpException(404, 'CLAIM_NOT_FOUND', `Claim for '${normRef}' not found.`);
    }

    const claim = existing[0]!;
    if (claim.status !== ClaimStatus.PROVISIONAL && claim.status !== ClaimStatus.EXPIRED) {
      throw new HttpException(
        409,
        'CANNOT_TRANSFER_CLAIM',
        `Cannot transfer ownership of claim with status '${claim.status}'.`,
      );
    }

    if (claim.organization_id === newOrgId) {
      const newVersion = (claim.version || 1) + 1;
      const resolvedCheckoutId = params.newCheckoutId ?? claim.checkout_id ?? null;
      const resolvedPaymentId = params.newPaymentId ?? claim.payment_id ?? null;

      await tx`
        UPDATE "payment_reference_claims"
        SET
          "checkout_id" = ${resolvedCheckoutId},
          "payment_id" = ${resolvedPaymentId},
          "status" = ${ClaimStatus.CONFIRMED_PROVIDER}::"claim_status",
          "evidence_tier" = ${ClaimEvidenceTier.AUTHORITATIVE_PROVIDER}::"claim_evidence_tier",
          "expires_at" = NULL,
          "confirmed_at" = CURRENT_TIMESTAMP,
          "release_reason" = NULL,
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      await this.recordEvent(tx, {
        claimId: claim.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: newOrgId,
        action: ClaimEventAction.CONFIRMED_PROVIDER,
        previousStatus: claim.status,
        newStatus: ClaimStatus.CONFIRMED_PROVIDER,
        evidenceTier: ClaimEvidenceTier.AUTHORITATIVE_PROVIDER,
        evidenceId: resolvedPaymentId,
        reason: 'Same-organization confirmation via ownership transfer',
      });

      return {
        outcome: 'CONFIRMED',
        claimId: claim.id,
        status: ClaimStatus.CONFIRMED_PROVIDER,
        paymentId: resolvedPaymentId ?? undefined,
      };
    }

    return this.resolveCrossTenantProvisionalConflict(tx, {
      claim,
      normProvider,
      normRef,
      targetOrganizationId: newOrgId,
      targetCheckoutId: params.newCheckoutId,
      targetPaymentId: params.newPaymentId,
      holdingTenantEvidence: params.holdingTenantEvidence,
      triggerSource: 'OWNERSHIP_TRANSFER',
    });
  }

  /**
   * Adjudicates an unresolved collision or dispute.
   * Level 1 -> Level 2 -> Level 6 lock hierarchy.
   */
  public async adjudicateCollision(
    tx: SqlExecutor,
    params: AdjudicateCollisionParams,
  ): Promise<ClaimTransitionResult> {
    await this.assertActiveTransaction(tx);
    const claimId = this.assertNonEmptyId(params.claimId, 'claimId', 'INVALID_CLAIM_ID');
    const adjudicatorId = this.assertNonEmptyId(params.adjudicatorId, 'adjudicatorId', 'INVALID_ADJUDICATOR_ID');

    if (!params.rationale || typeof params.rationale !== 'string' || params.rationale.trim().length < 10) {
      throw new HttpException(400, 'INVALID_RATIONALE', 'Adjudication rationale must be at least 10 characters.');
    }

    const awardedOrgId = params.awardedOrganizationId
      ? this.assertNonEmptyId(params.awardedOrganizationId, 'awardedOrganizationId', 'INVALID_ORGANIZATION_ID')
      : undefined;

    // Un-locked lookup strictly to derive canonical Level 1 advisory lock key before any row locks
    const claimRows = await tx`
      SELECT "id", "provider", "provider_reference"
      FROM "payment_reference_claims"
      WHERE "id" = ${claimId}
    `;
    if (claimRows.length === 0) {
      throw new HttpException(404, 'CLAIM_NOT_FOUND', `Claim '${claimId}' not found.`);
    }
    const claimMeta = claimRows[0]!;
    const normProvider = this.normalizeProvider(claimMeta.provider);
    const normRef = this.normalizeReference(claimMeta.provider_reference);

    // Level 1: Global Reference Advisory Lock
    await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${normProvider} || ':' || ${normRef}))`;

    // Level 2: Claim Row Lock
    const existingClaim = await tx`
      SELECT * FROM "payment_reference_claims"
      WHERE "id" = ${claimId}
      FOR UPDATE
    `;
    if (existingClaim.length === 0) {
      throw new HttpException(404, 'CLAIM_NOT_FOUND', `Claim '${claimId}' not found.`);
    }
    const claim = existingClaim[0]!;

    if (claim.status !== ClaimStatus.UNRESOLVED_COLLISION && claim.status !== ClaimStatus.DISPUTED) {
      throw new HttpException(
        409,
        'INVALID_CLAIM_STATE_FOR_ADJUDICATION',
        `Cannot adjudicate claim in status '${claim.status}'. Only UNRESOLVED_COLLISION or DISPUTED claims may be adjudicated.`,
      );
    }

    // Level 6: Collision Detail Row Lock(s)
    const collisionRows = await tx`
      SELECT "id" FROM "payment_reference_claim_collisions"
      WHERE "claim_id" = ${claimId}
      ORDER BY "detected_at" ASC, "id" ASC
      FOR UPDATE
    `;

    const newVersion = (claim.version || 1) + 1;

    if (awardedOrgId) {
      const resolvedPaymentId =
        params.awardedPaymentId !== undefined
          ? params.awardedPaymentId
          : claim.organization_id === awardedOrgId
            ? claim.payment_id ?? null
            : null;

      const resolvedCheckoutId =
        params.awardedCheckoutId !== undefined
          ? params.awardedCheckoutId
          : claim.organization_id === awardedOrgId
            ? claim.checkout_id ?? null
            : null;

      await tx`
        UPDATE "payment_reference_claims"
        SET
          "organization_id" = ${awardedOrgId},
          "payment_id" = ${resolvedPaymentId},
          "checkout_id" = ${resolvedCheckoutId},
          "status" = ${ClaimStatus.CONFIRMED_PROVIDER}::"claim_status",
          "evidence_tier" = ${ClaimEvidenceTier.AUTHORITATIVE_PROVIDER}::"claim_evidence_tier",
          "expires_at" = NULL,
          "confirmed_at" = CURRENT_TIMESTAMP,
          "confirmed_by_id" = ${adjudicatorId},
          "release_reason" = NULL,
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      if (collisionRows.length > 0) {
        await tx`
          UPDATE "payment_reference_claim_collisions"
          SET
            "status" = 'ADJUDICATED',
            "adjudicated_at" = CURRENT_TIMESTAMP,
            "adjudicated_by_id" = ${adjudicatorId},
            "adjudication_rationale" = ${params.rationale},
            "awarded_organization_id" = ${awardedOrgId}
          WHERE "claim_id" = ${claim.id}
            AND "status" = 'UNRESOLVED'
        `;
      }

      await this.recordEvent(tx, {
        claimId: claim.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: awardedOrgId,
        action: ClaimEventAction.ADJUDICATED_RESOLUTION,
        previousStatus: claim.status,
        newStatus: ClaimStatus.CONFIRMED_PROVIDER,
        evidenceTier: ClaimEvidenceTier.AUTHORITATIVE_PROVIDER,
        evidenceId: resolvedPaymentId,
        actorId: adjudicatorId,
        actorType: 'USER',
        reason: params.rationale,
      });

      return {
        outcome: 'CONFIRMED',
        claimId: claim.id,
        status: ClaimStatus.CONFIRMED_PROVIDER,
        paymentId: resolvedPaymentId ?? undefined,
      };
    }

    // No tenant awarded -> formally RELEASED (must clear org, payment, checkout, confirmation metadata)
    await tx`
      UPDATE "payment_reference_claims"
      SET
        "organization_id" = NULL,
        "payment_id" = NULL,
        "checkout_id" = NULL,
        "status" = ${ClaimStatus.RELEASED}::"claim_status",
        "evidence_tier" = ${ClaimEvidenceTier.UNRESOLVED}::"claim_evidence_tier",
        "expires_at" = NULL,
        "confirmed_at" = NULL,
        "confirmed_by_id" = NULL,
        "release_reason" = ${params.rationale},
        "version" = ${newVersion},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${claim.id}
    `;

    if (collisionRows.length > 0) {
      await tx`
        UPDATE "payment_reference_claim_collisions"
        SET
          "status" = 'RELEASED',
          "adjudicated_at" = CURRENT_TIMESTAMP,
          "adjudicated_by_id" = ${adjudicatorId},
          "adjudication_rationale" = ${params.rationale}
        WHERE "claim_id" = ${claim.id}
          AND "status" = 'UNRESOLVED'
      `;
    }

    await this.recordEvent(tx, {
      claimId: claim.id,
      provider: normProvider,
      providerReference: normRef,
      organizationId: null,
      action: ClaimEventAction.RELEASED,
      previousStatus: claim.status,
      newStatus: ClaimStatus.RELEASED,
      evidenceTier: ClaimEvidenceTier.UNRESOLVED,
      actorId: adjudicatorId,
      actorType: 'USER',
      reason: params.rationale,
    });

    return {
      outcome: 'RECLAIMED_IN_PLACE',
      claimId: claim.id,
      status: ClaimStatus.RELEASED,
    };
  }

  /**
   * Background sweeper: transitions expired provisional claims to EXPIRED
   * without releasing them for cross-tenant grabbing.
   * Scans unlocked candidates in canonical sorted order, acquires non-blocking Level 1 advisory locks
   * (skipping contested references), then locks Level 2 before mutating.
   */
  public async expireProvisionalClaims(tx: SqlExecutor, batchLimit: number = 100): Promise<number> {
    await this.assertActiveTransaction(tx);
    const limit = Math.max(1, Math.min(batchLimit, 1000));

    const candidates = await tx`
      SELECT "id", "provider", "provider_reference"
      FROM "payment_reference_claims"
      WHERE "status" = ${ClaimStatus.PROVISIONAL}::"claim_status"
        AND "expires_at" IS NOT NULL
        AND "expires_at" <= CURRENT_TIMESTAMP
      ORDER BY "provider" ASC, "provider_reference" ASC
      LIMIT ${limit}
    `;

    let transitioned = 0;

    for (const candidate of candidates) {
      const normProvider = this.normalizeProvider(candidate.provider);
      const normRef = this.normalizeReference(candidate.provider_reference);

      // Non-blocking Level 1 lock preserves Level 1 -> Level 2 ordering while skipping busy refs
      const lockResult = await tx`
        SELECT pg_try_advisory_xact_lock(
          hashtext('payment_ref_claim:' || ${normProvider} || ':' || ${normRef})
        ) AS "acquired"
      `;
      if (!lockResult[0]?.acquired) {
        continue;
      }

      // Level 2: Claim row lock re-verifying expiration criteria
      const lockedRows = await tx`
        SELECT * FROM "payment_reference_claims"
        WHERE "id" = ${candidate.id}
          AND "status" = ${ClaimStatus.PROVISIONAL}::"claim_status"
          AND "expires_at" IS NOT NULL
          AND "expires_at" <= CURRENT_TIMESTAMP
        FOR UPDATE
      `;
      if (lockedRows.length === 0) {
        continue;
      }

      const c = lockedRows[0]!;
      const newVersion = (c.version || 1) + 1;
      await tx`
        UPDATE "payment_reference_claims"
        SET
          "status" = ${ClaimStatus.EXPIRED}::"claim_status",
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${c.id}
      `;

      await this.recordEvent(tx, {
        claimId: c.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: c.organization_id,
        action: ClaimEventAction.EXPIRED,
        previousStatus: ClaimStatus.PROVISIONAL,
        newStatus: ClaimStatus.EXPIRED,
        evidenceTier: c.evidence_tier,
        evidenceId: c.payment_id ?? null,
        reason: 'Provisional hold TTL expired without provider confirmation',
      });

      transitioned++;
    }

    return transitioned;
  }

  /**
   * Acquires Level 1 advisory lock + Level 2 row lock on a canonical claim key without mutating state.
   * Returns null if no global claim record exists yet.
   */
  public async lockClaimRow(
    tx: SqlExecutor,
    provider: PaymentProvider | string,
    reference: string,
  ): Promise<PaymentReferenceClaimRecord | null> {
    await this.assertActiveTransaction(tx);
    const normProvider = this.normalizeProvider(provider);
    const normRef = this.normalizeReference(reference);

    // Level 1: Global Reference Advisory Lock
    await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${normProvider} || ':' || ${normRef}))`;

    // Level 2: Global Claim Row Lock
    const rows = await this.lockClaimByCanonicalKey(tx, normProvider, normRef);
    if (rows.length === 0) return null;
    return this.mapClaimRow(rows[0]!);
  }

  /**
   * Verifies and refreshes (when expired for the same org) global claim ownership inside an
   * active reconciliation/settlement transaction BEFORE locking tenant payments or invoices.
   * Lock order: Level 1 (advisory) -> Level 2 (claim row).
   *
   * Note: Human attestation NEVER upgrades a PROVISIONAL claim to CONFIRMED_PROVIDER.
   */
  public async verifyOrRefreshManualClaim(
    tx: SqlExecutor,
    params: {
      provider: PaymentProvider | string;
      reference: string;
      organizationId: string;
      paymentId: string;
      verifiedById?: string | null;
      allowConfirmedClaimSameOrg?: boolean;
      holdDurationMs?: number;
    },
  ): Promise<ClaimTransitionResult> {
    await this.assertActiveTransaction(tx);
    const normProvider = this.normalizeProvider(params.provider);
    const normRef = this.normalizeReference(params.reference);
    const orgId = this.assertNonEmptyId(params.organizationId, 'organizationId', 'INVALID_ORGANIZATION_ID');
    const paymentId = this.assertNonEmptyId(params.paymentId, 'paymentId', 'INVALID_PAYMENT_ID');
    const holdMs = params.holdDurationMs ?? 2 * 60 * 60 * 1000;

    // Level 1: Global Reference Advisory Lock
    await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${normProvider} || ':' || ${normRef}))`;

    // Level 2: Claim Row Lock
    const existing = await this.lockClaimByCanonicalKey(tx, normProvider, normRef);

    if (existing.length === 0) {
      return this.acquireProvisionalClaim(tx, {
        provider: normProvider,
        reference: normRef,
        organizationId: orgId,
        paymentId,
        holdDurationMs: holdMs,
      });
    }

    const claim = existing[0]!;

    if (claim.status === ClaimStatus.UNRESOLVED_COLLISION) {
      throw new HttpException(
        409,
        'COLLISION_QUARANTINED',
        `Reference '${normRef}' for provider '${normProvider}' is quarantined under an unresolved multi-tenant collision.`,
      );
    }

    if (claim.status === ClaimStatus.DISPUTED) {
      throw new HttpException(
        409,
        'CROSS_TENANT_DISPUTE',
        `Reference '${normRef}' for provider '${normProvider}' is locked in an active dispute.`,
      );
    }

    if (claim.status === ClaimStatus.RELEASED) {
      throw new HttpException(
        409,
        'CLAIM_RELEASED',
        `Reference '${normRef}' was formally released and must be freshly claimed before settlement.`,
      );
    }

    if (claim.organization_id !== orgId) {
      if (claim.status === ClaimStatus.CONFIRMED_PROVIDER) {
        throw new HttpException(
          409,
          'REFERENCE_ALREADY_SETTLED',
          `Provider reference '${normRef}' has already been settled and confirmed by another organization.`,
          { settledOrganizationId: claim.organization_id },
        );
      }

      throw new HttpException(
        409,
        'REFERENCE_CLAIMED_BY_ANOTHER_ORG',
        `Provider reference '${normRef}' is reserved by another organization and cannot be manually settled.`,
        { claimingOrganizationId: claim.organization_id },
      );
    }

    if (claim.status === ClaimStatus.CONFIRMED_PROVIDER) {
      if (claim.payment_id && claim.payment_id !== paymentId) {
        throw new HttpException(
          409,
          'REFERENCE_ALREADY_USED',
          `Provider reference '${normRef}' has already been confirmed for another payment in this organization.`,
        );
      }

      if (!params.allowConfirmedClaimSameOrg && !claim.payment_id) {
        throw new HttpException(
          409,
          'REFERENCE_ALREADY_USED',
          `Provider reference '${normRef}' is already confirmed on a provider checkout.`,
        );
      }

      return {
        outcome: 'CONFIRMED',
        claimId: claim.id,
        status: ClaimStatus.CONFIRMED_PROVIDER,
        paymentId: claim.payment_id ?? paymentId,
      };
    }

    if (claim.status === ClaimStatus.EXPIRED) {
      const expiresAt = new Date(Date.now() + holdMs);
      const newVersion = (claim.version || 1) + 1;
      const resolvedPaymentId = claim.payment_id ?? paymentId;

      await tx`
        UPDATE "payment_reference_claims"
        SET
          "payment_id" = ${resolvedPaymentId},
          "status" = ${ClaimStatus.PROVISIONAL}::"claim_status",
          "claimed_at" = CURRENT_TIMESTAMP,
          "expires_at" = ${expiresAt},
          "version" = ${newVersion},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      await this.recordEvent(tx, {
        claimId: claim.id,
        provider: normProvider,
        providerReference: normRef,
        organizationId: orgId,
        action: ClaimEventAction.PROVISIONALLY_CLAIMED,
        previousStatus: ClaimStatus.EXPIRED,
        newStatus: ClaimStatus.PROVISIONAL,
        evidenceTier: ClaimEvidenceTier.CLIENT_REPORTED,
        evidenceId: resolvedPaymentId,
        actorId: params.verifiedById ?? null,
        actorType: params.verifiedById ? 'FINANCE_USER' : 'SYSTEM',
        reason: 'Manual verification refreshed expired provisional claim for owning organization',
      });

      return {
        outcome: 'RECLAIMED_IN_PLACE',
        claimId: claim.id,
        status: ClaimStatus.PROVISIONAL,
        paymentId: resolvedPaymentId,
      };
    }

    if (claim.status === ClaimStatus.PROVISIONAL) {
      if (claim.payment_id && claim.payment_id !== paymentId) {
        throw new HttpException(
          409,
          'REFERENCE_ALREADY_USED',
          `Provider reference '${normRef}' is already linked to another candidate payment in this organization.`,
        );
      }

      const expiresAt = new Date(Date.now() + holdMs);
      const resolvedPaymentId = claim.payment_id ?? paymentId;

      await tx`
        UPDATE "payment_reference_claims"
        SET
          "payment_id" = ${resolvedPaymentId},
          "claimed_at" = CURRENT_TIMESTAMP,
          "expires_at" = GREATEST(COALESCE("expires_at", CURRENT_TIMESTAMP), ${expiresAt}),
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${claim.id}
      `;

      return {
        outcome: 'CLAIM_ACQUIRED',
        claimId: claim.id,
        status: ClaimStatus.PROVISIONAL,
        paymentId: resolvedPaymentId,
      };
    }

    throw new HttpException(500, 'UNHANDLED_CLAIM_STATE', `Unknown claim status '${claim.status}'`);
  }

  /**
   * Inspect current claim state by provider and reference.
   */
  public async getClaim(
    provider: PaymentProvider,
    reference: string,
    tx: SqlExecutor = sql,
  ): Promise<PaymentReferenceClaimRecord | null> {
    const normProvider = this.normalizeProvider(provider);
    const normRef = this.normalizeReference(reference);
    const rows = await tx`
      SELECT * FROM "payment_reference_claims"
      WHERE "provider" = ${normProvider}::"PaymentProvider"
        AND "provider_reference" = ${normRef}
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return this.mapClaimRow(rows[0]!);
  }

  private async recordEvent(
    tx: SqlExecutor,
    params: {
      claimId: string;
      provider: PaymentProvider;
      providerReference: string;
      organizationId?: string | null;
      action: ClaimEventAction;
      previousStatus?: ClaimStatus | null;
      newStatus: ClaimStatus;
      evidenceTier?: ClaimEvidenceTier;
      evidenceId?: string | null;
      actorId?: string | null;
      actorType?: string;
      reason?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    const eventId = randomUUID();
    await tx`
      INSERT INTO "payment_reference_claim_events" (
        "id", "claim_id", "provider", "provider_reference", "organization_id",
        "action", "previous_status", "new_status", "evidence_tier",
        "evidence_id", "actor_id", "actor_type", "reason", "metadata"
      )
      VALUES (
        ${eventId},
        ${params.claimId},
        ${params.provider}::"PaymentProvider",
        ${params.providerReference},
        ${params.organizationId ?? null},
        ${params.action}::"claim_event_action",
        ${params.previousStatus ?? null}::"claim_status",
        ${params.newStatus}::"claim_status",
        ${params.evidenceTier ?? ClaimEvidenceTier.CLIENT_REPORTED}::"claim_evidence_tier",
        ${params.evidenceId ?? null},
        ${params.actorId ?? null},
        ${params.actorType ?? 'SYSTEM'},
        ${params.reason ?? null},
        ${params.metadata ? JSON.stringify(params.metadata) : null}::jsonb
      )
    `;
  }

  private mapClaimRow(row: any): PaymentReferenceClaimRecord {
    return {
      id: row.id,
      provider: row.provider,
      providerReference: row.provider_reference,
      organizationId: row.organization_id ?? null,
      checkoutId: row.checkout_id ?? null,
      paymentId: row.payment_id ?? null,
      status: row.status,
      evidenceTier: row.evidence_tier,
      claimedAt: new Date(row.claimed_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
      confirmedById: row.confirmed_by_id ?? null,
      releaseReason: row.release_reason ?? null,
      version: row.version,
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const paymentReferenceClaimService = new PaymentReferenceClaimService();
