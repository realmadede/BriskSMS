import {
  PaymentProvider,
  StkPushCallbackPayload,
  formatTzs,
  toMinorUnits,
} from '@brisksms/shared';
import { StkInitiateParams, StkInitiateResult, StkPushAdapter } from './stk-adapter.interface.js';

export class MpesaStkAdapter implements StkPushAdapter {
  public readonly provider = PaymentProvider.MPESA;

  async initiatePush(params: StkInitiateParams): Promise<StkInitiateResult> {
    const formattedAmount = formatTzs(params.amountCents);
    const customerPrompt = `Tafadhali weka PIN yako ya M-Pesa kwenye simu yako kuthibitisha malipo ya ${formattedAmount}.`;

    // Simulated / Sandbox or Live Gateway Dispatch
    return {
      success: true,
      providerCheckoutId: `voda_${params.checkoutId}`,
      customerPrompt,
    };
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
      let phoneNumber: string | undefined;

      if (cb.CallbackMetadata?.Item && Array.isArray(cb.CallbackMetadata.Item)) {
        for (const item of cb.CallbackMetadata.Item) {
          if (item.Name === 'MpesaReceiptNumber' && item.Value) {
            providerReference = String(item.Value).trim().toUpperCase();
          } else if (item.Name === 'Amount' && item.Value !== undefined) {
            amountCents = toMinorUnits(item.Value);
          } else if (item.Name === 'PhoneNumber' && item.Value) {
            phoneNumber = String(item.Value);
          }
        }
      }

      return {
        provider: this.provider,
        checkoutId,
        success: isSuccess,
        providerReference,
        amountCents,
        phoneNumber,
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
      phoneNumber: payload.phoneNumber ? String(payload.phoneNumber) : undefined,
      resultCode: payload.resultCode !== undefined ? Number(payload.resultCode) : (isSuccess ? 0 : 1),
      resultDescription: payload.resultDescription || payload.message,
      rawPayload: payload,
    };
  }
}
