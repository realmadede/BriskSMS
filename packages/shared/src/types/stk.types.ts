import { PaymentProvider } from '../enums/payment-provider.enum.js';

/**
 * Status lifecycle of a Carrier STK / USSD Push
 */
export enum StkPushStatus {
  INITIATING = 'INITIATING',
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
  DISPATCH_UNCERTAIN = 'DISPATCH_UNCERTAIN',
  UNSUPPORTED = 'UNSUPPORTED',
}

/**
 * Typed carrier dispatch outcome at the external transport boundary
 */
export type StkDispatchOutcome =
  | 'ACCEPTED'
  | 'UNCONFIGURED'
  | 'UNSUPPORTED'
  | 'DEFINITIVE_FAILURE'
  | 'UNCERTAIN';

/**
 * Request payload for initiating an STK Push
 */
export interface StkPushRequestDto {
  phoneNumber: string;
  /** Optional explicit wallet provider override (required for MNP-ported numbers). */
  provider?: PaymentProvider;
  amount: number;
  currency?: string;
  invoiceId?: string;
  referenceNumber?: string;
  customerName?: string;
  memo?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Immediate synchronous response after STK Push dispatch
 */
export interface StkPushResponseDto {
  checkoutId: string;
  organizationId: string;
  provider: PaymentProvider;
  routingResolution?: 'EXPLICIT' | 'PREFIX_HEURISTIC';
  phoneNumber: string;
  amountCents: string;
  currency: string;
  status: StkPushStatus;
  providerCheckoutId?: string | null;
  dispatchOutcome?: StkDispatchOutcome;
  invoiceId?: string;
  referenceNumber?: string;
  customerPrompt: string;
  initiatedAt: string;
}

/**
 * Detailed status representation for polling or status queries
 */
export interface StkPushStatusDto {
  checkoutId: string;
  organizationId: string;
  provider: PaymentProvider;
  phoneNumber: string;
  amountCents: string;
  currency: string;
  status: StkPushStatus;
  providerCheckoutId?: string | null;
  dispatchOutcome?: string | null;
  providerReference?: string | null;
  invoiceId?: string | null;
  referenceNumber?: string | null;
  resultCode?: number | null;
  resultDescription?: string | null;
  errorMessage?: string | null;
  settledPaymentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Normalized payload emitted when carrier returns an asynchronous callback
 */
export interface StkPushCallbackPayload {
  provider: PaymentProvider;
  checkoutId: string;
  success: boolean;
  providerReference?: string;
  amountCents?: bigint | number;
  currency?: string;
  phoneNumber?: string;
  referenceNumber?: string;
  customerName?: string;
  providerTimestamp?: Date;
  resultCode?: number;
  resultDescription?: string;
  rawPayload?: Record<string, unknown>;
}
