import { createHash, randomUUID } from 'node:crypto';
import {
  BusinessEventType,
  computeDeduplicationHash,
  EvidenceSourceType,
  inferCarrierHintFromPrefix,
  InvoiceStatus,
  normalizeTanzanianPhone,
  PaymentProvider,
  StkDispatchOutcome,
  StkPushRequestDto,
  StkPushResponseDto,
  StkPushStatus,
  StkPushStatusDto,
  toMinorUnits,
  TransactionState,
  VerificationMethod,
} from '@brisksms/shared';
import { assertTenantContext, sql, SqlExecutor } from '@brisksms/db';
import {
  dbStore,
  mapInvoiceRow,
  mapNormalizedPaymentRow,
  mapStkPushTransactionRow,
  StkPushTransactionRecord,
} from '../../core/store.js';
import { HttpException } from '../../core/http.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import {
  PaymentReferenceClaimService,
  paymentReferenceClaimService,
} from '../reconciliation/payment-reference-claim.service.js';
import {
  stkAdapterRegistry,
  StkAdapterRegistry,
  StkInitiateResult,
  StkPushAdapter,
} from './adapters/index.js';
import {
  CallbackVerificationRequest,
  CallbackVerifierRegistry,
  callbackVerifierRegistry,
} from './verifiers/index.js';

function sanitizeDispatchErrorMessage(raw: unknown, fallback: string): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  const cleaned = text
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)([^:@\s]+):([^@\s]+)@/gi, '$1[REDACTED]:[REDACTED]@')
    .replace(/((?:api[_-]?key|secret|token|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}

export class StkPushService {
  constructor(
    private readonly reconciliationService: ReconciliationService = new ReconciliationService(),
    public readonly verifierRegistry: CallbackVerifierRegistry = callbackVerifierRegistry,
    private readonly claimService: PaymentReferenceClaimService = paymentReferenceClaimService,
    public readonly adapterRegistry: StkAdapterRegistry = stkAdapterRegistry,
  ) {}

  public registerAdapter(adapter: StkPushAdapter): void {
    this.adapterRegistry.registerAdapter(adapter);
  }

  public getAdapter(provider: PaymentProvider): StkPushAdapter {
    return this.adapterRegistry.getAdapter(provider);
  }

  /**
   * Initiates a Mobile Money STK / USSD Push via the registered carrier adapter.
   *
   * FAIL-CLOSED DISPATCH INVARIANTS:
   * - Unconfigured / unsupported providers fail closed before leaving our boundary (no simulated success).
   * - Checkout records start in INITIATING (never PENDING) before transport acceptance.
   * - provider_reference is NEVER fabricated or populated at initiation time.
   * - Transport timeouts/ambiguous errors record DISPATCH_UNCERTAIN and block blind retries.
   * - Org-scoped idempotency keys deduplicate retries without double-dispatching.
   */
  public async initiateStkPush(
    organizationId: string,
    dto: StkPushRequestDto,
  ): Promise<StkPushResponseDto> {
    assertTenantContext({ organizationId });

    if (!dto.phoneNumber || typeof dto.phoneNumber !== 'string') {
      throw new HttpException(400, 'VALIDATION_ERROR', 'phoneNumber is required and must be a valid string');
    }

    let normalizedPhone: string;
    try {
      normalizedPhone = normalizeTanzanianPhone(dto.phoneNumber);
    } catch (err: any) {
      throw new HttpException(400, 'VALIDATION_ERROR', err?.message || 'Invalid Tanzanian mobile phone number');
    }

    let provider: PaymentProvider;
    let routingResolution: 'EXPLICIT' | 'PREFIX_HEURISTIC';
    if (dto.provider !== undefined) {
      const validProviders = Object.values(PaymentProvider) as string[];
      const candidate = String(dto.provider).trim().toUpperCase();
      if (!validProviders.includes(candidate)) {
        throw new HttpException(
          400,
          'VALIDATION_ERROR',
          `Invalid payment provider '${dto.provider}'. Expected one of: ${validProviders.join(', ')}`,
        );
      }
      provider = candidate as PaymentProvider;
      routingResolution = 'EXPLICIT';
    } else {
      try {
        provider = inferCarrierHintFromPrefix(normalizedPhone);
        routingResolution = 'PREFIX_HEURISTIC';
      } catch (err: any) {
        throw new HttpException(400, 'VALIDATION_ERROR', err?.message || 'Invalid Tanzanian mobile phone number');
      }
    }

    if (dto.amount === undefined || dto.amount === null || !Number.isFinite(Number(dto.amount)) || Number(dto.amount) <= 0) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'amount must be a positive numeric value');
    }

    const amountCents = toMinorUnits(dto.amount);
    const currency = (dto.currency || 'TZS').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new HttpException(400, 'VALIDATION_ERROR', `Invalid ISO currency code '${dto.currency}'`);
    }

    const idempotencyKey = dto.idempotencyKey?.trim() || undefined;
    if (dto.idempotencyKey !== undefined && !idempotencyKey) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey cannot be blank when provided');
    }
    if (idempotencyKey && idempotencyKey.length > 120) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey must be 120 characters or fewer');
    }

    let targetInvoiceId: string | undefined = dto.invoiceId;
    let targetReferenceNumber: string | undefined = dto.referenceNumber;

    if (targetInvoiceId) {
      const inv = await this.reconciliationService.findInvoiceById(organizationId, targetInvoiceId);
      if (!inv) {
        throw new HttpException(404, 'INVOICE_NOT_FOUND', `Invoice '${targetInvoiceId}' not found in organization`);
      }
      if (inv.status === InvoiceStatus.VOID || inv.status === InvoiceStatus.REFUNDED) {
        throw new HttpException(
          422,
          'INVOICE_NOT_PAYABLE',
          `Invoice '${targetInvoiceId}' is in non-payable status '${inv.status}'`,
        );
      }
      targetReferenceNumber = targetReferenceNumber || inv.referenceNumber;
    }

    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          organizationId,
          provider,
          phoneNumber: normalizedPhone,
          amountCents: amountCents.toString(),
          currency,
          invoiceId: targetInvoiceId ?? null,
          referenceNumber: targetReferenceNumber ?? null,
        }),
      )
      .digest('hex');

    const adapter = this.getAdapter(provider);
    const checkoutId = `stk_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // Phase A: Atomic idempotency check + INITIATING / pre-dispatch UNSUPPORTED reservation
    const reservation = await this.claimService.executeWithSerializationRetry(async (tx) => {
      if (idempotencyKey) {
        const existingRows = await tx<Record<string, any>>`
          SELECT * FROM "stk_push_transactions"
          WHERE "organization_id" = ${organizationId} AND "idempotency_key" = ${idempotencyKey}
          FOR UPDATE
        `;
        if (existingRows.length > 0) {
          const existing = mapStkPushTransactionRow(existingRows[0]!);
          if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
            throw new HttpException(
              409,
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key has already been used with different STK push parameters',
              { checkoutId: existing.id },
            );
          }
          return { existing, isNew: false as const };
        }
      }

      const initialStatus = adapter.isConfigured
        ? StkPushStatus.INITIATING
        : StkPushStatus.UNSUPPORTED;

      let initialOutcome: StkDispatchOutcome | null = null;
      let initialErrorMessage: string | null = null;
      let failClosedResult: StkInitiateResult | null = null;

      if (!adapter.isConfigured) {
        failClosedResult = await adapter.initiatePush({
          checkoutId,
          organizationId,
          phoneNumber: normalizedPhone,
          amountCents,
          currency,
          referenceNumber: targetReferenceNumber,
          memo: dto.memo,
          idempotencyKey,
        });
        initialOutcome = failClosedResult.outcome === 'UNCONFIGURED' ? 'UNCONFIGURED' : 'UNSUPPORTED';
        initialErrorMessage = sanitizeDispatchErrorMessage(
          failClosedResult.errorMessage,
          `STK push dispatch is not available for provider '${provider}'`,
        );
      }

      const created = await dbStore.createStkTransaction(
        {
          id: checkoutId,
          organizationId,
          provider,
          phoneNumber: normalizedPhone,
          amountCents,
          currency,
          status: initialStatus,
          invoiceId: targetInvoiceId ?? null,
          referenceNumber: targetReferenceNumber ?? null,
          memo: dto.memo ?? null,
          idempotencyKey: idempotencyKey ?? null,
          requestFingerprint,
          providerCheckoutId: null,
          dispatchOutcome: initialOutcome,
          metadata: {
            ...(dto.metadata ?? {}),
            routingResolution,
          },
        },
        tx,
      );

      if (!adapter.isConfigured && initialErrorMessage) {
        await dbStore.updateStkTransaction(
          created.id,
          organizationId,
          {
            status: StkPushStatus.UNSUPPORTED,
            dispatchOutcome: initialOutcome,
            errorMessage: initialErrorMessage,
          },
          tx,
        );
      }

      return {
        existing: created,
        isNew: true as const,
        failClosedResult,
        initialOutcome,
        initialErrorMessage,
      };
    });

    if (!reservation.isNew) {
      return this.resolveExistingIdempotentInitiation(reservation.existing);
    }

    if (!adapter.isConfigured) {
      const outcome = reservation.initialOutcome ?? 'UNSUPPORTED';
      const code =
        reservation.failClosedResult?.code ??
        (outcome === 'UNCONFIGURED' ? 'PROVIDER_DISPATCH_DISABLED' : 'UNSUPPORTED_STK_PROVIDER');
      const statusCode = outcome === 'UNCONFIGURED' ? 503 : 422;
      throw new HttpException(
        statusCode,
        code,
        reservation.initialErrorMessage || `Carrier STK push dispatch is disabled or unsupported for '${provider}'`,
        {
          checkoutId: reservation.existing.id,
          provider,
          status: StkPushStatus.UNSUPPORTED,
          outcome,
          retryable: false,
        },
      );
    }

    // Phase B: Outbound Carrier Dispatch (outside DB row lock so network I/O does not hold PG locks)
    let pushResult: StkInitiateResult;
    try {
      pushResult = await adapter.initiatePush({
        checkoutId: reservation.existing.id,
        organizationId,
        phoneNumber: normalizedPhone,
        amountCents,
        currency,
        referenceNumber: targetReferenceNumber,
        memo: dto.memo,
        idempotencyKey,
      });
    } catch (transportErr) {
      const safeErr = sanitizeDispatchErrorMessage(
        transportErr,
        `Carrier transport error while dispatching '${provider}' STK push; outcome uncertain`,
      );
      await dbStore.updateStkTransaction(reservation.existing.id, organizationId, {
        status: StkPushStatus.DISPATCH_UNCERTAIN,
        dispatchOutcome: 'UNCERTAIN',
        errorMessage: safeErr,
      });
      throw new HttpException(504, 'STK_DISPATCH_UNCERTAIN', safeErr, {
        checkoutId: reservation.existing.id,
        provider,
        status: StkPushStatus.DISPATCH_UNCERTAIN,
        retryable: false,
      });
    }

    // Fail-closed validation on adapter result
    if (pushResult.outcome === 'ACCEPTED' && pushResult.success === true && pushResult.customerPrompt) {
      const updated = await this.claimService.executeWithSerializationRetry(async (tx) => {
        const nextMeta: Record<string, unknown> = {
          ...(reservation.existing.metadata ?? {}),
          customerPrompt: pushResult.customerPrompt,
        };
        await tx`
          UPDATE "stk_push_transactions"
          SET
            "status" = ${StkPushStatus.PENDING}::"StkPushStatus",
            "provider_checkout_id" = ${pushResult.providerCheckoutId ?? null},
            "dispatch_outcome" = 'ACCEPTED',
            "metadata" = ${JSON.stringify(nextMeta)}::jsonb,
            "updated_at" = NOW()
          WHERE "id" = ${reservation.existing.id} AND "organization_id" = ${organizationId}
        `;

        await dbStore.insertOutboxEvent(
          {
            organizationId,
            eventType: BusinessEventType.PAYMENT_STK_INITIATED,
            payload: {
              checkoutId: reservation.existing.id,
              provider,
              phoneNumber: normalizedPhone,
              amountCents: amountCents.toString(),
              currency,
              invoiceId: targetInvoiceId,
              referenceNumber: targetReferenceNumber,
              initiatedAt: reservation.existing.createdAt.toISOString(),
            },
          },
          tx,
        );

        const row = await dbStore.getStkTransactionById(reservation.existing.id, organizationId, tx);
        return row ?? reservation.existing;
      });

      return this.mapToResponseDto(updated, pushResult.customerPrompt);
    }

    if (pushResult.outcome === 'UNCONFIGURED' || pushResult.outcome === 'UNSUPPORTED') {
      const safeErr = sanitizeDispatchErrorMessage(
        pushResult.errorMessage,
        `Carrier STK push dispatch is not available for '${provider}'`,
      );
      await dbStore.updateStkTransaction(reservation.existing.id, organizationId, {
        status: StkPushStatus.UNSUPPORTED,
        dispatchOutcome: pushResult.outcome,
        errorMessage: safeErr,
      });
      throw new HttpException(
        pushResult.outcome === 'UNCONFIGURED' ? 503 : 422,
        pushResult.code || (pushResult.outcome === 'UNCONFIGURED' ? 'PROVIDER_DISPATCH_DISABLED' : 'UNSUPPORTED_STK_PROVIDER'),
        safeErr,
        {
          checkoutId: reservation.existing.id,
          provider,
          status: StkPushStatus.UNSUPPORTED,
          outcome: pushResult.outcome,
          retryable: false,
        },
      );
    }

    if (pushResult.outcome === 'DEFINITIVE_FAILURE') {
      const safeErr = sanitizeDispatchErrorMessage(
        pushResult.errorMessage,
        'Carrier rejected STK push initiation request prior to transmission',
      );
      await this.claimService.executeWithSerializationRetry(async (tx) => {
        await dbStore.updateStkTransaction(
          reservation.existing.id,
          organizationId,
          {
            status: StkPushStatus.FAILED,
            dispatchOutcome: 'DEFINITIVE_FAILURE',
            errorMessage: safeErr,
          },
          tx,
        );
        await dbStore.insertOutboxEvent(
          {
            organizationId,
            eventType: BusinessEventType.PAYMENT_STK_FAILED,
            payload: {
              checkoutId: reservation.existing.id,
              provider,
              providerReference: null,
              phoneNumber: normalizedPhone,
              reason: safeErr,
            },
          },
          tx,
        );
      });
      throw new HttpException(502, pushResult.code || 'CARRIER_DISPATCH_FAILED', safeErr, {
        checkoutId: reservation.existing.id,
        provider,
        status: StkPushStatus.FAILED,
        retryable: Boolean(pushResult.retryable),
      });
    }

    // Any UNCERTAIN outcome or malformed/non-ACCEPTED result fails closed as DISPATCH_UNCERTAIN
    const uncertainMsg = sanitizeDispatchErrorMessage(
      pushResult.errorMessage,
      `Carrier dispatch returned an uncertain outcome for '${provider}'; automatic retry blocked`,
    );
    await dbStore.updateStkTransaction(reservation.existing.id, organizationId, {
      status: StkPushStatus.DISPATCH_UNCERTAIN,
      dispatchOutcome: 'UNCERTAIN',
      errorMessage: uncertainMsg,
    });
    throw new HttpException(504, pushResult.code || 'STK_DISPATCH_UNCERTAIN', uncertainMsg, {
      checkoutId: reservation.existing.id,
      provider,
      status: StkPushStatus.DISPATCH_UNCERTAIN,
      retryable: false,
    });
  }

  private resolveExistingIdempotentInitiation(existing: StkPushTransactionRecord): StkPushResponseDto {
    if (existing.status === StkPushStatus.PENDING || existing.status === StkPushStatus.SUCCESS) {
      const storedPrompt =
        typeof existing.metadata?.customerPrompt === 'string'
          ? existing.metadata.customerPrompt
          : `STK Push request ${existing.id} (${existing.provider}) already accepted.`;
      return this.mapToResponseDto(existing, storedPrompt);
    }

    if (existing.status === StkPushStatus.DISPATCH_UNCERTAIN) {
      throw new HttpException(
        409,
        'STK_DISPATCH_UNCERTAIN',
        'Previous STK push attempt with this idempotencyKey had an uncertain carrier outcome. Re-dispatch is blocked to prevent duplicate prompts.',
        {
          checkoutId: existing.id,
          provider: existing.provider,
          status: existing.status,
          retryable: false,
        },
      );
    }

    if (existing.status === StkPushStatus.INITIATING) {
      throw new HttpException(
        409,
        'STK_INITIATION_IN_PROGRESS',
        'An STK push initiation with this idempotencyKey is currently in progress.',
        {
          checkoutId: existing.id,
          provider: existing.provider,
          status: existing.status,
          retryable: false,
        },
      );
    }

    if (existing.status === StkPushStatus.UNSUPPORTED) {
      const isUnconfigured = existing.dispatchOutcome === 'UNCONFIGURED';
      throw new HttpException(
        isUnconfigured ? 503 : 422,
        isUnconfigured ? 'PROVIDER_DISPATCH_DISABLED' : 'UNSUPPORTED_STK_PROVIDER',
        existing.errorMessage || `Carrier STK push is disabled or unsupported for '${existing.provider}'`,
        {
          checkoutId: existing.id,
          provider: existing.provider,
          status: existing.status,
          outcome: existing.dispatchOutcome ?? 'UNSUPPORTED',
          retryable: false,
        },
      );
    }

    throw new HttpException(
      502,
      'CARRIER_DISPATCH_FAILED',
      existing.errorMessage || 'Previous carrier STK push initiation failed',
      {
        checkoutId: existing.id,
        provider: existing.provider,
        status: existing.status,
        retryable: false,
      },
    );
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

    const checkoutId = (parsed.checkoutId || '').trim();
    if (!checkoutId) {
      throw new HttpException(400, 'MISSING_CHECKOUT_ID', 'Callback payload missing valid checkout identifier');
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

    // 3. Handle Provider Rejection / Cancellation (no provider reference claim needed; Level 3 lock only)
    if (!parsed.success) {
      return this.claimService.executeWithSerializationRetry(async (tx) => {
        const rows = await tx<Record<string, any>>`
          SELECT * FROM "stk_push_transactions"
          WHERE "id" = ${checkoutId}
             OR ("provider_checkout_id" = ${checkoutId} AND "provider" = ${provider}::"PaymentProvider")
          FOR UPDATE
        `;
        if (rows.length === 0) {
          throw new HttpException(404, 'TRANSACTION_NOT_FOUND', `No STK Push transaction found for checkoutId '${checkoutId}'`);
        }

        const stkTx = mapStkPushTransactionRow(rows[0]!);
        const orgId = stkTx.organizationId;
        assertTenantContext({ organizationId: orgId });

        if (stkTx.provider !== provider) {
          throw new HttpException(
            422,
            'PROVIDER_MISMATCH',
            `Callback provider '${provider}' does not match original STK push transaction provider '${stkTx.provider}'`,
          );
        }

        if (stkTx.status !== StkPushStatus.PENDING) {
          return this.mapToStatusDto(stkTx);
        }

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
              providerReference: null,
              phoneNumber: stkTx.phoneNumber,
              resultCode: parsed.resultCode,
              reason: parsed.resultDescription || 'Customer declined or session timed out',
            },
          },
          tx,
        );

        const updatedTx = await dbStore.getStkTransactionById(stkTx.id, orgId, tx);
        return this.mapToStatusDto(updatedTx || stkTx);
      });
    }

    // 4. Canonicalize (provider, reference) BEFORE opening any row locks so lock order stays strictly ascending:
    //    Level 1 (Advisory) -> Level 2 (Claim) -> Level 3 (STK Checkout) -> Level 4 (Payment) -> Level 5 (Invoice)
    const rawRef = parsed.providerReference || '';
    if (!rawRef.trim()) {
      const peekRows = await sql<Record<string, any>>`
        SELECT * FROM "stk_push_transactions"
        WHERE "id" = ${checkoutId}
           OR ("provider_checkout_id" = ${checkoutId} AND "provider" = ${provider}::"PaymentProvider")
        LIMIT 1
      `;
      if (peekRows.length === 0) {
        throw new HttpException(404, 'TRANSACTION_NOT_FOUND', `No STK Push transaction found for checkoutId '${checkoutId}'`);
      }
      const peekTx = mapStkPushTransactionRow(peekRows[0]!);
      if (peekTx.provider !== provider) {
        throw new HttpException(
          422,
          'PROVIDER_MISMATCH',
          `Callback provider '${provider}' does not match original STK push transaction provider '${peekTx.provider}'`,
        );
      }
      if (peekTx.status !== StkPushStatus.PENDING) {
        return this.mapToStatusDto(peekTx);
      }
      throw new HttpException(400, 'MISSING_PROVIDER_REFERENCE', 'Provider callback missing transaction reference');
    }

    const normProvider = this.claimService.normalizeProvider(provider);
    const normRef = this.claimService.normalizeReference(rawRef);

    // 5. Atomic Database Verification & Settlement (Strictly Ordered Locks + Serialization Retry)
    return this.claimService.executeWithSerializationRetry(async (tx) => {
      // Lock Order Level 1 + Level 2: Global advisory lock & claim row lock BEFORE checkout lock
      const existingClaim = await this.claimService.lockClaimRow(tx, normProvider, normRef);

      // Lock Order Level 3: Row lock the STK push transaction
      const rows = await tx<Record<string, any>>`
        SELECT * FROM "stk_push_transactions"
        WHERE "id" = ${checkoutId}
           OR ("provider_checkout_id" = ${checkoutId} AND "provider" = ${normProvider}::"PaymentProvider")
        FOR UPDATE
      `;

      if (rows.length === 0) {
        throw new HttpException(404, 'TRANSACTION_NOT_FOUND', `No STK Push transaction found for checkoutId '${checkoutId}'`);
      }

      const stkTx = mapStkPushTransactionRow(rows[0]!);
      const orgId = stkTx.organizationId;
      assertTenantContext({ organizationId: orgId });

      // Invariant: Provider in callback route must match provider recorded at initiation
      if (stkTx.provider !== normProvider) {
        throw new HttpException(
          422,
          'PROVIDER_MISMATCH',
          `Callback provider '${normProvider}' does not match original STK push transaction provider '${stkTx.provider}'`,
        );
      }

      // Idempotency: Already succeeded callbacks return existing status without re-settlement
      if (stkTx.status === StkPushStatus.SUCCESS) {
        if (stkTx.providerReference && stkTx.providerReference.trim().toUpperCase() !== normRef) {
          throw new HttpException(
            409,
            'REFERENCE_ALREADY_USED',
            `Checkout '${stkTx.id}' was already settled with reference '${stkTx.providerReference}'.`,
          );
        }
        return this.mapToStatusDto(stkTx);
      }

      // Non-PENDING state guard: Only PENDING checkouts (confirmed accepted by carrier) may settle.
      if (stkTx.status !== StkPushStatus.PENDING) {
        return this.mapToStatusDto(stkTx);
      }

      // Amount Exact Match (to the cent)
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

      // Currency Match (Strict / Fail Closed): Callback currency MUST be present and match requested currency
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

      // Merchant Reference Match
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

      // Un-locked pre-check of Target Invoice payability so Level 5 locks never precede Level 4
      const targetInvoiceId = stkTx.invoiceId || undefined;
      if (targetInvoiceId) {
        const invRows = await tx`
          SELECT * FROM "invoices"
          WHERE "id" = ${targetInvoiceId} AND "organization_id" = ${orgId}
        `;
        if (invRows.length === 0) {
          throw new HttpException(404, 'INVOICE_NOT_FOUND', `Target invoice '${targetInvoiceId}' not found in organization`);
        }
        const inv = mapInvoiceRow(invRows[0]!);
        if (inv.status === InvoiceStatus.VOID || inv.status === InvoiceStatus.REFUNDED) {
          throw new HttpException(422, 'INVOICE_NOT_PAYABLE', `Target invoice '${targetInvoiceId}' is in non-payable state '${inv.status}'`);
        }
      }

      // Level 4: Inspect any existing same-org provisional payment bound to this reference
      let existingSameOrgPayment = null as ReturnType<typeof mapNormalizedPaymentRow> | null;
      if (existingClaim && existingClaim.organizationId === orgId && existingClaim.paymentId) {
        const sameOrgPayRows = await tx`
          SELECT * FROM "normalized_payments"
          WHERE "id" = ${existingClaim.paymentId} AND "organization_id" = ${orgId}
          FOR UPDATE
        `;
        if (sameOrgPayRows[0]) {
          existingSameOrgPayment = mapNormalizedPaymentRow(sameOrgPayRows[0]);
        }
      }

      const canReuseSameOrgPayment =
        existingSameOrgPayment !== null &&
        existingSameOrgPayment.amountCents === stkTx.amountCents &&
        existingSameOrgPayment.currency.trim().toUpperCase() === stkTx.currency.trim().toUpperCase();

      if (
        existingSameOrgPayment &&
        existingSameOrgPayment.state === TransactionState.VERIFIED &&
        targetInvoiceId &&
        existingSameOrgPayment.matchedInvoiceId &&
        existingSameOrgPayment.matchedInvoiceId !== targetInvoiceId
      ) {
        throw new HttpException(
          409,
          'REFERENCE_ALREADY_USED',
          `Provider reference '${normRef}' was already manually settled against another invoice in this organization.`,
        );
      }

      const newPaymentId = randomUUID();
      const chosenPaymentId = canReuseSameOrgPayment ? existingSameOrgPayment!.id : newPaymentId;
      const evidenceId = randomUUID();
      const providerTimestamp = parsed.providerTimestamp || new Date();
      const deduplicationHash = computeDeduplicationHash(
        orgId,
        normProvider,
        normRef,
        stkTx.amountCents,
        providerTimestamp,
      );

      // If an unverified same-org SMS candidate had conflicting amount/currency, quarantine that candidate
      if (
        existingSameOrgPayment &&
        !canReuseSameOrgPayment &&
        existingSameOrgPayment.state !== TransactionState.VERIFIED
      ) {
        await tx`
          UPDATE "normalized_payments"
          SET
            "state" = ${TransactionState.REVIEW_REQUIRED}::"TransactionState",
            "review_reason" = 'CARRIER_AMOUNT_MISMATCH: Authoritative carrier callback conflicted with provisional SMS',
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${existingSameOrgPayment.id} AND "organization_id" = ${orgId}
        `;
      }

      // Confirm reference ownership atomically via PaymentReferenceClaimService
      // (Handles same-org PROVISIONAL upgrade, eviction of unverified competing provisional claims,
      // and cross-tenant settlement contradiction -> DISPUTED without silent reversal.)
      const claimResult = await this.claimService.confirmProviderReference(tx, {
        provider: normProvider,
        reference: normRef,
        organizationId: orgId,
        checkoutId: stkTx.id,
        paymentId: chosenPaymentId,
        amountCents: stkTx.amountCents,
        currency: stkTx.currency,
      });

      // Handle Delayed Contradictory Provider Callback (Claim transitioned -> DISPUTED)
      if (claimResult.outcome === 'DISPUTE_RAISED') {
        await this.insertProviderRawEvidence(
          tx,
          evidenceId,
          orgId,
          normProvider,
          rawPayloadBytesStr,
          providerTimestamp,
          verificationReq,
          'DISPUTE_FLAGGED',
        );

        const disputedPaymentId = chosenPaymentId;
        await tx`
          INSERT INTO "normalized_payments" (
            "id", "organization_id", "device_id", "raw_evidence_id", "provider",
            "reference", "amount_cents", "currency", "sender_phone", "sender_name",
            "recipient_account", "customer_memo", "provider_timestamp", "parser_version",
            "state", "deduplication_hash", "matched_invoice_id", "candidate_invoice_id", "review_reason"
          )
          VALUES (
            ${disputedPaymentId},
            ${orgId},
            NULL,
            ${evidenceId},
            ${normProvider}::"PaymentProvider",
            ${normRef},
            ${stkTx.amountCents.toString()}::bigint,
            ${stkTx.currency},
            ${parsed.phoneNumber || stkTx.phoneNumber},
            ${parsed.customerName ?? null},
            NULL,
            ${stkTx.memo ?? null},
            ${providerTimestamp},
            '1.0.0',
            ${TransactionState.REVIEW_REQUIRED}::"TransactionState",
            ${deduplicationHash},
            NULL,
            ${targetInvoiceId ?? null},
            'CLAIM_DISPUTED_PREVIOUSLY_SETTLED_BY_OTHER_ORG'
          )
        `;

        await tx`
          UPDATE "stk_push_transactions"
          SET
            "provider_reference" = ${normRef},
            "result_code" = ${parsed.resultCode ?? 0},
            "result_description" = 'Disputed reference held by previously settled tenant claim; manual compliance adjudication required',
            "error_message" = 'CROSS_TENANT_SETTLEMENT_DISPUTE',
            "settled_payment_id" = ${disputedPaymentId},
            "raw_callback_payload" = ${rawCallbackJson}::jsonb,
            "updated_at" = NOW()
          WHERE "id" = ${stkTx.id} AND "organization_id" = ${orgId}
        `;

        await dbStore.insertOutboxEvent(
          {
            organizationId: orgId,
            eventType: BusinessEventType.PAYMENT_NEEDS_REVIEW,
            payload: {
              reason: 'CROSS_TENANT_SETTLEMENT_DISPUTE',
              claimId: claimResult.claimId,
              checkoutId: stkTx.id,
              provider: normProvider,
              providerReference: normRef,
              paymentId: disputedPaymentId,
              invoiceId: stkTx.invoiceId,
            },
          },
          tx,
        );

        const updatedDisputedTx = await dbStore.getStkTransactionById(stkTx.id, orgId, tx);
        return this.mapToStatusDto(updatedDisputedTx || stkTx);
      }

      // CONFIRMED or SUPERSEDED_EVICTED:
      // 1. Immutable Raw Evidence with exact original request bytes
      await this.insertProviderRawEvidence(
        tx,
        evidenceId,
        orgId,
        normProvider,
        rawPayloadBytesStr,
        providerTimestamp,
        verificationReq,
        'OBSERVED',
      );

      // 2. Create NormalizedPayment if not reusing an existing same-org provisional payment
      const reusingVerifiedPayment =
        canReuseSameOrgPayment && existingSameOrgPayment!.state === TransactionState.VERIFIED;

      if (!canReuseSameOrgPayment) {
        const initialPayState = targetInvoiceId ? TransactionState.MATCHED : TransactionState.VERIFIED;
        await tx`
          INSERT INTO "normalized_payments" (
            "id", "organization_id", "device_id", "raw_evidence_id", "provider",
            "reference", "amount_cents", "currency", "sender_phone", "sender_name",
            "recipient_account", "customer_memo", "provider_timestamp", "parser_version",
            "state", "deduplication_hash", "matched_invoice_id", "candidate_invoice_id"
          )
          VALUES (
            ${chosenPaymentId},
            ${orgId},
            NULL,
            ${evidenceId},
            ${normProvider}::"PaymentProvider",
            ${normRef},
            ${stkTx.amountCents.toString()}::bigint,
            ${stkTx.currency},
            ${parsed.phoneNumber || stkTx.phoneNumber},
            ${parsed.customerName ?? null},
            NULL,
            ${stkTx.memo ?? null},
            ${providerTimestamp},
            '1.0.0',
            ${initialPayState}::"TransactionState",
            ${deduplicationHash},
            ${targetInvoiceId ?? null},
            ${targetInvoiceId ?? null}
          )
        `;
      }

      // 3. Invoice Settlement via Reconciliation Service (skipped if existing same-org payment already verified that invoice)
      let settledPaymentId: string = chosenPaymentId;
      if (targetInvoiceId && !reusingVerifiedPayment) {
        const settlement = await this.reconciliationService.verifyPayment(
          orgId,
          {
            paymentId: chosenPaymentId,
            invoiceId: targetInvoiceId,
            verificationMethod: VerificationMethod.INDEPENDENT_PROVIDER_QUERY,
            externalVerificationRef: normRef,
            notes: `Authoritative settlement via verified carrier STK push callback (${normProvider}). CheckoutId: ${stkTx.id}`,
            isProviderAuthenticated: true,
          },
          tx,
        );
        settledPaymentId = settlement.payment.id;
      } else if (!targetInvoiceId && canReuseSameOrgPayment && !reusingVerifiedPayment) {
        await tx`
          UPDATE "normalized_payments"
          SET
            "state" = ${TransactionState.VERIFIED}::"TransactionState",
            "verified_at" = NOW(),
            "updated_at" = NOW()
          WHERE "id" = ${chosenPaymentId} AND "organization_id" = ${orgId}
        `;
      }

      // 4. Update STK Push Transaction to SUCCESS
      await tx`
        UPDATE "stk_push_transactions"
        SET
          "status" = ${StkPushStatus.SUCCESS}::"StkPushStatus",
          "provider_reference" = ${normRef},
          "result_code" = ${parsed.resultCode ?? 0},
          "result_description" = ${parsed.resultDescription ?? 'Success'},
          "settled_payment_id" = ${settledPaymentId},
          "raw_callback_payload" = ${rawCallbackJson}::jsonb,
          "updated_at" = NOW()
        WHERE "id" = ${stkTx.id} AND "organization_id" = ${orgId}
      `;

      // 5. Outbox Event
      await dbStore.insertOutboxEvent(
        {
          organizationId: orgId,
          eventType: BusinessEventType.PAYMENT_STK_SUCCESS,
          payload: {
            checkoutId: stkTx.id,
            provider: normProvider,
            providerReference: normRef,
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

  private async insertProviderRawEvidence(
    tx: SqlExecutor,
    evidenceId: string,
    orgId: string,
    provider: PaymentProvider,
    rawPayloadBytesStr: string,
    providerTimestamp: Date,
    verificationReq: CallbackVerificationRequest,
    parseStatus: string,
  ): Promise<void> {
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
        ${parseStatus}
      )
    `;
  }

  private mapToResponseDto(record: StkPushTransactionRecord, customerPrompt: string): StkPushResponseDto {
    const routingResolution =
      record.metadata?.routingResolution === 'EXPLICIT' || record.metadata?.routingResolution === 'PREFIX_HEURISTIC'
        ? record.metadata.routingResolution
        : undefined;
    return {
      checkoutId: record.id,
      organizationId: record.organizationId,
      provider: record.provider,
      ...(routingResolution ? { routingResolution } : {}),
      phoneNumber: record.phoneNumber,
      amountCents: record.amountCents.toString(),
      currency: record.currency,
      status: record.status,
      providerCheckoutId: record.providerCheckoutId ?? null,
      dispatchOutcome: (record.dispatchOutcome as StkDispatchOutcome | null) ?? undefined,
      invoiceId: record.invoiceId ?? undefined,
      referenceNumber: record.referenceNumber ?? undefined,
      customerPrompt,
      initiatedAt: record.createdAt.toISOString(),
    };
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
      providerCheckoutId: record.providerCheckoutId ?? null,
      dispatchOutcome: record.dispatchOutcome ?? null,
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
