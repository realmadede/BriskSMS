import { PaymentProvider, StkPushCallbackPayload } from '@brisksms/shared';
import {
  buildFailClosedDispatchResult,
  StkInitiateParams,
  StkInitiateResult,
  StkPushAdapter,
} from './stk-adapter.interface.js';

/**
 * Fail-closed adapter for providers that have no STK push workflow
 * (e.g. TTCL_PESA without MNO STK integration, CRDB_BANK, NMB_BANK, MANUAL_BANK_TRANSFER).
 */
export class UnsupportedStkAdapter implements StkPushAdapter {
  public readonly isConfigured = false;

  constructor(public readonly provider: PaymentProvider) {}

  async initiatePush(_params: StkInitiateParams): Promise<StkInitiateResult> {
    return buildFailClosedDispatchResult(this.provider, 'UNSUPPORTED');
  }

  parseCallback(_payload: unknown): StkPushCallbackPayload {
    throw new Error(`Carrier STK push callback parsing is unsupported for provider '${this.provider}'.`);
  }
}
