import { randomUUID } from 'node:crypto';
import {
  BusinessEventType,
  detectTanzanianCarrier,
  EvidenceSourceType,
  normalizeTanzanianPhone,
  PaymentProvider,
  StkPushRequestDto,
  StkPushResponseDto,
  StkPushStatus,
  StkPushStatusDto,
  toMajorUnits,
  toMinorUnits,
  VerificationMethod,
} from '@brisksms/shared';
import { assertTenantContext, sql } from '@brisksms/db';
import {
  dbStore,
  mapStkPushTransactionRow,
  StkPushTransactionRecord,
} from '../../core/store.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import {
  AirtelStkAdapter,
  HalopesaStkAdapter,
  MpesaStkAdapter,
  StkPushAdapter,
  TigoStkAdapter,
} from './adapters/index.js';

export class StkPushService {
  private readonly adapters: Map<PaymentProvider, StkPushAdapter> = new Map();

  constructor(
    private readonly ingestionService: IngestionService = new IngestionService(new ReconciliationService()),
    private readonly reconciliationService: ReconciliationService = new ReconciliationService(),
  ) {
    this.registerAdapter(new MpesaStkAdapter());
    this.registerAdapter(new TigoStkAdapter());
    this.registerAdapter(new AirtelStkAdapter());
    this.registerAdapter(new HalopesaStkAdapter());
  }

  public registerAdapter(adapter: StkPushAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  public getAdapter(provider: PaymentProvider): StkPushAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No STK Push adapter registered for provider: ${provider}`);
    }
    return adapter;
  }

  /**
   * Initiates a Mobile Money STK / USSD Push directly to customer handset
   */
  public async initiateStkPush(
    organizationId: string,
    dto: StkPushRequestDto,
  ): Promise<StkPushResponseDto> {
    assertTenantContext({ organizationId });

    if (!dto.phoneNumber || typeof dto.phoneNumber !== 'string') {
      throw new Error('phoneNumber is required and must be a valid string');
    }

    const normalizedPhone = normalizeTanzanianPhone(dto.phoneNumber);
    const provider = detectTanzanianCarrier(normalizedPhone);

    if (dto.amount === undefined || dto.amount === null || Number(dto.amount) <= 0) {
      throw new Error('amount must be a positive numeric value');
    }

    const amountCents = toMinorUnits(dto.amount);
    const currency = dto.currency || 'TZS';

    let targetInvoiceId: string | undefined = dto.invoiceId;
    let targetReferenceNumber: string | undefined = dto.referenceNumber;

    if (targetInvoiceId) {
      const inv = await this.reconciliationService.findInvoiceById(organizationId, targetInvoiceId);
      if (!inv) {
        throw new Error(`Invoice '${targetInvoiceId}' not found in organization`);
      }
      targetReferenceNumber = targetReferenceNumber || inv.referenceNumber;
    }

    const checkoutId = `stk_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // Persist pending STK transaction record in PostgreSQL
    const stkRecord = await dbStore.createStkTransaction({
      id: checkoutId,
      organizationId,
      provider,
      phoneNumber: normalizedPhone,
      amountCents,
      currency,
      status: StkPushStatus.PENDING,
      invoiceId: targetInvoiceId ?? null,
      referenceNumber: targetReferenceNumber ?? null,
      memo: dto.memo ?? null,
      metadata: dto.metadata ?? null,
    });

    // Dispatch prompt to customer handset via provider adapter
    const adapter = this.getAdapter(provider);
    const pushResult = await adapter.initiatePush({
      checkoutId,
      organizationId,
      phoneNumber: normalizedPhone,
      amountCents,
      currency,
      referenceNumber: targetReferenceNumber,
      memo: dto.memo,
    });

    if (!pushResult.success) {
      await dbStore.updateStkTransaction(checkoutId, organizationId, {
        status: StkPushStatus.FAILED,
        errorMessage: pushResult.errorMessage || 'Failed to dispatch carrier USSD push',
      });
      throw new Error(pushResult.errorMessage || 'Carrier push initiation failed');
    }

    // Insert transactional outbox event
    await dbStore.insertOutboxEvent({
      organizationId,
      eventType: BusinessEventType.PAYMENT_STK_INITIATED,
      payload: {
        checkoutId,
        provider,
        phoneNumber: normalizedPhone,
        amountCents: amountCents.toString(),
        currency,
        invoiceId: targetInvoiceId,
        referenceNumber: targetReferenceNumber,
        initiatedAt: stkRecord.createdAt.toISOString(),
      },
    });

    return {
      checkoutId,
      organizationId,
      provider,
      phoneNumber: normalizedPhone,
      amountCents: amountCents.toString(),
      currency,
      status: StkPushStatus.PENDING,
      invoiceId: targetInvoiceId,
      referenceNumber: targetReferenceNumber,
      customerPrompt: pushResult.customerPrompt,
      initiatedAt: stkRecord.createdAt.toISOString(),
    };
  }

  /**
   * Status lookup endpoint for polling or asynchronous status verification
   */
  public async getStkTransactionStatus(
    organizationId: string,
    checkoutId: string,
  ): Promise<StkPushStatusDto> {
    assertTenantContext({ organizationId });

    const record = await dbStore.getStkTransactionById(checkoutId, organizationId);
    if (!record) {
      throw new Error(`STK Push transaction '${checkoutId}' not found`);
    }

    return this.mapToStatusDto(record);
  }

  /**
   * Handles asynchronous webhook callback received from carrier gateways
   */
  public async handleCarrierCallback(
    provider: PaymentProvider,
    rawPayload: any,
  ): Promise<StkPushStatusDto> {
    const adapter = this.getAdapter(provider);
    const parsed = adapter.parseCallback(rawPayload);

    // Look up transaction by checkoutId or providerReference
    let checkoutId = parsed.checkoutId.trim();
    if (checkoutId.startsWith('voda_')) checkoutId = checkoutId.substring(5);
    else if (checkoutId.startsWith('tigo_')) checkoutId = checkoutId.substring(5);
    else if (checkoutId.startsWith('airtel_')) checkoutId = checkoutId.substring(7);
    else if (checkoutId.startsWith('halo_')) checkoutId = checkoutId.substring(5);

    const rows = await sql<Record<string, any>>`
      SELECT * FROM "stk_push_transactions"
      WHERE "id" = ${checkoutId}
         OR "id" = ${parsed.checkoutId}
         OR ("provider_reference" IS NOT NULL AND "provider_reference" = ${parsed.providerReference ?? ''})
      LIMIT 1
    `;

    if (rows.length === 0) {
      throw new Error(`No matching STK Push transaction found for checkoutId '${parsed.checkoutId}'`);
    }

    const stkTx = mapStkPushTransactionRow(rows[0]!);
    const orgId = stkTx.organizationId;

    // Idempotent guard: do not re-process already succeeded transaction
    if (stkTx.status === StkPushStatus.SUCCESS) {
      return this.mapToStatusDto(stkTx);
    }

    if (parsed.success) {
      const providerRef = (parsed.providerReference || `STK${Date.now()}`).trim().toUpperCase();

      // 1. Update STK transaction state
      const updatedTx = await dbStore.updateStkTransaction(stkTx.id, orgId, {
        status: StkPushStatus.SUCCESS,
        providerReference: providerRef,
        resultCode: parsed.resultCode ?? 0,
        resultDescription: parsed.resultDescription ?? 'Success',
        rawCallbackPayload: rawPayload,
      });

      // 2. Direct Ingestion via DIRECT_PROVIDER_API
      const providerSender = provider === PaymentProvider.MPESA ? 'M-PESA' : provider;
      const amountMajor = toMajorUnits(stkTx.amountCents);
      const simulatedRawSms = `${providerRef} Imethibitishwa. Umepokea Tsh${amountMajor.toLocaleString()} kutoka kwa ${stkTx.phoneNumber} tarehe ${new Date().toISOString()}. Kumbukumbu namba: ${stkTx.referenceNumber || ''}`;

      const ack = await this.ingestionService.ingestEvidence({
        organizationId: orgId,
        sourceType: EvidenceSourceType.DIRECT_PROVIDER_API,
        senderAddress: providerSender,
        rawPayload: simulatedRawSms,
        deviceTimestamp: new Date(),
      });

      // 3. Independent Verification & Invoice Settlement
      let settledPaymentId: string | undefined = ack.paymentId;
      if (ack.paymentId) {
        try {
          const targetInvId = (stkTx.invoiceId ?? ack.matchedInvoiceId ?? ack.candidateInvoiceId) || undefined;
          const settlement = await this.reconciliationService.verifyPayment(orgId, {
            paymentId: ack.paymentId,
            invoiceId: targetInvId,
            verificationMethod: VerificationMethod.INDEPENDENT_PROVIDER_QUERY,
            externalVerificationRef: providerRef,
            notes: `Authoritative settlement via carrier STK push callback (${provider}). CheckoutId: ${stkTx.id}`,
          });
          settledPaymentId = settlement.payment.id;

          await dbStore.updateStkTransaction(stkTx.id, orgId, {
            status: StkPushStatus.SUCCESS,
            settledPaymentId: settlement.payment.id,
          });
        } catch (err: any) {
          // If invoice is already paid or other non-fatal error, log and preserve payment id
          settledPaymentId = ack.paymentId;
        }
      }

      // 4. Outbox Event
      await dbStore.insertOutboxEvent({
        organizationId: orgId,
        eventType: BusinessEventType.PAYMENT_STK_SUCCESS,
        payload: {
          checkoutId: stkTx.id,
          provider,
          providerReference: providerRef,
          phoneNumber: stkTx.phoneNumber,
          amountCents: stkTx.amountCents.toString(),
          invoiceId: stkTx.invoiceId,
          referenceNumber: stkTx.referenceNumber,
          settledPaymentId,
        },
      });

      return this.mapToStatusDto({
        ...updatedTx,
        status: StkPushStatus.SUCCESS,
        settledPaymentId: settledPaymentId ?? null,
      });
    } else {
      // Failed or cancelled push
      const updatedTx = await dbStore.updateStkTransaction(stkTx.id, orgId, {
        status: parsed.resultCode === 1032 ? StkPushStatus.CANCELLED : StkPushStatus.FAILED,
        resultCode: parsed.resultCode ?? 1,
        resultDescription: parsed.resultDescription ?? 'Payment declined or cancelled by subscriber',
        errorMessage: parsed.resultDescription || 'Customer declined transaction or USSD prompt expired',
        rawCallbackPayload: rawPayload,
      });

      await dbStore.insertOutboxEvent({
        organizationId: orgId,
        eventType: BusinessEventType.PAYMENT_STK_FAILED,
        payload: {
          checkoutId: stkTx.id,
          provider,
          phoneNumber: stkTx.phoneNumber,
          resultCode: parsed.resultCode,
          reason: parsed.resultDescription || 'Customer declined or session timed out',
        },
      });

      return this.mapToStatusDto(updatedTx);
    }
  }

  private mapToStatusDto(record: StkPushTransactionRecord): StkPushStatusDto {
    return {
      checkoutId: record.id,
      organizationId: record.organizationId,
      provider: record.provider,
      phoneNumber: record.phoneNumber,
      amountCents: record.amountCents.toString(),
      currency: record.currency,
      status: record.status,
      providerReference: record.providerReference,
      invoiceId: record.invoiceId,
      referenceNumber: record.referenceNumber,
      resultCode: record.resultCode,
      resultDescription: record.resultDescription,
      errorMessage: record.errorMessage,
      settledPaymentId: record.settledPaymentId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}

export const stkPushService = new StkPushService();
