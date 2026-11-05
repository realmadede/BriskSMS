import { PaymentProvider, CurrencyCode } from '@brisksms/shared';
import { BaseProviderAdapter } from './base.adapter.js';
import { ParsedPaymentResult } from '../interfaces.js';

export class MpesaAdapter extends BaseProviderAdapter {
  readonly provider = PaymentProvider.MPESA;

  canParse(senderAddress: string, body: string): boolean {
    const address = senderAddress.toUpperCase();
    if (address.includes('MPESA') || address.includes('M-PESA') || address === 'VODACOM') {
      return true;
    }
    // Pattern heuristic: Starts with typical M-Pesa code pattern (e.g. 10 alphanumeric chars)
    return /^[A-Z0-9]{10}\s+(Imethibitishwa|Confirmed)\./i.test(body.trim());
  }

  parse(body: string, defaultDate: Date = new Date()): ParsedPaymentResult | null {
    const text = this.cleanText(body);

    // Swahili Pattern:
    // QA12BC34DE Imethibitishwa. Umepokea Tsh50,000.00 kutoka kwa JOHN DOE 255754123456 tarehe 05/11/2026 saa 2:30 PM...
    // Or Lipa Kwa M-Pesa with account/memo:
    // QA12BC34DE Imethibitishwa. Umepokea Tsh50,000.00 kutoka kwa 255754123456 - JOHN DOE tarehe 05/11/2026 saa 14:30. Akaunti: INV-1024...
    const refMatch = text.match(/^([A-Z0-9]{8,12})\s+(?:Imethibitishwa|Confirmed)\./i);
    if (!refMatch || !refMatch[1]) {
      return null;
    }
    const reference = refMatch[1].toUpperCase();

    // Extract Amount (e.g., Tsh50,000.00 or Tsh 50,000 or TZS 50,000)
    const amountMatch = text.match(/(?:Tsh|TZS)\s*([\d,]+(?:\.\d{2})?)/i);
    if (!amountMatch || !amountMatch[1]) {
      return null;
    }
    const amountCents = this.parseAmount(amountMatch[1]);

    // Extract Sender Phone & Name
    // Case A: kutoka kwa JOHN DOE 255754123456
    // Case B: kutoka kwa 255754123456 - JOHN DOE
    // Case C: from JOHN DOE 255754123456
    let senderPhone = '';
    let senderName: string | null = null;

    const senderMatchA = text.match(/(?:kutoka kwa|from)\s+([A-Z\s]+?)\s+(255\d{9}|0\d{9})/i);
    const senderMatchB = text.match(/(?:kutoka kwa|from)\s+(255\d{9}|0\d{9})\s*(?:-|–)\s*([A-Z\s]+?)(?:\s+tarehe|\s+on|\.|$)/i);

    if (senderMatchB && senderMatchB[1]) {
      senderPhone = this.normalizePhoneNumber(senderMatchB[1]);
      senderName = senderMatchB[2] ? senderMatchB[2].trim() : null;
    } else if (senderMatchA && senderMatchA[2]) {
      senderPhone = this.normalizePhoneNumber(senderMatchA[2]);
      senderName = senderMatchA[1] ? senderMatchA[1].trim() : null;
    } else {
      // Fallback extract phone
      const phoneOnly = text.match(/(255\d{9}|0\d{9})/);
      if (phoneOnly && phoneOnly[1]) {
        senderPhone = this.normalizePhoneNumber(phoneOnly[1]);
      }
    }

    // Extract Customer Memo / Reference if present (e.g., Akaunti: INV-1002 or Kumbukumbu: ...)
    let customerMemo: string | null = null;
    const memoMatch = text.match(/(?:Akaunti|Kumbukumbu|Account|Ref|Reference)(?:\s+namba)?(?:\s*:|\s+ni)?\s*([A-Za-z0-9_-]+)/i);
    if (memoMatch && memoMatch[1]) {
      customerMemo = memoMatch[1].trim();
    }

    return {
      provider: this.provider,
      reference,
      amountCents,
      currency: CurrencyCode.TZS,
      senderPhone,
      senderName,
      recipientAccount: null,
      customerMemo,
      providerTimestamp: defaultDate,
      rawText: body,
    };
  }
}

