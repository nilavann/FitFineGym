// The error model every Edge Function shares: typed errors with an HTTP status and an optional
// machine-readable `code`, and the one place a database refusal (SQLSTATE PT400/403/404/409) is
// turned into one of them.
//
// `message` is for a person and may change; `code` is for the client to switch on and is stable
// (MEMBER_IN_USE, not "Cannot delete — used by 2 subscription/add-on record(s)"). A code is added
// per entity (_entities/<entity>/errors.ts) and only where the client needs to tell cases apart.

export const GENERIC_ERROR = 'Something went wrong — please try again';

/** An error whose message is meant for the caller, with its HTTP status. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, code?: string) {
    super(400, message, code);
    this.name = 'BadRequestError';
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string, code?: string) {
    super(403, message, code);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, code?: string) {
    super(404, message, code);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, code?: string) {
    super(409, message, code);
    this.name = 'ConflictError';
  }
}

/** The statuses the API functions raise (their SQLSTATE is `PT<status>`). */
export type RpcStatus = 400 | 403 | 404 | 409;

/** The `code` an entity gives each refusal status of one RPC. A status left out has no code. */
export type RpcErrorCodes = Partial<Record<RpcStatus, string>>;

const ERROR_BY_STATUS: Record<RpcStatus, new (message: string, code?: string) => HttpError> = {
  400: BadRequestError,
  403: ForbiddenError,
  404: NotFoundError,
  409: ConflictError,
};

/**
 * Turns a database refusal into the caller's error. The API functions raise every refusal with a
 * PostgREST status as its SQLSTATE (PT400, PT403, PT404, PT409); those keep their message and get
 * the entity's `codes[status]`. Any other error is unexpected and is rethrown, which the handler
 * turns into the generic 500.
 */
export function rpcError(error: { message?: string; code?: string } | null, codes: RpcErrorCodes = {}): void {
  if (!error) return;
  const m = /^PT(400|403|404|409)$/.exec(error.code ?? '');
  if (m) {
    const status = Number(m[1]) as RpcStatus;
    throw new ERROR_BY_STATUS[status](error.message ?? GENERIC_ERROR, codes[status]);
  }
  throw error;
}
