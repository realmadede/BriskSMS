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

export class AirtelStkAdapter implements StkPushAdapter {
  public readonly provider = PaymentProvider.AIRTEL_MONEY;
  public readonly isConfigured = false;

  async initiatePush(_params: StkInitiateParams): Promise<StkInitiateResult> {
    // No official Airtel Money Tanzania USSD/STK transport is configured.
    return buildFailClosedDispatchResult(this.provider, 'UNCONFIGURED');
  }

  parseCallback(payload: any): StkPushCallbackPayload {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid Airtel Money callback payload: Expected JSON object');
    }

    const checkoutId = String(payload.checkoutId || payload.transactionId || payload.reference || '');
    const isSuccess = payload.success !== undefined
      ? Boolean(payload.success)
      : (payload.status === 'SUCCESS' || payload.code === '200');
    const providerReference = payload.providerReference || payload.airtelMoneyId || payload.reference || payload.id;
    const amountVal = payload.amountCents !== undefined
      ? BigInt(payload.amountCents)
      : payload.amount !== undefined
        ? toMinorUnits(payload.amount)
        : undefined;

    return {
      provider: this.provider,
      checkoutId,
      success: isSuccess,
      providerReference: providerReference ? String(providerReference).trim().toUpperCase() : undefined,
      amountCents: amountVal,
      currency: payload.currency ? String(payload.currency).trim().toUpperCase() : undefined,
      phoneNumber: payload.phoneNumber || payload.msisdn ? String(payload.phoneNumber || payload.msisdn) : undefined,
      resultCode: payload.resultCode !== undefined ? Number(payload.resultCode) : (isSuccess ? 0 : 1),
      resultDescription: payload.resultDescription || payload.message,
      rawPayload: payload,
    };
  }
}
