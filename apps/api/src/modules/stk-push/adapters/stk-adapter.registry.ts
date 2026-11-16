import { PaymentProvider } from '@brisksms/shared';
import { AirtelStkAdapter } from './airtel-stk.adapter.js';
import { HalopesaStkAdapter } from './halopesa-stk.adapter.js';
import { MpesaStkAdapter } from './mpesa-stk.adapter.js';
import { StkPushAdapter } from './stk-adapter.interface.js';
import { TigoStkAdapter } from './tigo-stk.adapter.js';
import { UnsupportedStkAdapter } from './unsupported-stk.adapter.js';

/**
 * Central STK Dispatch Adapter Registry
 *
 * Invariant: All providers fail closed (UNCONFIGURED or UNSUPPORTED) by default
 * until an official carrier API transport is onboarded and explicitly configured.
 */
export class StkAdapterRegistry {
  private readonly adapters = new Map<PaymentProvider, StkPushAdapter>();

  constructor() {
    this.resetToDefaults();
  }

  public resetToDefaults(): void {
    this.adapters.clear();
    this.adapters.set(PaymentProvider.MPESA, new MpesaStkAdapter());
    this.adapters.set(PaymentProvider.MIXX, new TigoStkAdapter());
    this.adapters.set(PaymentProvider.AIRTEL_MONEY, new AirtelStkAdapter());
    this.adapters.set(PaymentProvider.HALOPESA, new HalopesaStkAdapter());
    this.adapters.set(PaymentProvider.TTCL_PESA, new UnsupportedStkAdapter(PaymentProvider.TTCL_PESA));
    this.adapters.set(PaymentProvider.CRDB_BANK, new UnsupportedStkAdapter(PaymentProvider.CRDB_BANK));
    this.adapters.set(PaymentProvider.NMB_BANK, new UnsupportedStkAdapter(PaymentProvider.NMB_BANK));
    this.adapters.set(
      PaymentProvider.MANUAL_BANK_TRANSFER,
      new UnsupportedStkAdapter(PaymentProvider.MANUAL_BANK_TRANSFER),
    );
  }

  public registerAdapter(adapter: StkPushAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  public getAdapter(provider: PaymentProvider): StkPushAdapter {
    return this.adapters.get(provider) ?? new UnsupportedStkAdapter(provider);
  }
}

export const stkAdapterRegistry = new StkAdapterRegistry();
