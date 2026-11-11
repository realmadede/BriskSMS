import { randomUUID } from 'node:crypto';
import {
  BusinessEventType,
  computeDeduplicationHash,
  detectTanzanianCarrier,
  EvidenceSourceType,
  InvoiceStatus,
  normalizeTanzanianPhone,
  PaymentProvider,
  StkPushRequestDto,
  StkPushResponseDto,
  StkPushStatus,
  StkPushStatusDto,
  toMinorUnits,
  TransactionState,
  VerificationMethod,
} from '@brisksms/shared';
import { assertTenantContext, withTransaction } from '@brisksms/db';
import {
  dbStore,
  mapInvoiceRow,
  mapStkPushTransactionRow,
  StkPushTransactionRecord,
} from '../../core/store.js';
import { HttpException } from '../../core/http.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import {
  AirtelStkAdapter,
  HalopesaStkAdapter,
  MpesaStkAdapter,
  StkPushAdapter,
  TigoStkAdapter,
} from './adapters/index.js';
import {
  CallbackVerificationRequest,
  CallbackVerifierRegistry,
  callbackVerifierRegistry,
} from './verifiers/index.js';

export class StkPushService {
  private readonly adapters: Map<PaymentProvider, StkPushAdapter> = new Map();

  constructor(
    private readonly reconciliationService: ReconciliationService = new ReconciliationService(),
    public readonly verifierRegistry: CallbackVerifierRegistry = callbackVerifierRegistry,
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
   * Handles asynchronous webhook callback received from carrier gateways.
   *
   * CRITICAL FINANCIAL INTEGRITY & TRUST BOUNDARY:
   * 1. Provider-specific callback verification MUST succeed before any processing.
   * 2. Transaction row MUST be locked (FOR UPDATE) within an ACID transaction.
   * 3. Provider, checkoutId, amount, currency, reference, and invoice association
   *    MUST match the original STK request.
   * 4. Idempotent replays MUST return existing terminal state without double-settling.
   * 5. Provider-confirmed evidence is recorded natively as immutable JSON without
   *    synthetic SMS strings.
   * 6. Target invoice settlement executes within the same atomic ACID transaction.
   */
  public async handleCarrierCallback(
    provider: PaymentProvider,
    reqOrPayload: CallbackVerificationRequest | any,
  ): Promise<StkPushStatusDto> {
    const verificationReq: CallbackVerificationRequest = (
      reqOrPayload && typeof reqOrPayload === 'object' && 'headers' in reqOrPayload
    )
      ? (reqOrPayload as CallbackVerificationRequest)
      : {
          provider,
          headers: {},
          body: reqOrPayload,
          rawBody: typeof reqOrPayload === 'string' ? reqOrPayload : JSON.stringify(reqOrPayload),
        };

    // 1. Enforce Provider-Specific Callback Authentication
    const verifier = this.verifierRegistry.getVerifier(provider);
    const verification = await verifier.verify(verificationReq);
    if (!verification.isValid) {
      if (verification.code === 'PROVIDER_CALLBACK_DISABLED') {
        throw new HttpException(
          403,
          'PROVIDER_CALLBACK_DISABLED',
          verification.reason || `Callbacks for provider '${provider}' are disabled by default until official authentication is configured`,
        );
      }
      throw new HttpException(
        401,
        verification.code || 'CALLBACK_AUTHENTICATION_FAILED',
        verification.reason || 'Callback authentication failed',
      );
    }

    // 2. Parse Provider Payload
    const adapter = this.getAdapter(provider);
    const parsed = adapter.parseCallback(verificationReq.body);

    let checkoutId = (parsed.checkoutId || '').trim();
    if (checkoutId.startsWith('voda_')) checkoutId = checkoutId.substring(5);
    else if (checkoutId.startsWith('tigo_')) checkoutId = checkoutId.substring(5);
    else if (checkoutId.startsWith('airtel_')) checkoutId = checkoutId.substring(7);
    else if (checkoutId.startsWith('halo_')) checkoutId = checkoutId.substring(5);

    if (!checkoutId) {
      throw new HttpException(400, 'MISSING_CHECKOUT_ID', 'Callback payload missing valid checkout identifier');
    }

    // 3. Atomic Database Verification & Settlement
    return withTransaction(async (tx) => {
      // Row lock the STK push transaction
      const rows = await tx<Record<string, any>>`
        SELECT * FROM "stk_push_transactions"
        WHERE "id" = ${checkoutId}
        FOR UPDATE
      `;

      if (rows.length === 0) {
        throw new HttpException(404, 'TRANSACTION_NOT_FOUND', `No STK Push transaction found for checkoutId '${checkoutId}'`);
      }

      const stkTx = mapStkPushTransactionRow(rows[0]!);
      const orgId = stkTx.organizationId;
      assertTenantContext({ organizationId: orgId });

      // Invariant: Provider in callback route must match provider recorded at initiation
      if (stkTx.provider !== provider) {
        throw new HttpException(
          422,
          'PROVIDER_MISMATCH',
          `Callback provider '${provider}' does not match original STK push transaction provider '${stkTx.provider}'`,
        );
      }

      // Idempotency: Already succeeded callbacks return existing status without re-settlement
      if (stkTx.status === StkPushStatus.SUCCESS) {
        return this.mapToStatusDto(stkTx);
      }

      // Terminal state guard: If already failed, cancelled, or expired, reject mutation
      if (
        stkTx.status === StkPushStatus.FAILED ||
        stkTx.status === StkPushStatus.CANCELLED ||
        stkTx.status === StkPushStatus.EXPIRED
      ) {
        return this.mapToStatusDto(stkTx);
      }

      // Preserve authentic original raw request bytes without reserialization
      const rawPayloadBytesStr: string = (
        typeof verificationReq.rawBody === 'string' && verificationReq.rawBody.length > 0
      )
        ? verificationReq.rawBody
        : Buffer.isBuffer(verificationReq.rawBodyBuffer)
          ? verificationReq.rawBodyBuffer.toString('utf-8')
          : Buffer.isBuffer(verificationReq.rawBody)
            ? verificationReq.rawBody.toString('utf-8')
            : (typeof verificationReq.body === 'string' ? verificationReq.body : JSON.stringify(verificationReq.body));

      const rawCallbackJson = typeof verificationReq.body === 'string'
        ? verificationReq.body
        : JSON.stringify(verificationReq.body);

      // Handle Provider Rejection / Cancellation
      if (!parsed.success) {
        const failureStatus = parsed.resultCode === 1032 ? StkPushStatus.CANCELLED : StkPushStatus.FAILED;

        await tx`
          UPDATE "stk_push_transactions"
          SET
            "status" = ${failureStatus}::"StkPushStatus",
            "result_code" = ${parsed.resultCode ?? 1},
            "result_description" = ${parsed.resultDescription ?? 'Payment declined or cancelled by subscriber'},
            "error_message" = ${parsed.resultDescription || 'Customer declined transaction or prompt expired'},
            "raw_callback_payload" = ${rawCallbackJson}::jsonb,
            "updated_at" = NOW()
          WHERE "id" = ${stkTx.id} AND "organization_id" = ${orgId}
        `;

        await dbStore.insertOutboxEvent(
          {
            organizationId: orgId,
            eventType: BusinessEventType.PAYMENT_STK_FAILED,
            payload: {
              checkoutId: stkTx.id,
              provider,
              phoneNumber: stkTx.phoneNumber,
              resultCode: parsed.resultCode,
              reason: parsed.resultDescription || 'Customer declined or session timed out',
            },
          },
          tx,
        );

        const updatedTx = await dbStore.getStkTransactionById(stkTx.id, orgId, tx);
        return this.mapToStatusDto(updatedTx || stkTx);
      }

      // =========================================================================
      // Settlement Authorization Enforcement (All Invariants Must Hold)
      // =========================================================================

      // A. Provider Transaction Reference validation
      const providerRef = (parsed.providerReference || '').trim().toUpperCase();
      if (!providerRef) {
        throw new HttpException(400, 'MISSING_PROVIDER_REFERENCE', 'Provider callback missing transaction reference');
      }

      // B. Transaction-scoped PostgreSQL Advisory Lock (Cross-Replica Concurrency Protection)
      // Deterministically serializes all concurrent claims for the same (provider, providerRef)
      await tx`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || ${provider} || ':' || ${providerRef}))`;

      // C. Cross-Organization & Platform-Wide Provider Reference Uniqueness Enforcement
      // 1. Check dedicated payment_reference_claims table
      const existingClaim = await tx`
        SELECT "id", "organization_id", "checkout_id" FROM "payment_reference_claims"
        WHERE "provider" = ${provider}::"PaymentProvider"
          AND "provider_reference" = ${providerRef}
        LIMIT 1
      `;
      if (existingClaim.length > 0 && existingClaim[0]!.checkout_id !== stkTx.id) {
        throw new HttpException(
          409,
          'REFERENCE_ALREADY_USED',
          `Provider reference '${providerRef}' has already been claimed on platform (organization: ${existingClaim[0]!.organization_id})`,
        );
      }

      // 2. Check normalized_payments platform-wide (across ALL organizations)
      const existingPay = await tx`
        SELECT "id", "organization_id" FROM "normalized_payments"
        WHERE "provider" = ${provider}::"PaymentProvider"
          AND "reference" = ${providerRef}
        LIMIT 1
      `;
      if (existingPay.length > 0 && existingPay[0]!.id !== stkTx.settledPaymentId) {
        throw new HttpException(
          409,
          'REFERENCE_ALREADY_USED',
          `Provider reference '${providerRef}' has already been redeemed in normalized payment '${existingPay[0]!.id}'`,
        );
      }

      // 3. Check stk_push_transactions platform-wide (across ALL organizations)
      const otherStk = await tx`
        SELECT "id", "organization_id" FROM "stk_push_transactions"
        WHERE "provider" = ${provider}::"PaymentProvider"
          AND "provider_reference" = ${providerRef}
          AND "id" != ${stkTx.id}
          AND "status" = 'SUCCESS'
        LIMIT 1
      `;
      if (otherStk.length > 0) {
        throw new HttpException(
          409,
          'REFERENCE_ALREADY_USED',
          `Provider reference '${providerRef}' is already bound to successful STK transaction '${otherStk[0]!.id}'`,
        );
      }

      // C. Amount Exact Match (to the cent)
      if (parsed.amountCents === undefined || parsed.amountCents === null) {
        throw new HttpException(400, 'MISSING_CALLBACK_AMOUNT', 'Callback payload missing payment amount');
      }
      const callbackAmountCents = BigInt(parsed.amountCents);
      if (callbackAmountCents !== stkTx.amountCents) {
        throw new HttpException(
          422,
          'AMOUNT_MISMATCH',
          `Callback amount (${callbackAmountCents.toString()}) does not match requested STK amount (${stkTx.amountCents.toString()})`,
        );
      }

      // D. Currency Match (Strict / Fail Closed): Callback currency MUST be present and match requested currency
      const callbackCurrency = (parsed.currency || '').trim().toUpperCase();
      if (!callbackCurrency) {
        throw new HttpException(
          422,
          'MISSING_CALLBACK_CURRENCY',
          'Callback payload missing required transaction currency',
        );
      }
      if (callbackCurrency !== stkTx.currency.trim().toUpperCase()) {
        throw new HttpException(
          422,
          'CURRENCY_MISMATCH',
          `Callback currency '${callbackCurrency}' does not match requested currency '${stkTx.currency}'`,
        );
      }

      // E. Merchant Reference Match
      if (
        stkTx.referenceNumber &&
        parsed.referenceNumber &&
        parsed.referenceNumber.trim().toUpperCase() !== stkTx.referenceNumber.trim().toUpperCase()
      ) {
        throw new HttpException(
          422,
          'REFERENCE_MISMATCH',
          `Callback reference '${parsed.referenceNumber}' does not match requested reference '${stkTx.referenceNumber}'`,
        );
      }

      // F. Lock Target Invoice (if bound)
      const targetInvoiceId = stkTx.invoiceId || undefined;
      if (targetInvoiceId) {
        const invRows = await tx`
          SELECT * FROM "invoices"
          WHERE "id" = ${targetInvoiceId} AND "organization_id" = ${orgId}
          FOR UPDATE
        `;
        if (invRows.length === 0) {
          throw new HttpException(404, 'INVOICE_NOT_FOUND', `Target invoice '${targetInvoiceId}' not found in organization`);
        }
        const inv = mapInvoiceRow(invRows[0]!);
        if (inv.status === InvoiceStatus.VOID || inv.status === InvoiceStatus.REFUNDED) {
          throw new HttpException(422, 'INVOICE_NOT_PAYABLE', `Target invoice '${targetInvoiceId}' is in non-payable state '${inv.status}'`);
        }
      }

      // =========================================================================
      // Provider-Native Evidence Persistence & Normalization (No Synthetic SMS)
      // =========================================================================
      const evidenceId = randomUUID();
      const paymentId = randomUUID();
      const providerTimestamp = parsed.providerTimestamp || new Date();
      const deduplicationHash = computeDeduplicationHash(
        orgId,
        provider,
        providerRef,
        stkTx.amountCents,
        providerTimestamp,
      );

      // 1. Immutable Raw Evidence with actual original request payload bytes (without reserialization)
      await tx`
        INSERT INTO "raw_payment_evidence" (
          "id", "organization_id", "source_type", "device_id", "sender_address",
          "raw_payload", "sim_slot", "device_timestamp", "signature", "nonce",
          "sequence_number", "parser_version", "parse_status"
        )
        VALUES (
          ${evidenceId},
          ${orgId},
          ${EvidenceSourceType.DIRECT_PROVIDER_API}::"EvidenceSourceType",
          NULL,
          ${`PROVIDER_API_${provider}`},
          ${rawPayloadBytesStr},
          1,
          ${providerTimestamp},
          ${typeof verificationReq.headers['x-signature'] === 'string' ? verificationReq.headers['x-signature'] : null},
          ${typeof verificationReq.headers['x-nonce'] === 'string' ? verificationReq.headers['x-nonce'] : null},
          NULL,
          '1.0.0',
          'OBSERVED'
        )
      `;

      // 2. Durable payment reference claim registration (enforcing platform-wide uniqueness)
      await tx`
        INSERT INTO "payment_reference_claims" (
          "provider", "provider_reference", "organization_id", "checkout_id", "payment_id"
        )
        VALUES (
          ${provider}::"PaymentProvider",
          ${providerRef},
          ${orgId},
          ${stkTx.id},
          ${paymentId}
        )
      `;

      // 3. Normalized Payment created directly from verified provider data
      await tx`
        INSERT INTO "normalized_payments" (
          "id", "organization_id", "device_id", "raw_evidence_id", "provider",
          "reference", "amount_cents", "currency", "sender_phone", "sender_name",
          "recipient_account", "customer_memo", "provider_timestamp", "parser_version",
          "state", "deduplication_hash", "matched_invoice_id", "candidate_invoice_id"
        )
        VALUES (
          ${paymentId},
          ${orgId},
          NULL,
          ${evidenceId},
          ${provider}::"PaymentProvider",
          ${providerRef},
          ${stkTx.amountCents.toString()}::bigint,
          ${stkTx.currency},
          ${parsed.phoneNumber || stkTx.phoneNumber},
          ${parsed.customerName ?? null},
          NULL,
          ${stkTx.memo ?? null},
          ${providerTimestamp},
          '1.0.0',
          ${TransactionState.MATCHED}::"TransactionState",
          ${deduplicationHash},
          ${targetInvoiceId ?? null},
          ${targetInvoiceId ?? null}
        )
      `;

      // 4. Invoice Settlement via Reconciliation Service
      let settledPaymentId: string | undefined = paymentId;
      if (targetInvoiceId) {
        const settlement = await this.reconciliationService.verifyPayment(
          orgId,
          {
            paymentId,
            invoiceId: targetInvoiceId,
            verificationMethod: VerificationMethod.INDEPENDENT_PROVIDER_QUERY,
            externalVerificationRef: providerRef,
            notes: `Authoritative settlement via verified carrier STK push callback (${provider}). CheckoutId: ${stkTx.id}`,
          },
          tx,
        );
        settledPaymentId = settlement.payment.id;
      }

      // 5. Update STK Push Transaction to SUCCESS
      await tx`
        UPDATE "stk_push_transactions"
        SET
          "status" = ${StkPushStatus.SUCCESS}::"StkPushStatus",
          "provider_reference" = ${providerRef},
          "result_code" = ${parsed.resultCode ?? 0},
          "result_description" = ${parsed.resultDescription ?? 'Success'},
          "settled_payment_id" = ${settledPaymentId},
          "raw_callback_payload" = ${rawCallbackJson}::jsonb,
          "updated_at" = NOW()
        WHERE "id" = ${stkTx.id} AND "organization_id" = ${orgId}
      `;

      // 6. Outbox Event
      await dbStore.insertOutboxEvent(
        {
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
        },
        tx,
      );

      const updatedTx = await dbStore.getStkTransactionById(stkTx.id, orgId, tx);
      return this.mapToStatusDto(updatedTx || stkTx);
    });
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
