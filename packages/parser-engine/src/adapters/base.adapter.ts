import { PaymentProvider, toMinorUnits } from '@brisksms/shared';
import { IProviderAdapter, ParsedPaymentResult } from '../interfaces.js';

export abstract class BaseProviderAdapter implements IProviderAdapter {
  abstract readonly provider: PaymentProvider;

  abstract canParse(senderAddress: string, body: string): boolean;
  abstract parse(body: string, defaultDate?: Date): ParsedPaymentResult | null;

  /**
   * Cleans and normalizes text whitespace
   */
  protected cleanText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Converts monetary string to minor integer units (cents)
   */
  protected parseAmount(amountStr: string): bigint {
    const sanitized = amountStr.replace(/,/g, '').trim();
    return toMinorUnits(sanitized);
  }

  /**
   * Normalizes Tanzanian phone number format (+255...)
   */
  protected normalizePhoneNumber(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.startsWith('255') && digits.length === 12) {
      return `+${digits}`;
    }
    if (digits.startsWith('0') && digits.length === 10) {
      return `+255${digits.substring(1)}`;
    }
    if (digits.length === 9) {
      return `+255${digits}`;
    }
    return phone.trim();
  }
}
