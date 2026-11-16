import { PaymentProvider, StkPushCallbackPayload, formatTzs } from '@brisksms/shared';
import { AirtelStkAdapter } from './airtel-stk.adapter.js';
import { HalopesaStkAdapter } from './halopesa-stk.adapter.js';
import { MpesaStkAdapter } from './mpesa-stk.adapter.js';
import { StkInitiateParams, StkInitiateResult, StkPushAdapter } from './stk-adapter.interface.js';
import { TigoStkAdapter } from './tigo-stk.adapter.js';
import { UnsupportedStkAdapter } from './unsupported-stk.adapter.js';

export type TestStkInitiateHandler = (
  params: StkInitiateParams,
) => Promise<StkInitiateResult> | StkInitiateResult;

export interface TestStkAdapterOptions {
  delegate?: StkPushAdapter;
  initiateHandler?: TestStkInitiateHandler;
}

function defaultDelegateFor(provider: PaymentProvider): StkPushAdapter {
  switch (provider) {
    case PaymentProvider.MPESA:
      return new MpesaStkAdapter();
    case PaymentProvider.MIXX:
      return new TigoStkAdapter();
    case PaymentProvider.AIRTEL_MONEY:
      return new AirtelStkAdapter();
    case PaymentProvider.HALOPESA:
      return new HalopesaStkAdapter();
    default:
      return new UnsupportedStkAdapter(provider);
  }
}

/**
 * TEST-ONLY STK Dispatch Adapter
 *
 * Strictly for automated testing of downstream checkout & callback reconciliation flows,
 * plus failure/timeout/uncertain dispatch simulations. Never permitted in production.
 */
export class TestStkAdapter implements StkPushAdapter {
  public readonly isConfigured = true;
  private readonly delegate: StkPushAdapter;
  private readonly initiateHandler: TestStkInitiateHandler;

  constructor(
    public readonly provider: PaymentProvider,
    options: TestStkAdapterOptions = {},
  ) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SECURITY VIOLATION: TestStkAdapter cannot be instantiated in production environment');
    }

    this.delegate = options.delegate ?? defaultDelegateFor(provider);
    this.initiateHandler =
      options.initiateHandler ??
      ((params: StkInitiateParams): StkInitiateResult => ({
        outcome: 'ACCEPTED',
        success: true,
        customerPrompt: `[TEST SANDBOX] Confirm ${formatTzs(params.amountCents)} prompt on ${this.provider}.`,
      }));
  }

  async initiatePush(params: StkInitiateParams): Promise<StkInitiateResult> {
    return this.initiateHandler(params);
  }

  parseCallback(payload: unknown, headers?: Record<string, string>): StkPushCallbackPayload {
    return this.delegate.parseCallback(payload, headers);
  }
}
