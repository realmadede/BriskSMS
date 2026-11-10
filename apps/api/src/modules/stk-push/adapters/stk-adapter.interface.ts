import { PaymentProvider, StkPushCallbackPayload } from '@brisksms/shared';

export interface StkInitiateParams {
  checkoutId: string;
  organizationId: string;
  phoneNumber: string;
  amountCents: bigint;
  currency: string;
  referenceNumber?: string;
  memo?: string;
}

export interface StkInitiateResult {
  success: boolean;
  providerCheckoutId?: string;
  customerPrompt: string;
  errorMessage?: string;
}

export interface StkPushAdapter {
  readonly provider: PaymentProvider;
  initiatePush(params: StkInitiateParams): Promise<StkInitiateResult>;
  parseCallback(payload: unknown, headers?: Record<string, string>): StkPushCallbackPayload;
}
