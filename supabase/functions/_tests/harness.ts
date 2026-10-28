import { world } from './fake-supabase.ts';

type Handler = (req: Request) => Response | Promise<Response>;
const loaded = new Map<string, Handler>();

/** Imports an Edge Function module with Deno.serve captured, returning its request handler. */
export async function loadFunction(name: string): Promise<Handler> {
  const cached = loaded.get(name);
  if (cached) return cached;
  Deno.env.set('SUPABASE_URL', 'http://localhost:54321');
  Deno.env.set('SUPABASE_ANON_KEY', 'anon');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
  let handler: Handler | undefined;
  const realServe = Deno.serve;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: Handler) => { handler = h; return {}; };
  try {
    await import(`../${name}/index.ts`);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`${name} did not register a handler`);
  loaded.set(name, handler);
  return handler;
}

export interface CallOptions { method?: string; auth?: string | null; body?: unknown; rawBody?: string; formData?: FormData }

/** Calls a loaded function like the Supabase gateway would; returns status + parsed JSON body. */
export async function call(handler: Handler, opts: CallOptions = {}) {
  // A FormData body sets its own multipart Content-Type (with the boundary).
  const headers = new Headers(opts.formData ? {} : { 'Content-Type': 'application/json' });
  if (opts.auth !== null) headers.set('Authorization', opts.auth ?? 'Bearer test-token');
  const method = opts.method ?? 'POST';
  const res = await handler(new Request('http://localhost/fn', {
    method,
    headers,
    body: method === 'POST' ? (opts.formData ?? opts.rawBody ?? JSON.stringify(opts.body ?? {})) : undefined,
  }));
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* not JSON (e.g. "ok") */ }
  return { status: res.status, json, text, headers: res.headers };
}

export function assertEquals<T>(actual: T, expected: T, msg = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
}
export function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}
export function assertMatch(text: string, re: RegExp, msg = '') {
  if (!re.test(text)) throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(text)} to match ${re}`);
}

export { world };

/** Scripts the caller's access, as fitfine.user_access returns it for the JWT's user. */
export function access(level: 'none' | 'active' | 'admin', otherActiveAdmins = 1) {
  world.rpc['user_access'] = () => ({
    data: {
      is_active: level !== 'none',
      is_admin: level === 'admin',
      other_active_admins: otherActiveAdmins,
    },
  });
}

export const rpcCalls = (name: string) => world.log.filter((l) => l.kind === 'rpc' && l.name === name);
export const queries = () => world.log.filter((l) => l.kind === 'query');
/** Every call except the caller's own user_access check. */
export const dataCalls = () => world.log.filter((l) => !(l.kind === 'rpc' && l.name === 'user_access'));
