/**
 * Currency utilities for handling financial minor units (cents)
 * Eliminates IEEE 754 floating-point inaccuracies
 */

/**
 * Converts a major currency unit (e.g., 50000.50 TZS) to integer cents (5000050)
 * using exact decimal parsing without IEEE-754 floating-point multiplication loss.
 */
export function toMinorUnits(amount: number | string, decimalPlaces = 2): bigint {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 18) {
    throw new Error(`Invalid decimalPlaces: '${decimalPlaces}'`);
  }

  let rawStr: string;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) {
      throw new Error(`Invalid numeric amount: '${amount}'`);
    }
    const asStr = amount.toString();
    rawStr = /e/i.test(asStr)
      ? amount.toFixed(Math.min(18, decimalPlaces + 6)).replace(/\.?0+$/, '')
      : asStr;
  } else if (typeof amount === 'string') {
    rawStr = amount.replace(/,/g, '').trim();
  } else {
    throw new Error(`Invalid numeric amount: '${String(amount)}'`);
  }

  const match = rawStr.match(/^(-)?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);
  if (!match) {
    throw new Error(`Invalid numeric amount: '${amount}'`);
  }

  const isNegative = Boolean(match[1]);
  const wholeStr = match[2] ?? '0';
  const fracStr = match[3] ?? match[4] ?? '';

  if (fracStr.length === 0 && rawStr.endsWith('.')) {
    throw new Error(`Invalid numeric amount: '${amount}'`);
  }

  const paddedFrac = fracStr.padEnd(decimalPlaces + 1, '0');
  const mainFracStr = decimalPlaces > 0 ? paddedFrac.slice(0, decimalPlaces) : '0';
  const roundDigit = paddedFrac.charAt(decimalPlaces);

  const scale = 10n ** BigInt(decimalPlaces);
  let minor = BigInt(wholeStr) * scale + BigInt(mainFracStr);
  if (roundDigit >= '5') {
    minor += 1n;
  }

  return isNegative && minor !== 0n ? -minor : minor;
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

