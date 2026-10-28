import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module wraps `fetch` so a 401 from anywhere except /auth/v1 tells the app its session died. createClient
// is faked so the wrapper can be pulled out of the options it receives and exercised directly.
const created = vi.hoisted(() => ({ args: [] as unknown[] }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    created.args = args;
    return { fake: 'client' };
  },
}));

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const wrappedFetch = (): FetchLike => (created.args[2] as { global: { fetch: FetchLike } }).global.fetch;

async function loadModule() {
  vi.resetModules();
  return import('./supabase-client');
}

let realFetch: typeof fetch;
let expired: ReturnType<typeof vi.fn>;
let badKey: ReturnType<typeof vi.fn>;

beforeEach(() => {
  realFetch = globalThis.fetch;
  expired = vi.fn();
  badKey = vi.fn();
  window.addEventListener('supabase:session-expired', expired);
  window.addEventListener('supabase:invalid-api-key', badKey);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  window.removeEventListener('supabase:session-expired', expired);
  window.removeEventListener('supabase:invalid-api-key', badKey);
  vi.unstubAllEnvs();
});

describe('supabase-client — configuration', () => {
  it('builds the client from the two public env vars (and only those)', async () => {
    await loadModule();
    expect(created.args[0]).toBe('https://unit.supabase.co');
    expect(created.args[1]).toBe('unit-anon-key');
  });

  it('talks to the fitfine schema — the only one the Data API exposes', async () => {
    const mod = await loadModule();
    expect(mod.DB_SCHEMA).toBe('fitfine');
    expect((created.args[2] as { db?: { schema?: string } }).db).toEqual({ schema: 'fitfine' });
  });

  it.each(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'])('fails loudly at import when %s is missing', async (name) => {
    vi.stubEnv(name, '');
    await expect(loadModule()).rejects.toThrow(/Missing VITE_SUPABASE_URL \/ VITE_SUPABASE_ANON_KEY/);
  });

  it('exports the event name AuthProvider listens for', async () => {
    const mod = await loadModule();
    expect(mod.SESSION_EXPIRED_EVENT).toBe('supabase:session-expired');
  });
});

describe('supabase-client — a 401 means the session died', () => {
  const respond = (status: number) => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status })) as unknown as typeof fetch;
  };

  it.each([
    ['REST', 'https://unit.supabase.co/rest/v1/members'],
    ['Storage', 'https://unit.supabase.co/storage/v1/object/sign/member-photos'],
    ['an Edge Function', 'https://unit.supabase.co/functions/v1/create-subscription'],
  ])('dispatches the session-expired event on a 401 from %s', async (_label, url) => {
    await loadModule();
    respond(401);
    await wrappedFetch()(url);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('does NOT on a 401 from /auth/v1 — a wrong password is a 400 and AuthProvider owns that lifecycle', async () => {
    await loadModule();
    respond(401);
    await wrappedFetch()('https://unit.supabase.co/auth/v1/token?grant_type=password');
    expect(expired).not.toHaveBeenCalled();
  });

  it.each([200, 400, 403, 404, 500])('does NOT on a %i (an RLS denial is 403/empty, not an expired token)', async (status) => {
    await loadModule();
    respond(status);
    await wrappedFetch()('https://unit.supabase.co/rest/v1/members');
    expect(expired).not.toHaveBeenCalled();
  });

  it('hands the response back to the caller untouched', async () => {
    await loadModule();
    const response = new Response('body', { status: 401 });
    globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
    await expect(wrappedFetch()('https://unit.supabase.co/rest/v1/members')).resolves.toBe(response);
  });

  it('understands a URL object and a Request, not just a string', async () => {
    await loadModule();
    respond(401);
    await wrappedFetch()(new URL('https://unit.supabase.co/rest/v1/members'));
    await wrappedFetch()(new Request('https://unit.supabase.co/rest/v1/plans'));
    await wrappedFetch()(new Request('https://unit.supabase.co/auth/v1/user'));
    expect(expired).toHaveBeenCalledTimes(2); // the /auth/v1 one is excluded
  });

  it('passes the request through to the real fetch unchanged', async () => {
    await loadModule();
    respond(200);
    const init = { method: 'POST', headers: { a: 'b' } };
    await wrappedFetch()('https://unit.supabase.co/rest/v1/members', init);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://unit.supabase.co/rest/v1/members', init);
  });

  it('lets a network failure propagate (no event — that is "offline", not "signed out")', async () => {
    await loadModule();
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    await expect(wrappedFetch()('https://unit.supabase.co/rest/v1/members')).rejects.toThrow('Failed to fetch');
    expect(expired).not.toHaveBeenCalled();
  });
});

describe('supabase-client — a rejected API key is not an expired session', () => {
  const rejectKey = () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;
  };

  it.each([
    ['REST', 'https://unit.supabase.co/rest/v1/profiles'],
    ['/auth/v1, which a plain 401 would skip', 'https://unit.supabase.co/auth/v1/user'],
  ])('dispatches the invalid-key event, not session-expired, for %s', async (_label, url) => {
    await loadModule();
    rejectKey();
    await wrappedFetch()(url);
    expect(badKey).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
  });

  it('leaves the body readable for the SDK that made the request', async () => {
    await loadModule();
    rejectKey();
    const response = await wrappedFetch()('https://unit.supabase.co/rest/v1/profiles');
    await expect(response.json()).resolves.toMatchObject({ message: 'Invalid API key' });
  });

  it('does not mistake other 401 bodies (an Edge Function, an empty body) for it', async () => {
    await loadModule();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid or expired session' }), { status: 401 })
    ) as unknown as typeof fetch;
    await wrappedFetch()('https://unit.supabase.co/functions/v1/create-subscription');
    expect(badKey).not.toHaveBeenCalled();
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
