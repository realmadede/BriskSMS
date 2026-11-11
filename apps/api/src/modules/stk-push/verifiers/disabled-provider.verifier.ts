import { PaymentProvider } from '@brisksms/shared';
import {
  CallbackVerificationRequest,
  CallbackVerificationResult,
  ProviderCallbackVerifier,
} from './callback-verifier.interface.js';

/**
 * Disabled-by-Default Provider Callback Verifier
 *
 * CRITICAL FINANCIAL INTEGRITY INVARIANT:
 * When an official carrier callback authentication contract (e.g. mutual TLS, HMAC,
 * or digital certificate verification) is not yet formally established and validated,
 * the provider must reject all callback settlement attempts.
 *
 * Never substitute undocumented provider mechanisms with arbitrary or generic secrets.
 */
export class DisabledProviderCallbackVerifier implements ProviderCallbackVerifier {
  constructor(public readonly provider: PaymentProvider) {}

  verify(_req: CallbackVerificationRequest): CallbackVerificationResult {
    return {
      isValid: false,
      code: 'PROVIDER_CALLBACK_DISABLED',
      reason: `Official callback authentication contract is not configured or validated for provider '${this.provider}'. Callbacks are disabled by default for financial safety.`,
    };
  }
}
