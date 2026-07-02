/**
 * VCC Utilities - Card generation and formatting
 * BIN lookup is handled separately via API
 */

import type { BinEntry } from './bin-data';

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'jcb' | 'unionpay' | 'diners' | 'unknown';

export interface GeneratedCard {
  bin: string;
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  brand?: CardBrand;
  binInfo?: BinEntry;
}

/**
 * Detect card brand from card number
 */
export function detectBrand(number: string): CardBrand {
  const num = number.replace(/\D/g, '');

  if (num.startsWith('4')) return 'visa';
  if (/^5[1-5]/.test(num) || /^2[2-7]/.test(num)) return 'mastercard';
  if (/^3[47]/.test(num)) return 'amex';
  if (/^6(?:011|5|4[4-9]|22(?:1(?:2[6-9]|[3-9])|[2-8]|9(?:[01]\d|2[0-5])))/.test(num)) return 'discover';
  if (/^35(?:2[89]|[3-8][0-9])/.test(num)) return 'jcb';
  if (/^62/.test(num)) return 'unionpay';
  if (/^3(?:0[0-5]|[689])/.test(num)) return 'diners';

  return 'unknown';
}

/**
 * Generate Luhn-valid card number
 */
export function generateCardNumber(bin: string, length: number = 16): string {
  // Pad BIN to ensure we have enough digits
  const binDigits = bin.replace(/\D/g, '').slice(0, 8);

  // Start with BIN
  const digits = binDigits.split('').map(Number);

  // Fill remaining digits with random numbers (except last digit)
  while (digits.length < length - 1) {
    digits.push(Math.floor(Math.random() * 10));
  }

  // Calculate Luhn check digit
  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits[i];

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  digits.push(checkDigit);

  return digits.join('');
}

/**
 * Generate random expiry date
 */
export function generateExpiry(minYears: number = 1, maxYears: number = 5): { month: string; year: string } {
  const now = new Date();
  const minDate = new Date(now.getFullYear() + minYears, now.getMonth() + 1, 1);
  const maxDate = new Date(now.getFullYear() + maxYears, 11, 31);

  const randomTime = minDate.getTime() + Math.random() * (maxDate.getTime() - minDate.getTime());
  const randomDate = new Date(randomTime);

  return {
    month: String(randomDate.getMonth() + 1).padStart(2, '0'),
    year: String(randomDate.getFullYear()),
  };
}

/**
 * Generate random CVV
 */
export function generateCVV(brand: CardBrand): string {
  // Amex uses 4 digits, others use 3
  const length = brand === 'amex' ? 4 : 3;
  return String(Math.floor(Math.random() * Math.pow(10, length))).padStart(length, '0');
}

/**
 * Generate multiple VCCs
 */
export function generateVCCs(
  bin: string,
  count: number = 10,
  binInfo?: BinEntry
): GeneratedCard[] {
  const cards: GeneratedCard[] = [];

  const brand = binInfo?.brand.toLowerCase() as CardBrand || detectBrand(bin);

  // Determine card length based on brand
  const length = brand === 'amex' ? 15 : 16;

  for (let i = 0; i < count; i++) {
    const number = generateCardNumber(bin, length);
    const expiry = generateExpiry();
    const cvv = generateCVV(brand);

    cards.push({
      bin,
      number,
      expMonth: expiry.month,
      expYear: expiry.year,
      cvv,
      brand,
      binInfo: binInfo || undefined,
    });
  }

  return cards;
}

/**
 * Format card number for display
 */
export function formatCardNumber(number: string): string {
  const cleaned = number.replace(/\D/g, '');
  const brand = detectBrand(cleaned);

  if (brand === 'amex') {
    // Amex: 4-6-5 format
    return cleaned.replace(/(\d{4})(\d{6})(\d{5})/, '$1 $2 $3');
  }

  // Standard: 4-4-4-4 format
  return cleaned.replace(/(\d{4})/g, '$1 ').trim();
}

/**
 * Format expiry date for display
 */
export function formatExpiry(month: string, year: string): string {
  const shortYear = year.slice(-2);
  return `${month}/${shortYear}`;
}

/**
 * Get brand display name
 */
export function getBrandName(brand: string): string {
  const brandNames: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
    discover: 'Discover',
    jcb: 'JCB',
    unionpay: 'UnionPay',
    diners: 'Diners Club',
  };
  return brandNames[brand.toLowerCase()] || brand.toUpperCase();
}

/**
 * Get brand gradient class
 */
export function getBrandGradient(brand: string): string {
  const gradients: Record<string, string> = {
    visa: 'from-blue-600 to-blue-800',
    mastercard: 'from-red-500 to-orange-500',
    amex: 'from-blue-400 to-cyan-400',
    discover: 'from-orange-400 to-yellow-400',
    jcb: 'from-green-500 to-blue-500',
    unionpay: 'from-red-600 to-blue-600',
    diners: 'from-blue-500 to-indigo-500',
  };
  return gradients[brand.toLowerCase()] || 'from-gray-600 to-gray-800';
}

/**
 * Card data interface for export
 */
export interface CardData {
  number?: string;
  expMonth?: string;
  expYear?: string;
  cvv?: string;
  brand?: string;
  binInfo?: BinEntry;
  [key: string]: any;
}

/**
 * Export cards as TXT
 */
export function exportAsTxt(cards: CardData[]): string {
  return cards
    .map((card) => {
      const number = card.number || '';
      const exp = card.expMonth && card.expYear ? `${card.expMonth}/${card.expYear.slice(-2)}` : '';
      const cvv = card.cvv || '';
      return `${number}|${exp}|${cvv}`;
    })
    .join('\n');
}

/**
 * Export cards as CSV
 */
export function exportAsCsv(cards: CardData[]): string {
  const header = 'Number,Exp,CVV,Brand,Issuer,Country\n';
  const rows = cards.map((card) => {
    const number = card.number || '';
    const exp = card.expMonth && card.expYear ? `${card.expMonth}/${card.expYear.slice(-2)}` : '';
    const cvv = card.cvv || '';
    const brand = card.brand || card.binInfo?.brand || '';
    const issuer = card.binInfo?.issuer || '';
    const country = card.binInfo?.countryName || '';
    return `"${number}","${exp}","${cvv}","${brand}","${issuer}","${country}"`;
  });
  return header + rows.join('\n');
}

/**
 * Export cards as JSON
 */
export function exportAsJson(cards: CardData[]): string {
  return JSON.stringify(cards, null, 2);
}

/**
 * Format card for export
 */
export function formatCardForExport(card: GeneratedCard): string {
  return `${card.number}|${card.expMonth}/${card.expYear}|${card.cvv}`;
}

/**
 * Parse imported card line
 */
export function parseCardLine(line: string): { number: string; month: string; year: string; cvv: string } | null {
  const cleaned = line.trim();
  if (!cleaned) return null;

  // Try pipe format: number|mm/yy|cvv or number|mm|yy|cvv
  const pipeParts = cleaned.split('|');
  if (pipeParts.length >= 3) {
    const number = pipeParts[0].replace(/\D/g, '');

    if (pipeParts.length === 3) {
      // number|mm/yy|cvv
      const [month, year] = pipeParts[1].split('/');
      const cvv = pipeParts[2];

      if (number.length >= 13 && month && year && cvv) {
        return { number, month, year, cvv };
      }
    } else if (pipeParts.length === 4) {
      // number|mm|yy|cvv
      const month = pipeParts[1];
      const year = pipeParts[2];
      const cvv = pipeParts[3];

      if (number.length >= 13 && month && year && cvv) {
        return { number, month, year, cvv };
      }
    }
  }

  // Try space format: number mm/yy cvv
  const spaceParts = cleaned.split(/\s+/);
  if (spaceParts.length >= 3) {
    const number = spaceParts[0].replace(/\D/g, '');

    if (spaceParts.length === 3) {
      // number mm/yy cvv
      const [month, year] = spaceParts[1].split('/');
      const cvv = spaceParts[2];

      if (number.length >= 13 && month && year && cvv) {
        return { number, month, year, cvv };
      }
    } else if (spaceParts.length === 4) {
      // number mm yy cvv
      const month = spaceParts[1];
      const year = spaceParts[2];
      const cvv = spaceParts[3];

      if (number.length >= 13 && month && year && cvv) {
        return { number, month, year, cvv };
      }
    }
  }

  return null;
}

/**
 * Parse multiple card lines
 */
export function parseCardLines(text: string): { number: string; month: string; year: string; cvv: string }[] {
  return text
    .split('\n')
    .map(parseCardLine)
    .filter((card): card is NonNullable<typeof card> => card !== null);
}

/**
 * Validate card number with Luhn algorithm
 */
export function validateLuhn(number: string): boolean {
  const digits = number.replace(/\D/g, '').split('').map(Number);

  if (digits.length < 13) return false;

  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits[i];

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}
