// HTTP plumbing every Edge Function shares: CORS, JSON
// responses, the POST-only check, body reading and the one error handler.
//
// Expected errors (HttpError and its subclasses, and a database refusal mapped by rpcError) keep
// their message, status and code. Anything else is logged in full here and reaches the browser
// only as a generic 500, so no table, constraint or column name leaks to the client. The error
// types live in errors.ts and are re-exported here, so existing imports keep working.
import { GENERIC_ERROR, HttpError, rpcError } from './errors.ts';

export { GENERIC_ERROR, HttpError, rpcError };

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export const MAX_BODY_BYTES = 64 * 1024;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** `{ error }`, plus `{ code }` when the error has one. */
export function jsonError(message: string, status: number, code?: string): Response {
  return json(code === undefined ? { error: message } : { error: message, code }, status);
}

/**
 * Reads the request body whole, refusing one over `maxBytes` with a 413. A declared Content-Length
 * over the limit is refused before reading; otherwise the body is read in chunks and cancelled
 * the moment it passes the limit, so an oversized body is never held whole.
 */
export async function readBytes(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new HttpError(413, 'Request body is too large');
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) throw tooLarge();

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

/** `text` as a JSON object, or a 400 naming `what`. */
export function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, `${what} must be a JSON object`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, `${what} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Reads the request body as a JSON object. An empty body is `{}`. Over 64 KiB is 413; anything
 * that isn't a JSON object, including an array, is 400.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readBytes(req, MAX_BODY_BYTES)).trim();
  if (text === '') return {};
  return parseJsonObject(text, 'Request body');
}

export interface MultipartShape {
  /** Largest body accepted, in bytes (413 above it). */
  maxBytes: number;
  /** Text parts that may appear. */
  fields: readonly string[];
  /** File parts that may appear. */
  files: readonly string[];
}

export interface Multipart {
  fields: Record<string, string>;
  files: Record<string, File>;
}

/**
 * Reads a multipart/form-data body. Only the parts named in `shape` are accepted, each at most
 * once, a text part as text and a file part as a file: anything else is a 400, the multipart
 * equivalent of an unknown JSON field. A body that isn't multipart/form-data is a 415. The size
 * limit is enforced while reading (readBytes), before the body is parsed.
 */
export async function readMultipart(req: Request, shape: MultipartShape): Promise<Multipart> {
  const contentType = req.headers.get('Content-Type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new HttpError(415, 'Request body must be multipart/form-data');
  }
  const bytes = await readBytes(req, shape.maxBytes);

  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new HttpError(400, 'Request body is not valid multipart/form-data');
  }

  const out: Multipart = { fields: {}, files: {} };
  const seen = new Set<string>();
  for (const [name, value] of form.entries()) {
    const isField = shape.fields.includes(name);
    const isFile = shape.files.includes(name);
    if (!isField && !isFile) throw new HttpError(400, `${name} is not a known field`);
    if (seen.has(name)) throw new HttpError(400, `${name} must appear only once`);
    seen.add(name);
    if (typeof value === 'string') {
      if (!isField) throw new HttpError(400, `${name} must be a file`);
      out.fields[name] = value;
    } else {
      if (!isFile) throw new HttpError(400, `${name} must be text`);
      out.files[name] = value;
    }
  }
  return out;
}

type Handler = (req: Request) => Promise<Response>;

/** CORS preflight, POST only, then `fn`; every error ends here. */
export function handle(name: string, fn: Handler): Handler {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return jsonError('Method not allowed', 405);
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) return jsonError(err.message, err.status, err.code);
      console.error(`${name} error:`, err);
      return jsonError(GENERIC_ERROR, 500);
    }
  };
}

/** Registers the function with the Edge Runtime. */
export function serve(name: string, fn: Handler): void {
  Deno.serve(handle(name, fn));
}
