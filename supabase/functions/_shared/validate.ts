// Request-body validation and normalizing. One
// schema per request body; the first failing field is a 400 before any database call, and the
// result is typed, so no handler casts its payload.
//
// Text is normalized, never escaped: unsafe characters are stripped (the same set the database's
// *_text constraints reject, so a value accepted here is one the database accepts), surrounding
// whitespace is trimmed, and the length is counted in characters, as char_length does. Values
// reach the database only as typed RPC parameters or through .eq / .in.
import { HttpError } from './http.ts';

export interface Rule<T> {
  readonly optional?: boolean;
  parse(value: unknown, path: string): T;
}

function invalid(path: string, reason: string): never {
  throw new HttpError(400, `${path || 'body'} ${reason}`);
}

// C0 controls, DEL, U+200B, U+200E-U+200F, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF: the
// database's character rule. Lone surrogates too, which Postgres can't store. ZWNJ and ZWJ
// (U+200C, U+200D) stay: Indic scripts need them in ordinary names.
const UNSAFE: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x7f], [0x200b, 0x200b], [0x200e, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2060], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xd800, 0xdfff],
];
const LINE_FEED = 0x0a;

/** Removes every unsafe character; a multi-line value keeps its line feeds. */
export function stripUnsafe(value: string, multiline: boolean): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (multiline && cp === LINE_FEED) out += ch;
    else if (!UNSAFE.some(([lo, hi]) => cp >= lo && cp <= hi)) out += ch;
  }
  return out;
}

/** Characters as Postgres' char_length counts them (code points). */
export function charLength(value: string): number {
  return Array.from(value).length;
}

function normalize(value: unknown, path: string, max: number, multiline: boolean): string {
  if (typeof value !== 'string') invalid(path, 'must be a string');
  const out = stripUnsafe(value, multiline).trim();
  if (charLength(out) > max) invalid(path, `must be at most ${max} characters`);
  return out;
}

export interface TextOptions {
  max: number;
  /** Keeps line feeds (notes, addresses). Every other unsafe character is still stripped. */
  multiline?: boolean;
}

/** A required string: normalized, not blank, at most `max` characters. */
export function text({ max, multiline = false }: TextOptions): Rule<string> {
  return {
    parse(value, path) {
      const out = normalize(value, path, max, multiline);
      if (out === '') invalid(path, 'must not be blank');
      return out;
    },
  };
}

/** An optional free-text field: null, or a string normalized like text(); blank becomes null. */
export function textOrNull({ max, multiline = false }: TextOptions): Rule<string | null> {
  return {
    parse(value, path) {
      if (value === null) return null;
      const out = normalize(value, path, max, multiline);
      return out === '' ? null : out;
    },
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function email(): Rule<string> {
  return {
    parse(value, path) {
      const out = text({ max: 254 }).parse(value, path);
      if (!EMAIL.test(out)) invalid(path, 'must be an email address');
      return out;
    },
  };
}

/** A string of exactly `length` ASCII digits (phone, pincode, Aadhaar). No normalizing: spaces are the client's to remove. */
export function digits(length: number): Rule<string> {
  const re = new RegExp(`^[0-9]{${length}}$`);
  return {
    parse(value, path) {
      if (typeof value !== 'string' || !re.test(value)) invalid(path, `must be exactly ${length} digits`);
      return value;
    },
  };
}

/** A positive integer id (bigint ids fit in a safe integer; roles.id is a smallint). */
export function id({ max = Number.MAX_SAFE_INTEGER }: { max?: number } = {}): Rule<number> {
  return {
    parse(value, path) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
        invalid(path, 'must be a positive integer id');
      }
      return value;
    },
  };
}

export function integer({ min, max }: { min: number; max: number }): Rule<number> {
  return {
    parse(value, path) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        invalid(path, `must be an integer from ${min} to ${max}`);
      }
      return value;
    },
  };
}

/** A finite number from `min` to `max`, any number of decimals (numeric without a scale). */
export function decimal({ min, max }: { min: number; max: number }): Rule<number> {
  return {
    parse(value, path) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        invalid(path, `must be a number from ${min} to ${max}`);
      }
      return value;
    },
  };
}

/** A money amount: 0 to `max`, at most two decimals (numeric(10,2)). */
export function amount({ max = 99_999_999.99 }: { max?: number } = {}): Rule<number> {
  return {
    parse(value, path) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
        invalid(path, `must be an amount from 0 to ${max}`);
      }
      if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) invalid(path, 'must have at most two decimals');
      return value;
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(): Rule<string> {
  return {
    parse(value, path) {
      if (typeof value !== 'string' || !UUID.test(value)) invalid(path, 'must be a UUID');
      return value;
    },
  };
}

/** A calendar date, YYYY-MM-DD, that exists (no 2026-02-30). */
export function date(): Rule<string> {
  return {
    parse(value, path) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(path, 'must be a date (YYYY-MM-DD)');
      const d = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) invalid(path, 'must be a real calendar date');
      return value;
    },
  };
}

export function boolean(): Rule<boolean> {
  return {
    parse(value, path) {
      if (typeof value !== 'boolean') invalid(path, 'must be true or false');
      return value;
    },
  };
}

export function oneOf<const T extends readonly string[]>(values: T): Rule<T[number]> {
  return {
    parse(value, path) {
      if (typeof value !== 'string' || !values.includes(value)) invalid(path, `must be one of ${values.join(', ')}`);
      return value as T[number];
    },
  };
}

/** An array of `min` to `max` elements, each checked by `element`. */
export function array<T>(element: Rule<T>, { min = 0, max }: { min?: number; max: number }): Rule<T[]> {
  return {
    parse(value, path) {
      if (!Array.isArray(value)) invalid(path, 'must be an array');
      if (value.length < min) invalid(path, `must have at least ${min} item(s)`);
      if (value.length > max) invalid(path, `must have at most ${max} item(s)`);
      return value.map((v, i) => element.parse(v, `${path}[${i}]`));
    },
  };
}

/** The field may be left out of the body; it is then absent from the result. */
export function optional<T>(rule: Rule<T>): Rule<T> & { readonly optional: true } {
  return { optional: true, parse: (value, path) => rule.parse(value, path) };
}

/** The field may be null. */
export function nullable<T>(rule: Rule<T>): Rule<T | null> {
  return { parse: (value, path) => (value === null ? null : rule.parse(value, path)) };
}

type Shape = Record<string, Rule<unknown>>;
/** The type a rule parses to: `Parsed<typeof schema>` is the request DTO. */
export type Parsed<R> = R extends Rule<infer T> ? T : never;
type Required<S extends Shape> = { [K in keyof S as S[K] extends { optional: true } ? never : K]: Parsed<S[K]> };
type Optional<S extends Shape> = { [K in keyof S as S[K] extends { optional: true } ? K : never]?: Parsed<S[K]> };
export type Infer<S extends Shape> = Required<S> & Optional<S>;

/**
 * A JSON object with exactly these fields. Any other field is rejected, so a body can't carry
 * deleted_at, created_by and the like. Fields are looked up with Object.hasOwn, never through the
 * prototype chain: __proto__ or constructor is just an unknown field.
 */
export function object<S extends Shape>(shape: S): Rule<Infer<S>> {
  return {
    parse(value, path) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'must be an object');
      const input = value as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(shape, key)) invalid(path ? `${path}.${key}` : key, 'is not a known field');
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        const field = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(input, key)) {
          if (shape[key].optional) continue;
          invalid(field, 'is required');
        }
        out[key] = shape[key].parse(input[key], field);
      }
      return out as Infer<S>;
    },
  };
}

/**
 * Adds a rule that spans fields: `check` gets the parsed value and returns the offending field and
 * why, or null. The first failing field is a 400 like any other (`<path>.<field> <reason>`).
 */
export function refine<T>(rule: Rule<T>, check: (value: T) => { field: string; reason: string } | null): Rule<T> {
  return {
    parse(value, path) {
      const parsed = rule.parse(value, path);
      const problem = check(parsed);
      if (problem) invalid(path ? `${path}.${problem.field}` : problem.field, problem.reason);
      return parsed;
    },
  };
}

/** Validates a request body against its schema: the typed result, or a 400. */
export function parseBody<T>(schema: Rule<T>, body: unknown): T {
  return schema.parse(body, '');
}
