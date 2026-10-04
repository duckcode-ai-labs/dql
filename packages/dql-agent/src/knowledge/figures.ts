/**
 * FIGURES, HOWEVER THEY ARE WRITTEN. A document (or a model that obeys one)
 * can state a figure in words ("twelve thousand"), in another script's
 * digits (٣٤٠٠), in full-width or circled digits, as spaced digits
 * ("1 2 0 0 0") or as a vulgar fraction (⅗). `foldFigures` rewrites all of
 * these as plain ASCII numbers, so the checks that keep document figures out
 * of answers read them like any other number.
 */

/** The zero of each decimal-digit run outside ASCII that NFKC leaves alone (Arabic-Indic, Devanagari, Thai, …). */
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0,
  0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0,
  0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10,
];

function asciiDigit(char: string): string {
  const code = char.codePointAt(0)!;
  for (const zero of DIGIT_ZEROS) if (code >= zero && code < zero + 10) return String(code - zero);
  // Another script's digit DQL has no table for: still a digit, so still a figure.
  return '5';
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const WORD = `(?:${[...Object.keys(UNITS), 'hundred', 'dozen', ...Object.keys(SCALES)].join('|')})`;
const SPELLED = new RegExp(`\\b${WORD}(?:(?:[\\s-]+|\\s+and\\s+)${WORD})*\\b`, 'gi');

/** The value of a run of English number words ("three hundred and forty" → 340, "a million" → 1000000). */
function spelledValue(words: string): number {
  let total = 0;
  let current = 0;
  for (const word of words.toLowerCase().split(/[\s-]+/).filter((item) => item && item !== 'and')) {
    if (word in UNITS) current += UNITS[word];
    else if (word === 'hundred') current = (current || 1) * 100;
    else if (word === 'dozen') current = (current || 1) * 12;
    else if (word in SCALES) { total += (current || 1) * SCALES[word]; current = 0; }
  }
  return total + current;
}

/** The text with every number written as plain ASCII digits, so it can be read for figures. */
export function foldFigures(text: string): string {
  return String(text)
    .normalize('NFKC')
    .replace(/\p{Nd}/gu, (char) => (/[0-9]/.test(char) ? char : asciiDigit(char)))
    // ⅗ folds to 3⁄5: a fraction is a ratio, written with a plain slash.
    .replace(/⁄/g, '/')
    // Digits spaced one by one ("1 2 0 0 0") are one number.
    .replace(/(?<![\d.,])\d(?:[    ]\d(?![\d.,])){2,}/g, (run) => run.replace(/\D/g, ''))
    .replace(SPELLED, (words) => String(spelledValue(words)));
}
