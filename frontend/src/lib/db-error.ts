/**
 * A failed direct write (PostgREST) with what a page needs to tell cases apart: the SQLSTATE `code` and,
 * for a constraint violation, the constraint's name. Pages switch on these, never on the message text —
 * "chk_branches_code_format" contains "code" just as a duplicate code does.
 */
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';

export class DbError extends Error {
  constructor(message: string, readonly code?: string, readonly constraint?: string) {
    super(message);
    this.name = 'DbError';
  }
}

const CONSTRAINT_NAME = /constraint "([^"]+)"/;

/** Wraps a supabase-js `PostgrestError`. The message is kept as is, so `isNetworkError()` still recognises an offline write. */
export function toDbError(error: { message: string; code?: string }): DbError {
  const constraint = CONSTRAINT_NAME.exec(error.message)?.[1];
  return new DbError(error.message, error.code || undefined, constraint);
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof DbError && error.code === UNIQUE_VIOLATION;
}

/** The constraint a CHECK violation names, or undefined for any other error. */
export function checkViolation(error: unknown): string | undefined {
  return error instanceof DbError && error.code === CHECK_VIOLATION ? error.constraint : undefined;
}

/**
 * The form field a `fitfine.<table>` CHECK constraint guards: `chk_<table>_<field>_(text|format|not_blank)`
 * (supabase/migrations/…_fitfine_constraints.sql), when `<field>` is one of `fields`.
 */
export function constraintField<F extends string>(constraint: string | undefined, table: string, fields: readonly F[]): F | undefined {
  const match = constraint ? new RegExp(`^chk_${table}_(.+)_(?:text|format|not_blank)$`).exec(constraint) : null;
  const field = match?.[1];
  return fields.find((f) => f === field);
}
