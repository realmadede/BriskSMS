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
   * Returns true if senderAddress looks like a personal phone number rather than a provider alphanumeric/shortcode.
   */
  protected isPersonalPhoneSender(senderAddress: string): boolean {
    const trimmed = senderAddress.trim();
    if (!trimmed) return true;
    return /^\+?\d[\d\s\-().]{5,}$/.test(trimmed);
  }

  /**
   * Ensures notification describes an incoming credit and not an outgoing transfer, debit, or reversal.
   */
  protected isIncomingCreditMessage(body: string): boolean {
    const outgoingOrReversal =
      /\b(Umetuma|Umefanya malipo|Umelipa|Umetoa|Imetumwa|Imerejeshwa|You have sent|You sent|You paid|Paid to|Withdrawn|Debit of|Dr of)\b/i;
    if (outgoingOrReversal.test(body)) {
      return false;
    }
    return /\b(Umepokea|You have received|have received|Credit of)\b/i.test(body);
  }

  /**
   * Parses SMS transaction date/time when embedded, falling back to defaultDate.
   */
  protected extractTimestamp(text: string, defaultDate: Date): Date {
    // Format 1: tarehe 05/11/2026 [saa 2:30 PM | 14:10 | 15:45]
    const slashMatch = text.match(
      /(?:tarehe|date|on)?\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+(?:saa|at)?\s*(\d{1,2}):(\d{2})(?:\s*(AM|PM))?)?/i,
    );
    if (slashMatch) {
      const day = Number(slashMatch[1]);
      const month = Number(slashMatch[2]);
      const year = Number(slashMatch[3]);
      let hour = slashMatch[4] ? Number(slashMatch[4]) : 0;
      const minute = slashMatch[5] ? Number(slashMatch[5]) : 0;
      const meridiem = slashMatch[6]?.toUpperCase();
      if (meridiem === 'PM' && hour < 12) hour += 12;
      if (meridiem === 'AM' && hour === 12) hour = 0;
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        const utcMs = Date.UTC(year, month - 1, day, hour - 3, minute, 0, 0);
        const parsed = new Date(utcMs);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }
    }

    // Format 2: on 05-Nov-2026
    const monthNames: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const dashMatch = text.match(/\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/);
    if (dashMatch) {
      const day = Number(dashMatch[1]);
      const monIdx = monthNames[dashMatch[2]!.toLowerCase()];
      const year = Number(dashMatch[3]);
      if (monIdx !== undefined && day >= 1 && day <= 31) {
        const parsed = new Date(Date.UTC(year, monIdx, day, 0, 0, 0, 0));
        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }
    }

    return defaultDate;
  }

  /**
   * Converts monetary string to minor integer units (cents)
   */
  protected parseAmount(amountStr: string): bigint {
    const sanitized = amountStr.replace(/,/g, '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(sanitized)) {
      throw new Error(`Invalid monetary amount format: '${amountStr}'`);
    }
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

