import {
  PaymentProvider,
  StkPushCallbackPayload,
  toMinorUnits,
} from '@brisksms/shared';
import {
  buildFailClosedDispatchResult,
  StkInitiateParams,
  StkInitiateResult,
  StkPushAdapter,
} from './stk-adapter.interface.js';

export class MpesaStkAdapter implements StkPushAdapter {
  public readonly provider = PaymentProvider.MPESA;
  public readonly isConfigured = false;

  async initiatePush(_params: StkInitiateParams): Promise<StkInitiateResult> {
    // No official Vodacom M-Pesa Tanzania STK OpenAPI transport is configured.
    // Fail closed rather than fabricating live initiation success or synthetic references.
    return buildFailClosedDispatchResult(this.provider, 'UNCONFIGURED');
  }

  parseCallback(payload: any): StkPushCallbackPayload {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid M-Pesa callback payload: Expected JSON object');
    }

    // 1. Check for standard Vodacom / Daraja STK Push format: { Body: { stkCallback: { ... } } }
    if (payload.Body?.stkCallback) {
      const cb = payload.Body.stkCallback;
      const resultCode = Number(cb.ResultCode ?? 0);
      const isSuccess = resultCode === 0;
      const checkoutId = String(cb.CheckoutRequestID || cb.MerchantRequestID || '');
      const resultDescription = cb.ResultDesc ? String(cb.ResultDesc) : undefined;

      let providerReference: string | undefined;
      let amountCents: bigint | undefined;
      let currency: string | undefined = payload.currency || cb.Currency;
      let phoneNumber: string | undefined;
      let providerTimestamp: Date | undefined;

      if (cb.CallbackMetadata?.Item && Array.isArray(cb.CallbackMetadata.Item)) {
        for (const item of cb.CallbackMetadata.Item) {
          if (item.Name === 'MpesaReceiptNumber' && item.Value) {
            providerReference = String(item.Value).trim().toUpperCase();
          } else if (item.Name === 'Amount' && item.Value !== undefined) {
            amountCents = toMinorUnits(item.Value);
          } else if (item.Name === 'Currency' && item.Value) {
            currency = String(item.Value).trim().toUpperCase();
          } else if (item.Name === 'PhoneNumber' && item.Value) {
            phoneNumber = String(item.Value);
          } else if (item.Name === 'TransactionDate' && item.Value) {
            const s = String(item.Value);
            if (s.length === 14) {
              const yr = parseInt(s.substring(0, 4), 10);
              const mo = parseInt(s.substring(4, 6), 10) - 1;
              const dy = parseInt(s.substring(6, 8), 10);
              const hr = parseInt(s.substring(8, 10), 10);
              const mi = parseInt(s.substring(10, 12), 10);
              const sc = parseInt(s.substring(12, 14), 10);
              providerTimestamp = new Date(Date.UTC(yr, mo, dy, hr, mi, sc));
            }
          }
        }
      }

      return {
        provider: this.provider,
        checkoutId,
        success: isSuccess,
        providerReference,
        amountCents,
        currency: currency ? String(currency).trim().toUpperCase() : undefined,
        phoneNumber,
        providerTimestamp,
        resultCode,
        resultDescription,
        rawPayload: payload,
      };
    }

    // 2. Direct normalized format: { checkoutId, success, providerReference, amount, phoneNumber }
    const checkoutId = String(payload.checkoutId || payload.checkoutRequestId || payload.id || '');
    const isSuccess = payload.success !== undefined
      ? Boolean(payload.success)
      : (payload.status === 'SUCCESS' || payload.resultCode === 0);
    const providerReference = payload.providerReference || payload.receiptNumber || payload.reference;
    const amountVal = payload.amountCents !== undefined ? BigInt(payload.amountCents) : payload.amount !== undefined ? toMinorUnits(payload.amount) : undefined;

    return {
      provider: this.provider,
      checkoutId,
      success: isSuccess,
      providerReference: providerReference ? String(providerReference).trim().toUpperCase() : undefined,
      amountCents: amountVal,
      currency: payload.currency ? String(payload.currency).trim().toUpperCase() : undefined,
      phoneNumber: payload.phoneNumber ? String(payload.phoneNumber) : undefined,
      resultCode: payload.resultCode !== undefined ? Number(payload.resultCode) : (isSuccess ? 0 : 1),
      resultDescription: payload.resultDescription || payload.message,
      rawPayload: payload,
    };
  }
}
