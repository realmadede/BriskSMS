import {
  CampaignRecipientRow,
  RecipientValidationResult,
} from '@brisksms/shared';

// Supported Tanzanian Mobile Carrier Prefixes (E.164 without '+')
const TZ_CARRIER_PREFIXES = [
  '25574', '25575', '25576', // Vodacom
  '25571', '25565', '25567', // Mixx by Yas (Tigo)
  '25578', '25568', '25569', // Airtel
  '25562',                   // Halotel
  '25573',                   // TTCL
];

export class RecipientParserService {
  private readonly defaultMaxBatch = 1000;

  /**
   * Sanitizes and normalizes a Tanzanian mobile phone number to E.164 format
   */
  normalizePhoneNumber(rawNumber: string): string | null {
    if (!rawNumber) return null;

    // Strip whitespaces, dashes, parentheses
    let cleaned = rawNumber.replace(/[\s\-\(\)\.]+/g, '');

    // Format local Tanzanian format (07... / 06...) -> +255...
    if (cleaned.startsWith('0') && cleaned.length === 10) {
      cleaned = `+255${cleaned.substring(1)}`;
    } else if (cleaned.startsWith('255') && cleaned.length === 12) {
      cleaned = `+${cleaned}`;
    }

    if (!cleaned.startsWith('+255') || cleaned.length !== 13) {
      return null;
    }

    // Verify carrier prefix
    const prefix = cleaned.substring(1, 6);
    if (!TZ_CARRIER_PREFIXES.includes(prefix)) {
      return null;
    }

    return cleaned;
  }

  /**
   * Validates and deduplicates a batch of recipient rows
   */
  processRecipientBatch(
    rawRows: Array<{ phone: string; [key: string]: string }>,
    maxBatchLimit = this.defaultMaxBatch,
  ): RecipientValidationResult {
    const seenPhones = new Set<string>();
    const validRecipients: CampaignRecipientRow[] = [];
    let duplicateCount = 0;
    let invalidCount = 0;

    const boundedRows = rawRows.slice(0, maxBatchLimit);

    for (let i = 0; i < boundedRows.length; i++) {
      const row = boundedRows[i];
      if (!row) continue;
      const normalized = this.normalizePhoneNumber(row.phone);

      if (!normalized) {
        invalidCount++;
        continue;
      }

      if (seenPhones.has(normalized)) {
        duplicateCount++;
        continue;
      }

      seenPhones.add(normalized);

      // Extract variables (all keys except 'phone')
      const variables: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k.toLowerCase() !== 'phone') {
          variables[k] = String(v ?? '');
        }
      }

      validRecipients.push({
        phoneNumber: normalized,
        variables,
        rawRowIndex: i + 1,
      });
    }

    return {
      validRecipients,
      invalidCount,
      duplicateCount,
      totalParsed: boundedRows.length,
    };
  }

  /**
   * Interpolates dynamic template merge tags into personalized message text.
   * Supports user-friendly tags e.g. [Jina la Mteja], [Kiasi], [Namba ya Ankara], [Customer Name], [Amount], [Invoice Number]
   * as well as developer syntax {{name}}, {{amount}}, {{invoice}}.
   */
  interpolateTemplate(
    template: string,
    variables: Record<string, string>,
  ): string {
    const resolveVar = (key: string): string | undefined => {
      if (variables[key] !== undefined) return variables[key];
      const norm = key.toLowerCase().replace(/[\s_-]+/g, '');

      // Check case-insensitive and punctuation-free matches
      for (const [k, v] of Object.entries(variables)) {
        if (k.toLowerCase().replace(/[\s_-]+/g, '') === norm) return v;
      }

      // Friendly Swahili / English semantic aliases
      if (norm === 'jinalamteja' || norm === 'customername' || norm === 'jina' || norm === 'name' || norm === 'customer') {
        return variables['name'] ?? variables['customer_name'] ?? variables['jina'] ?? variables['Customer Name'];
      }
      if (norm === 'kiasi' || norm === 'amount' || norm === 'kiasichafedha' || norm === 'balance') {
        return variables['amount'] ?? variables['kiasi'] ?? variables['Amount'];
      }
      if (norm === 'nambayaankara' || norm === 'invoicenumber' || norm === 'ankara' || norm === 'invoice' || norm === 'orderid' || norm === 'invoiceid') {
        return variables['invoice'] ?? variables['invoice_id'] ?? variables['ankara'] ?? variables['Invoice ID'];
      }
      return undefined;
    };

    // 1. User-friendly bracket tags e.g. [Jina la Mteja], [Kiasi], [Namba ya Ankara], [Customer Name]
    let result = template.replace(/\[\s*([^\]]+)\s*\]/g, (match, tag) => {
      const val = resolveVar(tag);
      return val !== undefined ? val : match;
    });

    // 2. Developer curly tags e.g. {{name}}, {{amount}}, {{invoice}}
    result = result.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, tag) => {
      const val = resolveVar(tag);
      return val !== undefined ? val : match;
    });

    return result;
  }
}

export const recipientParserService = new RecipientParserService();
