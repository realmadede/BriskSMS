import { PaymentProvider } from '../enums/payment-provider.enum.js';

export const TANZANIAN_MOBILE_PREFIXES: readonly string[] = [
  '74', '75', '76', // Vodacom (historical TCRA assignment; MNP allows porting)
  '65', '67', '71', '77', // Mixx by Yas / Tigo / Zantel (historical assignment)
  '68', '69', '78', // Airtel (historical assignment)
  '61', '62', // Halotel (historical assignment)
  '73', // TTCL (historical assignment)
];

/**
 * Normalizes any Tanzanian phone number format into canonical E.164 or MSISDN representation.
 * Examples:
 *   "0754 123 456" -> "255754123456" (or "+255754123456")
 *   "+255-784-999-000" -> "255784999000"
 *   "713 000 111" -> "255713000111"
 */
export function normalizeTanzanianPhone(input: string, includePlus = false): string {
  if (!input || typeof input !== 'string') {
    throw new Error('Phone number must be a non-empty string');
  }

  // Strip all non-digit characters except leading plus
  let cleaned = input.trim().replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }

  // Handle local 10-digit format starting with 0: e.g., 0754123456
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '255' + cleaned.substring(1);
  }

  // Handle 9-digit format without leading 0: e.g., 754123456
  if (cleaned.length === 9 && (cleaned.startsWith('6') || cleaned.startsWith('7'))) {
    cleaned = '255' + cleaned;
  }

  if (cleaned.length !== 12 || !cleaned.startsWith('255')) {
    throw new Error(`Invalid Tanzanian mobile phone number: '${input}'`);
  }

  const prefix2 = cleaned.substring(3, 5);
  if (!TANZANIAN_MOBILE_PREFIXES.includes(prefix2)) {
    throw new Error(`Invalid Tanzanian mobile phone number: '${input}'`);
  }

  return includePlus ? `+${cleaned}` : cleaned;
}

/**
 * Validates whether a phone number corresponds to an assigned Tanzanian mobile prefix.
 * Note: validates number syntax only; does NOT assert current carrier under MNP.
 */
export function isValidTanzanianMobileNumber(phone: string): boolean {
  try {
    normalizeTanzanianPhone(phone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Infers a legacy TCRA numbering-plan carrier hint from an MSISDN prefix.
 * NON-AUTHORITATIVE under Mobile Number Portability (MNP): callers initiating payments
 * should pass an explicit PaymentProvider when known rather than relying on prefix alone.
 */
export function inferCarrierHintFromPrefix(phone: string): PaymentProvider {
  const normalized = normalizeTanzanianPhone(phone);
  const prefix2 = normalized.substring(3, 5);

  // Vodacom M-Pesa: 074x, 075x, 076x
  if (prefix2 === '74' || prefix2 === '75' || prefix2 === '76') {
    return PaymentProvider.MPESA;
  }

  // Mixx by Yas (Tigo Pesa / Zantel): 065x, 067x, 071x, 077x
  if (prefix2 === '65' || prefix2 === '67' || prefix2 === '71' || prefix2 === '77') {
    return PaymentProvider.MIXX;
  }

  // Airtel Money: 068x, 069x, 078x
  if (prefix2 === '68' || prefix2 === '69' || prefix2 === '78') {
    return PaymentProvider.AIRTEL_MONEY;
  }

  // HaloPesa: 061x, 062x
  if (prefix2 === '61' || prefix2 === '62') {
    return PaymentProvider.HALOPESA;
  }

  // TTCL Pesa: 073x
  if (prefix2 === '73') {
    return PaymentProvider.TTCL_PESA;
  }

  throw new Error(`Unsupported or invalid Tanzanian mobile provider for number: '${phone}'`);
}

/**
 * @deprecated Prefix-only detection is non-authoritative under Tanzania MNP.
 * Use explicit PaymentProvider selection or inferCarrierHintFromPrefix() as fallback.
 */
export function detectTanzanianCarrier(phone: string): PaymentProvider {
  return inferCarrierHintFromPrefix(phone);
}
