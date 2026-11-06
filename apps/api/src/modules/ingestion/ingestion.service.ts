import { randomUUID } from 'node:crypto';
import {
  EvidenceSourceType,
  IngestEvidenceDto,
  IngestionAckResult,
  TransactionState,
  DeviceStatus,
} from '@brisksms/shared';
import { ParserEngine } from '@brisksms/parser-engine';
import {
  dbStore,
  RawPaymentEvidenceRecord,
  NormalizedPaymentRecord,
} from '../../core/store.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';

export class IngestionService {
  private readonly parserEngine: ParserEngine;
  private readonly reconciliationService: ReconciliationService;

  constructor(reconciliationService?: ReconciliationService, parserEngine?: ParserEngine) {
    this.reconciliationService = reconciliationService ?? new ReconciliationService();
    this.parserEngine = parserEngine ?? new ParserEngine();
  }

  /**
   * Universal Payment Ingestion Handler
   * Receives payment evidence from Android relay, bank webhooks, aggregators, or manual uploads.
   * Preserves raw evidence immutably, runs provider parsers, deduplicates cryptographically,
   * and routes to the financial reconciliation engine.
   */
  public async ingestEvidence(dto: IngestEvidenceDto): Promise<IngestionAckResult> {
    const orgId = dto.organizationId;
    if (!orgId) {
      throw new Error('Organization ID is required for payment ingestion');
    }

    const organization = dbStore.organizations.get(orgId);
    if (!organization) {
      throw new Error(`Organization with ID '${orgId}' does not exist`);
    }

    // Validate Android device pairing and state when coming from relay
    if (dto.sourceType === EvidenceSourceType.ANDROID_NOTIFICATION_RELAY && dto.deviceId) {
      const device = dbStore.devices.get(dto.deviceId);
      if (!device || device.organizationId !== orgId) {
        throw new Error(`Device '${dto.deviceId}' is not registered under organization '${orgId}'`);
      }
      if (device.status === DeviceStatus.REVOKED) {
        throw new Error(`Device '${dto.deviceId}' has been revoked`);
      }
      if (device.status === DeviceStatus.QUARANTINED) {
        throw new Error(`Device '${dto.deviceId}' is quarantined`);
      }
    }

    const now = new Date();
    const deviceTimestamp = new Date(dto.deviceTimestamp);

    // 1. Immutable Raw Evidence Persistence
    const rawRecord: RawPaymentEvidenceRecord = {
      id: randomUUID(),
      organizationId: orgId,
      sourceType: dto.sourceType,
      deviceId: dto.deviceId ?? null,
      senderAddress: dto.senderAddress.trim(),
      rawPayload: dto.rawPayload.trim(),
      simSlot: dto.simSlot ?? 1,
      deviceTimestamp: isNaN(deviceTimestamp.getTime()) ? now : deviceTimestamp,
      signature: dto.signature ?? null,
      nonce: dto.nonce ?? null,
      sequenceNumber: dto.sequenceNumber ? BigInt(dto.sequenceNumber) : null,
      receivedAt: now,
    };

    dbStore.rawEvidences.push(rawRecord);

    // 2. Extensible Provider Parsing & Canonical Normalization
    const parsedDraft = this.parserEngine.parseNotification(
      rawRecord.senderAddress,
      rawRecord.rawPayload,
      orgId,
      rawRecord.deviceTimestamp,
    );

    if (!parsedDraft) {
      // Notification is not a supported financial transaction or cannot be parsed
      return {
        acknowledged: true,
        evidenceId: rawRecord.id,
        status: 'PARSE_FAILED',
        state: TransactionState.UNMATCHED,
      };
    }

    // 3. Cryptographic Deterministic Deduplication
    const dedupKey = `${orgId}:${parsedDraft.deduplicationHash}`;
    const existingPaymentId = dbStore.paymentsByDeduplication.get(dedupKey);

    if (existingPaymentId) {
      // Deterministic replay: Return acknowledgement idempotently without duplicate records
      const existingPayment = dbStore.normalizedPayments.get(existingPaymentId);
      return {
        acknowledged: true,
        evidenceId: rawRecord.id,
        paymentId: existingPaymentId,
        status: 'DUPLICATE',
        state: TransactionState.DUPLICATE_REJECTED,
        deduplicationHash: parsedDraft.deduplicationHash,
        matchedInvoiceId: existingPayment?.matchedInvoiceId ?? undefined,
        amountCents: parsedDraft.amountCents.toString(),
        reference: parsedDraft.reference,
      };
    }

    // 4. Create Normalized Payment Record
    const paymentRecord: NormalizedPaymentRecord = {
      id: randomUUID(),
      organizationId: orgId,
      deviceId: dto.deviceId ?? null,
      rawEvidenceId: rawRecord.id,
      provider: parsedDraft.provider,
      reference: parsedDraft.reference,
      amountCents: parsedDraft.amountCents,
      currency: parsedDraft.currency,
      senderPhone: parsedDraft.senderPhone,
      senderName: parsedDraft.senderName,
      recipientAccount: parsedDraft.recipientAccount,
      customerMemo: parsedDraft.customerMemo,
      providerTimestamp: parsedDraft.providerTimestamp,
      state: TransactionState.NORMALIZED,
      deduplicationHash: parsedDraft.deduplicationHash,
      matchedInvoiceId: null,
      createdAt: now,
      updatedAt: now,
    };

    dbStore.normalizedPayments.set(paymentRecord.id, paymentRecord);
    dbStore.paymentsByDeduplication.set(dedupKey, paymentRecord.id);

    // 5. Route to Deterministic Financial Reconciliation
    const reconciliation = this.reconciliationService.reconcilePayment(paymentRecord);

    return {
      acknowledged: true,
      evidenceId: rawRecord.id,
      paymentId: paymentRecord.id,
      status: 'OBSERVED',
      state: reconciliation.state,
      deduplicationHash: paymentRecord.deduplicationHash,
      matchedInvoiceId: reconciliation.matchedInvoiceId ?? undefined,
      amountCents: paymentRecord.amountCents.toString(),
      reference: paymentRecord.reference,
    };
  }

  /**
   * Retrieves raw evidence by ID with strict tenant isolation
   */
  public getRawEvidence(organizationId: string, id: string): RawPaymentEvidenceRecord | null {
    const evidence = dbStore.rawEvidences.find((e) => e.id === id && e.organizationId === organizationId);
    return evidence ?? null;
  }

  /**
   * Retrieves normalized payment by ID
   */
  public getPayment(organizationId: string, id: string): NormalizedPaymentRecord | null {
    const payment = dbStore.normalizedPayments.get(id);
    if (!payment || payment.organizationId !== organizationId) {
      return null;
    }
    return payment;
  }

  /**
   * Lists normalized payments with optional state filter
   */
  public listPayments(organizationId: string, state?: TransactionState): NormalizedPaymentRecord[] {
    const results: NormalizedPaymentRecord[] = [];
    for (const payment of dbStore.normalizedPayments.values()) {
      if (payment.organizationId === organizationId) {
        if (!state || payment.state === state) {
          results.push(payment);
        }
      }
    }
    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}
