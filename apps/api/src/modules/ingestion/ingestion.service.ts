import { randomUUID } from 'node:crypto';
import {
  BusinessEventType,
  ClaimStatus,
  computeDeduplicationHash,
  DeviceStatus,
  EvidenceSourceType,
  IngestEvidenceDto,
  IngestionAckResult,
  NormalizedPaymentRecordDto,
  TransactionState,
} from '@brisksms/shared';
import { ParserEngine } from '@brisksms/parser-engine';
import {
  dbStore,
  RawPaymentEvidenceRecord,
  mapNormalizedPaymentRow,
  mapRawEvidenceRow,
} from '../../core/store.js';
import { HttpException } from '../../core/http.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import {
  PaymentReferenceClaimService,
  paymentReferenceClaimService,
} from '../reconciliation/payment-reference-claim.service.js';
import { assertTenantContext, sql, SqlExecutor } from '@brisksms/db';

export const PARSER_ENGINE_VERSION = '1.0.0';

/**
 * Universal Payment Evidence Ingestion Service
 *
 * CRITICAL FINANCIAL INVARIANT (Section 3.C):
 * Ingesting an Android payment notification records immutable raw evidence (`OBSERVED`),
 * acquires a provisional global reference claim via `PaymentReferenceClaimService`,
 * normalizes payment fields (`NORMALIZED`), and evaluates candidate invoice matches (`MATCHED` /
 * `REVIEW_REQUIRED` / `UNMATCHED`). It NEVER automatically sets `PROVIDER_AUTHENTICATED`,
 * NEVER marks a payment as `VERIFIED`, and NEVER marks an invoice as `PAID`.
 */
export class IngestionService {
  private readonly parserEngine = new ParserEngine();

  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly claimService: PaymentReferenceClaimService = paymentReferenceClaimService,
  ) {}

  async ingestEvidence(dto: IngestEvidenceDto): Promise<IngestionAckResult> {
    assertTenantContext({ organizationId: dto.organizationId });

    // 1. Validate source device authorization when relayed from Android companion
    if (dto.sourceType === EvidenceSourceType.ANDROID_NOTIFICATION_RELAY && dto.deviceId) {
      const device = await dbStore.getDeviceById(dto.deviceId, dto.organizationId);
      if (!device || device.status !== DeviceStatus.ACTIVE) {
        throw new Error('Unauthorized or inactive Android relay device for organization.');
      }
    }

    // 2. Parse notification payload using deterministic provider adapters
    const parsed = this.parserEngine.parseNotification(
      dto.senderAddress,
      dto.rawPayload,
      dto.organizationId,
      dto.deviceTimestamp,
    );
    const evidenceId = randomUUID();

    if (!parsed) {
      await this.insertRawEvidence(sql, evidenceId, dto, 'PARSE_FAILED');

      return {
        acknowledged: true,
        evidenceId,
        parserVersion: PARSER_ENGINE_VERSION,
        status: 'PARSE_FAILED',
      };
    }

    // 3. Normalize canonical provider/reference and compute SHA-256 deduplication key
    const normProvider = this.claimService.normalizeProvider(parsed.provider);
    const normRef = this.claimService.normalizeReference(parsed.reference);
    const parsedCurrency = (parsed.currency || 'TZS').trim().toUpperCase();

    const deduplicationHash = computeDeduplicationHash(
      dto.organizationId,
      normProvider,
      normRef,
      parsed.amountCents,
      parsed.providerTimestamp,
    );

    // 4. Commit claim acquisition, raw evidence, deduplication check, normalized payment,
    //    candidate match, and outbox events in an ACID transaction with serialization retry.
    const txOutcome = await this.claimService.executeWithSerializationRetry(async (tx) => {
      // Lock Order Level 1 -> Level 2 BEFORE any normalized_payments (Level 4) locks
      const lockedClaim = await this.claimService.lockClaimRow(tx, normProvider, normRef);

      // Level 4: Check idempotent duplicate replay via deduplicationHash
      const existingDupRows = await tx`
        SELECT * FROM "normalized_payments"
        WHERE "organization_id" = ${dto.organizationId}
          AND "deduplication_hash" = ${deduplicationHash}
        ORDER BY "id" ASC
        LIMIT 1
        FOR UPDATE
      `;

      if (existingDupRows.length > 0) {
        const existingPayment = mapNormalizedPaymentRow(existingDupRows[0]!);
        await this.insertRawEvidence(tx, evidenceId, dto, 'DUPLICATE_REJECTED');

        return {
          kind: 'RESULT' as const,
          result: {
            acknowledged: true,
            evidenceId,
            deduplicationHash,
            parserVersion: PARSER_ENGINE_VERSION,
            status: 'DUPLICATE' as const,
            paymentId: existingPayment.id,
            matchedInvoiceId: existingPayment.matchedInvoiceId,
            candidateInvoiceId: existingPayment.candidateInvoiceId,
            amountCents: existingPayment.amountCents.toString(),
            reference: existingPayment.reference,
            state: TransactionState.DUPLICATE_REJECTED,
          },
        };
      }

      // Level 4: Inspect any existing same-org normalized payment for supplementary correlation
      const existingOrgPayRows = await tx`
        SELECT * FROM "normalized_payments"
        WHERE "organization_id" = ${dto.organizationId}
          AND (
            "id" = ${lockedClaim && lockedClaim.organizationId === dto.organizationId ? (lockedClaim.paymentId ?? null) : null}
            OR ("provider" = ${normProvider}::"PaymentProvider" AND UPPER(BTRIM("reference")) = ${normRef})
          )
        ORDER BY "id" ASC
        LIMIT 1
        FOR UPDATE
      `;
      const existingOrgPayment = existingOrgPayRows[0]
        ? mapNormalizedPaymentRow(existingOrgPayRows[0])
        : null;

      const paymentId = existingOrgPayment?.id ?? randomUUID();
      const claimCandidatePaymentId = existingOrgPayment
        ? (lockedClaim?.status === ClaimStatus.EXPIRED ? existingOrgPayment.id : randomUUID())
        : paymentId;

      // Acquire or correlate global provisional claim under Level 1 + Level 2 locks
      const claimResult = await this.claimService.acquireProvisionalClaim(tx, {
        provider: normProvider,
        reference: normRef,
        organizationId: dto.organizationId,
        paymentId: claimCandidatePaymentId,
      });

      if (claimResult.outcome === 'DISPUTE_RAISED') {
        // Cross-tenant expired/lapsed claim attempt: commit DISPUTED transition & audit event,
        // create ZERO tenant candidate payments, then reject with HTTP 409 outside tx.
        return {
          kind: 'THROW_DISPUTE' as const,
          claimId: claimResult.claimId,
          provider: normProvider,
          reference: normRef,
        };
      }

      if (claimResult.outcome === 'SUPPLEMENTARY_MATCH' || existingOrgPayment !== null) {
        const targetPayment = existingOrgPayment;
        const conflict = targetPayment
          ? this.hasSupplementaryConflict(targetPayment, parsed.amountCents, parsedCurrency, parsed.senderPhone)
          : false;
        const parseStatus = conflict ? 'AMOUNT_MISMATCH_DISPUTE' : 'OBSERVED_SUPPLEMENTARY';

        await this.insertRawEvidence(tx, evidenceId, dto, parseStatus);

        await this.claimService.attachSupplementaryEvidence(tx, {
          provider: normProvider,
          reference: normRef,
          organizationId: dto.organizationId,
          amountCents: parsed.amountCents,
          currency: parsedCurrency,
          senderPhone: parsed.senderPhone,
          rawEvidenceId: evidenceId,
        });

        let finalState = targetPayment?.state ?? TransactionState.NORMALIZED;
        if (conflict && targetPayment) {
          const isAlreadySettled =
            targetPayment.state === TransactionState.VERIFIED ||
            targetPayment.state === TransactionState.FULFILLMENT_PENDING ||
            targetPayment.state === TransactionState.FULFILLED ||
            targetPayment.state === TransactionState.FULFILLMENT_FAILED;

          if (!isAlreadySettled) {
            finalState = TransactionState.REVIEW_REQUIRED;
            await tx`
              UPDATE "normalized_payments"
              SET
                "state" = ${TransactionState.REVIEW_REQUIRED}::"TransactionState",
                "review_reason" = 'SUPPLEMENTARY_EVIDENCE_CONFLICT: Conflicting amount, currency, or sender on duplicate reference',
                "updated_at" = CURRENT_TIMESTAMP
              WHERE "id" = ${targetPayment.id} AND "organization_id" = ${dto.organizationId}
            `;
          } else {
            await tx`
              UPDATE "normalized_payments"
              SET
                "review_reason" = CASE
                  WHEN "review_reason" IS NULL OR BTRIM("review_reason") = ''
                    THEN 'SUPPLEMENTARY_EVIDENCE_CONFLICT'
                  WHEN "review_reason" LIKE '%SUPPLEMENTARY_EVIDENCE_CONFLICT%'
                    THEN "review_reason"
                  ELSE "review_reason" || ' | SUPPLEMENTARY_EVIDENCE_CONFLICT'
                END,
                "updated_at" = CURRENT_TIMESTAMP
              WHERE "id" = ${targetPayment.id} AND "organization_id" = ${dto.organizationId}
            `;
          }
        }

        const isConfirmedClaim = claimResult.status === ClaimStatus.CONFIRMED_PROVIDER;
        return {
          kind: 'RESULT' as const,
          result: {
            acknowledged: true,
            evidenceId,
            deduplicationHash,
            parserVersion: PARSER_ENGINE_VERSION,
            status: (isConfirmedClaim ? 'DUPLICATE' : 'OBSERVED') as 'DUPLICATE' | 'OBSERVED',
            paymentId: targetPayment?.id ?? claimResult.paymentId,
            matchedInvoiceId: targetPayment?.matchedInvoiceId ?? undefined,
            candidateInvoiceId: targetPayment?.candidateInvoiceId ?? undefined,
            amountCents: parsed.amountCents.toString(),
            reference: normRef,
            state: isConfirmedClaim ? TransactionState.DUPLICATE_REJECTED : finalState,
          },
        };
      }

      // Fresh provisional claim (or reclaimed released claim without prior local payment):
      // Persist immutable RawPaymentEvidence (Step 1: Evidence Received)
      await this.insertRawEvidence(tx, evidenceId, dto, 'OBSERVED');

      // Persist NormalizedPayment (Step 2: Evidence Parsed) using canonical provider & reference
      const payRows = await tx`
        INSERT INTO "normalized_payments" (
          "id", "organization_id", "device_id", "raw_evidence_id", "provider",
          "reference", "amount_cents", "currency", "sender_phone", "sender_name",
          "recipient_account", "customer_memo", "provider_timestamp", "parser_version",
          "state", "deduplication_hash"
        )
        VALUES (
          ${paymentId},
          ${dto.organizationId},
          ${dto.deviceId ?? null},
          ${evidenceId},
          ${normProvider}::"PaymentProvider",
          ${normRef},
          ${parsed.amountCents.toString()}::bigint,
          ${parsedCurrency},
          ${parsed.senderPhone},
          ${parsed.senderName ?? null},
          ${parsed.recipientAccount ?? null},
          ${parsed.customerMemo ?? null},
          ${parsed.providerTimestamp},
          ${PARSER_ENGINE_VERSION},
          ${TransactionState.NORMALIZED}::"TransactionState",
          ${deduplicationHash}
        )
        RETURNING *
      `;
      const paymentRecord = mapNormalizedPaymentRow(payRows[0]!);

      // Emit payment.evidence.received outbox event in the same transaction
      await dbStore.insertOutboxEvent(
        {
          organizationId: dto.organizationId,
          eventType: BusinessEventType.PAYMENT_EVIDENCE_RECEIVED,
          payload: {
            paymentId,
            evidenceId,
            provider: normProvider,
            reference: normRef,
            amountCents: parsed.amountCents.toString(),
            currency: parsedCurrency,
            senderPhone: parsed.senderPhone,
            parserVersion: PARSER_ENGINE_VERSION,
          },
        },
        tx,
      );

      // Step 3: Evaluate candidate invoice match (does NOT mark invoice PAID or payment VERIFIED)
      const matchResult = await this.reconciliationService.reconcilePayment(paymentRecord, tx);

      const finalPayRows = await tx`
        SELECT * FROM "normalized_payments" WHERE "id" = ${paymentId} LIMIT 1
      `;
      const finalPayment = mapNormalizedPaymentRow(finalPayRows[0]!);

      return {
        kind: 'RESULT' as const,
        result: {
          acknowledged: true,
          evidenceId,
          deduplicationHash,
          parserVersion: PARSER_ENGINE_VERSION,
          status: 'OBSERVED' as const,
          paymentId,
          matchedInvoiceId: matchResult.matchedInvoiceId ?? undefined,
          candidateInvoiceId: finalPayment.candidateInvoiceId ?? undefined,
          amountCents: parsed.amountCents.toString(),
          reference: normRef,
          state: finalPayment.state,
        },
      };
    });

    if (txOutcome.kind === 'THROW_DISPUTE') {
      throw new HttpException(
        409,
        'CROSS_TENANT_DISPUTE',
        `Reference '${txOutcome.reference}' for provider '${txOutcome.provider}' is locked in an active cross-tenant dispute.`,
        { claimId: txOutcome.claimId },
      );
    }

    return txOutcome.result;
  }

  private async insertRawEvidence(
    executor: SqlExecutor,
    evidenceId: string,
    dto: IngestEvidenceDto,
    parseStatus: string,
  ): Promise<void> {
    await executor`
      INSERT INTO "raw_payment_evidence" (
        "id", "organization_id", "source_type", "device_id", "sender_address",
        "raw_payload", "sim_slot", "device_timestamp", "signature", "nonce",
        "sequence_number", "parser_version", "parse_status"
      )
      VALUES (
        ${evidenceId},
        ${dto.organizationId},
        ${dto.sourceType}::"EvidenceSourceType",
        ${dto.deviceId ?? null},
        ${dto.senderAddress},
        ${dto.rawPayload},
        ${dto.simSlot ?? 1},
        ${dto.deviceTimestamp},
        ${dto.signature ?? null},
        ${dto.nonce ?? null},
        ${dto.sequenceNumber !== undefined && dto.sequenceNumber !== null ? dto.sequenceNumber.toString() : null}::bigint,
        ${PARSER_ENGINE_VERSION},
        ${parseStatus}
      )
    `;
  }

  private hasSupplementaryConflict(
    existingPayment: ReturnType<typeof mapNormalizedPaymentRow>,
    amountCents: bigint,
    currency: string,
    senderPhone: string,
  ): boolean {
    if (existingPayment.amountCents !== amountCents) {
      return true;
    }
    if ((existingPayment.currency || 'TZS').trim().toUpperCase() !== currency) {
      return true;
    }
    const existingDigits = existingPayment.senderPhone.replace(/\D/g, '');
    const incomingDigits = (senderPhone || '').replace(/\D/g, '');
    if (existingDigits && incomingDigits && existingDigits.slice(-9) !== incomingDigits.slice(-9)) {
      return true;
    }
    return false;
  }

  async listPayments(organizationId: string): Promise<NormalizedPaymentRecordDto[]> {
    assertTenantContext({ organizationId });
    const rows = await sql`
      SELECT * FROM "normalized_payments"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" DESC
    `;
    return rows.map((r) => {
      const p = mapNormalizedPaymentRow(r);
      return {
        id: p.id,
        organizationId: p.organizationId,
        deviceId: p.deviceId,
        rawEvidenceId: p.rawEvidenceId,
        provider: p.provider,
        reference: p.reference,
        amountCents: p.amountCents,
        currency: p.currency,
        senderPhone: p.senderPhone,
        senderName: p.senderName,
        recipientAccount: p.recipientAccount,
        customerMemo: p.customerMemo,
        providerTimestamp: p.providerTimestamp,
        parserVersion: p.parserVersion,
        state: p.state,
        deduplicationHash: p.deduplicationHash,
        candidateInvoiceId: p.candidateInvoiceId,
        matchedInvoiceId: p.matchedInvoiceId,
        verifiedAt: p.verifiedAt,
        verifiedById: p.verifiedById,
        createdAt: p.createdAt,
      };
    });
  }

  async listRawEvidence(organizationId: string): Promise<RawPaymentEvidenceRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await sql`
      SELECT * FROM "raw_payment_evidence"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "received_at" DESC
    `;
    return rows.map(mapRawEvidenceRow);
  }
}

export const ingestionService = new IngestionService(
  new ReconciliationService(),
);
