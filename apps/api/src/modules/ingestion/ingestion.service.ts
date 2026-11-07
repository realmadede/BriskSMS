import { randomUUID } from 'node:crypto';
import {
  BusinessEventType,
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
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { assertTenantContext, sql, withTransaction } from '@brisksms/db';

export const PARSER_ENGINE_VERSION = '1.0.0';

/**
 * Universal Payment Evidence Ingestion Service
 *
 * CRITICAL FINANCIAL INVARIANT (Section 3.C):
 * Ingesting an Android payment notification records immutable raw evidence (`OBSERVED`),
 * normalizes payment fields (`NORMALIZED`), and evaluates candidate invoice matches (`MATCHED` /
 * `REVIEW_REQUIRED` / `UNMATCHED`). It NEVER automatically marks a payment as `VERIFIED` or
 * an invoice as `PAID`. Independent or manual verification is required via `ReconciliationService.verifyPayment()`.
 */
export class IngestionService {
  private readonly parserEngine = new ParserEngine();

  constructor(private readonly reconciliationService: ReconciliationService) {}

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
      await sql`
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
          'PARSE_FAILED'
        )
      `;

      return {
        acknowledged: true,
        evidenceId,
        parserVersion: PARSER_ENGINE_VERSION,
        status: 'PARSE_FAILED',
      };
    }

    // 3. Compute cryptographic SHA-256 deduplication key
    const deduplicationHash = computeDeduplicationHash(
      dto.organizationId,
      parsed.provider,
      parsed.reference,
      parsed.amountCents,
      parsed.providerTimestamp,
    );

    // 4. Commit raw evidence, deduplication check, normalized payment, candidate match, and outbox events in an ACID transaction
    return withTransaction(async (tx) => {
      // Lock/check existing normalized payment by (organization_id, deduplication_hash)
      const existingRows = await tx`
        SELECT * FROM "normalized_payments"
        WHERE "organization_id" = ${dto.organizationId} AND "deduplication_hash" = ${deduplicationHash}
        LIMIT 1
      `;

      if (existingRows.length > 0) {
        const existingPayment = mapNormalizedPaymentRow(existingRows[0]!);

        // Append forensic raw evidence entry marked DUPLICATE_REJECTED
        await tx`
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
            'DUPLICATE_REJECTED'
          )
        `;

        return {
          acknowledged: true,
          evidenceId,
          deduplicationHash,
          parserVersion: PARSER_ENGINE_VERSION,
          status: 'DUPLICATE',
          paymentId: existingPayment.id,
          matchedInvoiceId: existingPayment.matchedInvoiceId,
          candidateInvoiceId: existingPayment.candidateInvoiceId,
          amountCents: existingPayment.amountCents.toString(),
          reference: existingPayment.reference,
          state: TransactionState.DUPLICATE_REJECTED,
        };
      }

      // Persist immutable RawPaymentEvidence (Step 1: Evidence Received)
      await tx`
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
          'OBSERVED'
        )
      `;

      // Persist NormalizedPayment (Step 2: Evidence Parsed)
      const paymentId = randomUUID();
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
          ${parsed.provider}::"PaymentProvider",
          ${parsed.reference},
          ${parsed.amountCents.toString()}::bigint,
          ${parsed.currency || 'TZS'},
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
            provider: parsed.provider,
            reference: parsed.reference,
            amountCents: parsed.amountCents.toString(),
            currency: parsed.currency || 'TZS',
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
        acknowledged: true,
        evidenceId,
        deduplicationHash,
        parserVersion: PARSER_ENGINE_VERSION,
        status: 'OBSERVED',
        paymentId,
        matchedInvoiceId: matchResult.matchedInvoiceId ?? undefined,
        candidateInvoiceId: finalPayment.candidateInvoiceId ?? undefined,
        amountCents: parsed.amountCents.toString(),
        reference: parsed.reference,
        state: finalPayment.state,
      };
    });
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
