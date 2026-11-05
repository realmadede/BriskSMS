import { PaymentProvider, CurrencyCode } from '@brisksms/shared';
import { BaseProviderAdapter } from './base.adapter.js';
import { ParsedPaymentResult } from '../interfaces.js';

export class MixxAdapter extends BaseProviderAdapter {
  readonly provider = PaymentProvider.MIXX;

  canParse(senderAddress: string, body: string): boolean {
    const address = senderAddress.toUpperCase();
    if (address.includes('MIXX') || address.includes('TIGOPESA') || address.includes('TIGO') || address.includes('YAS')) {
      return true;
    }
    return /(?:Mixx|Tigo\s*Pesa).*Umepokea/i.test(body);
  }

  parse(body: string, defaultDate: Date = new Date()): ParsedPaymentResult | null {
    const text = this.cleanText(body);

    // Extract Reference / Kumbukumbu namba
    // E.g.: Kumbukumbu namba: 12345678901 or Kumbukumbu: 12345678901 or Ref: ...
    const refMatch = text.match(/(?:Kumbukumbu(?:\s+namba)?|Reference(?:\s+no)?|Ref)\s*(?::|ni)?\s*([A-Za-z0-9]+)/i);
    if (!refMatch || !refMatch[1]) {
      return null;
    }
    const reference = refMatch[1].toUpperCase();

    // Extract Amount (e.g. Tsh 30,000 or TZS 30,000)
    const amountMatch = text.match(/(?:Tsh|TZS)\s*([\d,]+(?:\.\d{2})?)/i);
    if (!amountMatch || !amountMatch[1]) {
      return null;
    }
    const amountCents = this.parseAmount(amountMatch[1]);

    // Extract Sender Phone & Name
    // Pattern: kutoka kwa JOHN DOE (255713123456)
    // Pattern: kutoka 255713123456 - JOHN DOE
    let senderPhone = '';
    let senderName: string | null = null;

    const senderMatchA = text.match(/(?:kutoka kwa|from)\s+([A-Z\s]+?)\s*\((255\d{9}|0\d{9})\)/i);
    const senderMatchB = text.match(/(?:kutoka kwa|kutoka|from)\s+(255\d{9}|0\d{9})\s*(?:-|–)\s*([A-Z\s]+?)(?:\.|$)/i);

    if (senderMatchA && senderMatchA[2]) {
      senderPhone = this.normalizePhoneNumber(senderMatchA[2]);
      senderName = senderMatchA[1] ? senderMatchA[1].trim() : null;
    } else if (senderMatchB && senderMatchB[1]) {
      senderPhone = this.normalizePhoneNumber(senderMatchB[1]);
      senderName = senderMatchB[2] ? senderMatchB[2].trim() : null;
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
