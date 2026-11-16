import { PaymentProvider, StkDispatchOutcome, StkPushCallbackPayload } from '@brisksms/shared';

export interface StkInitiateParams {
  checkoutId: string;
  organizationId: string;
  phoneNumber: string;
  amountCents: bigint;
  currency: string;
  referenceNumber?: string;
  memo?: string;
  idempotencyKey?: string;
}

export interface StkInitiateResult {
  outcome: StkDispatchOutcome;
  /** Strictly true ONLY when outcome === 'ACCEPTED' by a live provider or explicit test harness. */
  success: boolean;
  /** Transport-level session/checkout handle returned by the carrier (never a settlement receipt). */
  providerCheckoutId?: string;
  /** Prompt description ONLY populated when the carrier accepted the push request. */
  customerPrompt?: string;
  code?: string;
  errorMessage?: string;
  /** Never auto-retry UNCONFIGURED, UNSUPPORTED, or UNCERTAIN outcomes. */
  retryable?: boolean;
}

export interface StkPushAdapter {
  readonly provider: PaymentProvider;
  readonly isConfigured: boolean;
  initiatePush(params: StkInitiateParams): Promise<StkInitiateResult>;
  parseCallback(payload: unknown, headers?: Record<string, string>): StkPushCallbackPayload;
}

export function buildFailClosedDispatchResult(
  provider: PaymentProvider,
  outcome: 'UNCONFIGURED' | 'UNSUPPORTED',
): StkInitiateResult {
  if (outcome === 'UNCONFIGURED') {
    return {
      outcome: 'UNCONFIGURED',
      success: false,
      code: 'PROVIDER_DISPATCH_DISABLED',
      retryable: false,
      errorMessage: `Live STK push dispatch for '${provider}' is disabled until official carrier API credentials and transport contracts are configured.`,
    };
  }

  return {
    outcome: 'UNSUPPORTED',
    success: false,
    code: 'UNSUPPORTED_STK_PROVIDER',
    retryable: false,
    errorMessage: `Carrier STK push dispatch is not supported for provider '${provider}'.`,
  };
}
