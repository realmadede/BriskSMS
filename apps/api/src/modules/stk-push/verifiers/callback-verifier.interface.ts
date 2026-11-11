import { PaymentProvider } from '@brisksms/shared';

/**
 * Encapsulates the complete incoming HTTP callback representation
 * required for provider-specific authentication and integrity verification.
 */
export interface CallbackVerificationRequest {
  provider: PaymentProvider;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string | Buffer;
  body: any;
  query?: Record<string, string | string[] | undefined>;
  urlPath?: string;
  ipAddress?: string;
}

/**
 * Outcome of provider-specific callback authentication verification.
 */
export interface CallbackVerificationResult {
  isValid: boolean;
  code?: string;
  reason?: string;
  providerReference?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Explicit provider-specific callback authentication verifier.
 *
 * Invariant: Every provider callback must pass verification through its registered
 * verifier before any settlement or state transition is permitted.
 */
export interface ProviderCallbackVerifier {
  readonly provider: PaymentProvider;
  verify(req: CallbackVerificationRequest): Promise<CallbackVerificationResult> | CallbackVerificationResult;
}
