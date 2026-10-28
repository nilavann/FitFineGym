/**
 * Reads a FunctionsHttpError's JSON body (the `{ error: message }` shape every Edge
 * Function in this app returns) so failures surface a real message, not supabase-js's
 * generic "non-2xx status code" one. Shared by every repository that calls an Edge
 * Function — see repositories/subscription.repository.ts for the first place this
 * pattern was needed.
 *
 * A request that never reached the server (offline, dropped connection) is a
 * `FunctionsFetchError` whose message is "Failed to send a request to the Edge Function".
 * Pages recognise being offline by the browser's own `fetch` message, "Failed to fetch" —
 * which is what a direct supabase-js query reports — so it is normalised to that here;
 * otherwise an offline checkout would show the SDK's wording instead of the offline UI.
 */
/**
 * What an Edge Function failure carries: the message, the stable `code` when the function sent one
 * (`{ error, code }`), and the HTTP status when there was a response.
 */
async function readFunctionError(error: unknown): Promise<{ message: string; code?: string; status?: number }> {
  if ((error as { name?: unknown } | null)?.name === 'FunctionsFetchError') return { message: 'Failed to fetch' };
  const maybeContext = (error as { context?: Response }).context;
  const status = typeof maybeContext?.status === 'number' ? maybeContext.status : undefined;
  if (maybeContext && typeof maybeContext.json === 'function') {
    try {
      const body = await maybeContext.json();
      if (body && typeof body.error === 'string') {
        return { message: body.error, code: typeof body.code === 'string' ? body.code : undefined, status };
      }
    } catch {
      // Body wasn't JSON (e.g. the platform's own 413) — fall through to the generic message below.
    }
  }
  return { message: error instanceof Error ? error.message : 'Unexpected error', status };
}

export async function extractFunctionErrorMessage(error: unknown): Promise<string> {
  return (await readFunctionError(error)).message;
}

/**
 * An Edge Function failure with its stable `code` (e.g. `MEMBER_PHONE_IN_USE`) and HTTP `status`.
 * Callers that need to tell cases apart switch on `code` or `status` (404: already gone, 403: not
 * allowed, 413: too large — spec/frontend/backend-api.md §2), never on the message text,
 * which may change. `code` is undefined for a function that sends none, for an offline request and
 * for an unexpected error; `status` is undefined when no response arrived.
 */
export class EdgeFunctionError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = 'EdgeFunctionError';
  }
}

export async function toEdgeFunctionError(error: unknown): Promise<EdgeFunctionError> {
  const { message, code, status } = await readFunctionError(error);
  return new EdgeFunctionError(message, code, status);
}

/** True when the function answered 404: the row is missing or was already deleted (deletes used to succeed silently). */
export function isNotFound(error: unknown): boolean {
  return error instanceof EdgeFunctionError && error.status === 404;
}

const PERSON_FACING_STATUSES = [400, 403, 409, 413];

/**
 * The function's own message when it refused for a reason the user can act on — 400 (a field, named
 * in the message), 403 (not allowed), 409 (in use / conflict), 413 (too large) — else undefined. A 500
 * is always the generic "Something went wrong" and never carries database text, so it isn't included:
 * the page shows its own generic wording instead.
 */
export function refusalMessage(error: unknown): string | undefined {
  return error instanceof EdgeFunctionError && error.status !== undefined && PERSON_FACING_STATUSES.includes(error.status)
    ? error.message
    : undefined;
}
