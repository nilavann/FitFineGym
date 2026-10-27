/**
 * The database's text rules (supabase/migrations/…_fitfine_constraints.sql, the `*_text` CHECKs), applied
 * on the client so a constraint is never the first line of feedback (spec/frontend/backend-api-changes.md §5).
 * Same character set as the Edge Functions' `_shared/validate.ts`: C0 controls, DEL, U+200B, U+200E-U+200F,
 * U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF, and lone surrogates. ZWNJ/ZWJ (U+200C, U+200D) stay:
 * Indic scripts need them in ordinary names. A multi-line field keeps its line feeds.
 */
const UNSAFE: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x7f], [0x200b, 0x200b], [0x200e, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2060], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xd800, 0xdfff],
];
const LINE_FEED = 0x0a;

/** Removes every unsafe character, then trims — what is actually written. */
export function cleanText(value: string, multiline = false): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (multiline && cp === LINE_FEED) out += ch;
    else if (!UNSAFE.some(([lo, hi]) => cp >= lo && cp <= hi)) out += ch;
  }
  return out.trim();
}

/** Characters as Postgres' `char_length` counts them (code points), not UTF-16 units. */
export function charLength(value: string): number {
  return Array.from(value).length;
}

/** The database's length limits, by field. */
export const TEXT_LIMITS = {
  name: 80,
  relationship: 40,
  address: 500,
  description: 500,
  doctorCareDetails: 1000,
  notes: 200,
  email: 254,
} as const;
