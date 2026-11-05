import { PaymentProvider, CurrencyCode } from '@brisksms/shared';
import { BaseProviderAdapter } from './base.adapter.js';
import { ParsedPaymentResult } from '../interfaces.js';

export class CrdbAdapter extends BaseProviderAdapter {
  readonly provider = PaymentProvider.CRDB_BANK;

  canParse(senderAddress: string, body: string): boolean {
    const address = senderAddress.toUpperCase();
    return address.includes('CRDB') || /CRDB\s*Alert/i.test(body);
  }

  parse(body: string, defaultDate: Date = new Date()): ParsedPaymentResult | null {
    const text = this.cleanText(body);

    // Only process incoming credits (Credit of TZS...)
    if (!/Credit\s+of/i.test(text)) {
      return null;
    }

    // Extract Reference (Ref: FT2630987654 or Txn: ...)
    const refMatch = text.match(/(?:Ref(?:erence)?|Txn(?:\s*ID)?)\s*(?::|ni)?\s*([A-Za-z0-9]+)/i);
    if (!refMatch || !refMatch[1]) {
      return null;
    }
    const reference = refMatch[1].toUpperCase();

    // Extract Amount (Credit of TZS 100,000.00)
    const amountMatch = text.match(/Credit\s+of\s+(?:TZS|Tsh)\s*([\d,]+(?:\.\d{2})?)/i);
    if (!amountMatch || !amountMatch[1]) {
      return null;
    }
    const amountCents = this.parseAmount(amountMatch[1]);

    // Extract Account (to A/C 01J20...)
    let recipientAccount: string | null = null;
    const acctMatch = text.match(/(?:to\s+A\/C|acc(?:ount)?)\s*([A-Za-z0-9*]+)/i);
    if (acctMatch && acctMatch[1]) {
      recipientAccount = acctMatch[1].trim();
    }

    // Extract Payer Name (from JOHN DOE Ref:)
    let senderName: string | null = null;
    const senderMatch = text.match(/from\s+([A-Z\s]+?)\s+(?:Ref|on|\.|$)/i);
    if (senderMatch && senderMatch[1]) {
      senderName = senderMatch[1].trim();
    }

    return {
      provider: this.provider,
      reference,
      amountCents,
      currency: CurrencyCode.TZS,
      senderPhone: '',
      senderName,
      recipientAccount,
      customerMemo: null,
      providerTimestamp: defaultDate,
      rawText: body,
    };
  }
}

