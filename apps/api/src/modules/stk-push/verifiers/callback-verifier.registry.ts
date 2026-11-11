import { PaymentProvider } from '@brisksms/shared';
import {
  CallbackVerificationRequest,
  CallbackVerificationResult,
  ProviderCallbackVerifier,
} from './callback-verifier.interface.js';
import { DisabledProviderCallbackVerifier } from './disabled-provider.verifier.js';

/**
 * Central Callback Verifier Registry
 *
 * Invariant: Every provider is disabled by default until an authoritative,
 * validated verifier implementation is explicitly registered.
 */
export class CallbackVerifierRegistry {
  private readonly verifiers = new Map<PaymentProvider, ProviderCallbackVerifier>();

  constructor() {
    this.resetToDefaults();
  }

  /**
   * Resets all provider verifiers to safe disabled-by-default implementations.
   */
  public resetToDefaults(): void {
    this.verifiers.clear();
    const providers: PaymentProvider[] = [
      PaymentProvider.MPESA,
      PaymentProvider.MIXX,
      PaymentProvider.AIRTEL_MONEY,
      PaymentProvider.HALOPESA,
      PaymentProvider.TTCL_PESA,
      PaymentProvider.CRDB_BANK,
      PaymentProvider.NMB_BANK,
      PaymentProvider.MANUAL_BANK_TRANSFER,
    ];

    for (const provider of providers) {
      this.verifiers.set(provider, new DisabledProviderCallbackVerifier(provider));
    }
  }

  /**
   * Registers a provider-specific callback verifier.
   */
  public registerVerifier(verifier: ProviderCallbackVerifier): void {
    this.verifiers.set(verifier.provider, verifier);
  }

  /**
   * Retrieves the verifier for a given provider, defaulting to disabled if absent.
   */
  public getVerifier(provider: PaymentProvider): ProviderCallbackVerifier {
    const verifier = this.verifiers.get(provider);
    if (!verifier) {
      return new DisabledProviderCallbackVerifier(provider);
    }
    return verifier;
  }

  /**
   * Executes provider-specific verification against the incoming callback request.
   */
  public async verifyCallback(
    req: CallbackVerificationRequest,
  ): Promise<CallbackVerificationResult> {
    const verifier = this.getVerifier(req.provider);
    return verifier.verify(req);
  }
}

export const callbackVerifierRegistry = new CallbackVerifierRegistry();
