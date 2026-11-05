import { PaymentProvider, CurrencyCode } from '@brisksms/shared';
import { BaseProviderAdapter } from './base.adapter.js';
import { ParsedPaymentResult } from '../interfaces.js';

export class HalopesaAdapter extends BaseProviderAdapter {
  readonly provider = PaymentProvider.HALOPESA;

  canParse(senderAddress: string, body: string): boolean {
    const address = senderAddress.toUpperCase();
    return address.includes('HALOPESA') || address.includes('HALOTEL') || /HaloPesa/i.test(body);
  }

  parse(body: string, defaultDate: Date = new Date()): ParsedPaymentResult | null {
    const text = this.cleanText(body);

    const refMatch = text.match(/(?:Kumbukumbu|Trans(?:action)?\s*ID|Ref)\s*(?::|ni)?\s*([A-Za-z0-9]+)/i);
    if (!refMatch || !refMatch[1]) {
      return null;
    }
    const reference = refMatch[1].toUpperCase();

    const amountMatch = text.match(/(?:Tsh|TZS)\s*([\d,]+(?:\.\d{2})?)/i);
    if (!amountMatch || !amountMatch[1]) {
      return null;
    }
    const amountCents = this.parseAmount(amountMatch[1]);

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
