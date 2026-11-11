import { PaymentProvider } from '../enums/payment-provider.enum.js';

/**
 * Status lifecycle of a Carrier STK / USSD Push
 */
export enum StkPushStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

/**
 * Request payload for initiating an STK Push
 */
export interface StkPushRequestDto {
  phoneNumber: string;
  amount: number;
  currency?: string;
  invoiceId?: string;
  referenceNumber?: string;
  customerName?: string;
  memo?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Immediate synchronous response after STK Push dispatch
 */
export interface StkPushResponseDto {
  checkoutId: string;
  organizationId: string;
  provider: PaymentProvider;
  phoneNumber: string;
  amountCents: string;
  currency: string;
  status: StkPushStatus;
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
