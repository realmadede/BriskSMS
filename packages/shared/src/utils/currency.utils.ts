/**
 * Currency utilities for handling financial minor units (cents)
 * Eliminates IEEE 754 floating-point inaccuracies
 */

/**
 * Converts a major currency unit (e.g., 50000.50 TZS) to integer cents (5000050)
 */
export function toMinorUnits(amount: number | string, decimalPlaces = 2): bigint {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) {
    throw new Error(`Invalid numeric amount: '${amount}'`);
  }
  const factor = Math.pow(10, decimalPlaces);
  return BigInt(Math.round(num * factor));
}

/**
 * Converts minor integer units (e.g. 5000050) back to standard major number (50000.50)
 */
export function toMajorUnits(minorUnits: bigint | number, decimalPlaces = 2): number {
  const num = typeof minorUnits === 'bigint' ? Number(minorUnits) : minorUnits;
  const factor = Math.pow(10, decimalPlaces);
  return num / factor;
}

/**
 * Formats a minor integer amount into standard Tanzanian Shilling display string (e.g., "TZS 50,000")
 */
export function formatTzs(minorUnits: bigint | number, includeCents = false): string {
  const major = toMajorUnits(minorUnits);
  const formatted = new Intl.NumberFormat('en-TZ', {
    style: 'currency',
    currency: 'TZS',
    minimumFractionDigits: includeCents ? 2 : 0,
    maximumFractionDigits: includeCents ? 2 : 0,
  }).format(major);

  return formatted;
}

