import { PaymentProvider, CurrencyCode } from '@brisksms/shared';
import { BaseProviderAdapter } from './base.adapter.js';
import { ParsedPaymentResult } from '../interfaces.js';

export class AirtelAdapter extends BaseProviderAdapter {
  readonly provider = PaymentProvider.AIRTEL_MONEY;

  canParse(senderAddress: string, body: string): boolean {
    const address = senderAddress.toUpperCase();
    if (address.includes('AIRTEL')) {
      return true;
    }
    return /Airtel\s*Money/i.test(body);
  }

  parse(body: string, defaultDate: Date = new Date()): ParsedPaymentResult | null {
    const text = this.cleanText(body);

    // Extract Transaction ID / Namba ya muamala
    const refMatch = text.match(/(?:Namba ya muamala|Trans(?:action)?\s*(?:ID|No\.?))\s*(?::|ni)?\s*([A-Za-z0-9.]+)/i);
    if (!refMatch || !refMatch[1]) {
      return null;
    }
    const reference = refMatch[1].replace(/\.$/, '').toUpperCase();

    // Extract Amount
    const amountMatch = text.match(/(?:Tsh|TZS)\s*([\d,]+(?:\.\d{2})?)/i);
    if (!amountMatch || !amountMatch[1]) {
      return null;
    }
    const amountCents = this.parseAmount(amountMatch[1]);

    // Extract Sender Phone & Name
    let senderPhone = '';
    let senderName: string | null = null;

    const senderMatch = text.match(/(?:kutoka kwa|from)\s+([A-Z\s]+?)\s*\((255\d{9}|0\d{9})\)/i);
    if (senderMatch && senderMatch[2]) {
      senderPhone = this.normalizePhoneNumber(senderMatch[2]);
      senderName = senderMatch[1] ? senderMatch[1].trim() : null;
    } else {
      const phoneOnly = text.match(/(255\d{9}|0\d{9})/);
      if (phoneOnly && phoneOnly[1]) {
        senderPhone = this.normalizePhoneNumber(phoneOnly[1]);
      }
    }

    return {
      provider: this.provider,
      reference,
      amountCents,
      currency: CurrencyCode.TZS,
      senderPhone,
      senderName,
      recipientAccount: null,
      customerMemo: null,
      providerTimestamp: defaultDate,
      rawText: body,
    };
  }
}
