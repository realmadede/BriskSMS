import {
  PaymentProvider,
  StkPushCallbackPayload,
  formatTzs,
  toMinorUnits,
} from '@brisksms/shared';
import { StkInitiateParams, StkInitiateResult, StkPushAdapter } from './stk-adapter.interface.js';

export class AirtelStkAdapter implements StkPushAdapter {
  public readonly provider = PaymentProvider.AIRTEL_MONEY;

  async initiatePush(params: StkInitiateParams): Promise<StkInitiateResult> {
    const formattedAmount = formatTzs(params.amountCents);
    const customerPrompt = `Tafadhali weka PIN yako ya Airtel Money kwenye simu yako kuthibitisha malipo ya ${formattedAmount}.`;

    return {
      success: true,
      providerCheckoutId: `airtel_${params.checkoutId}`,
      customerPrompt,
    };
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
      phoneNumber: payload.phoneNumber || payload.msisdn ? String(payload.phoneNumber || payload.msisdn) : undefined,
      resultCode: payload.resultCode !== undefined ? Number(payload.resultCode) : (isSuccess ? 0 : 1),
      resultDescription: payload.resultDescription || payload.message,
      rawPayload: payload,
    };
  }
}
