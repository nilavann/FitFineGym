import { createClient } from '@supabase/supabase-js';
import { rememberRecoveryFromUrl } from './recovery-flag';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy frontend/.env.example to frontend/.env.local and fill in your project values.'
  );
}

/** AuthContext listens for this to redirect to /login with a friendly message — see below. */
export const SESSION_EXPIRED_EVENT = 'supabase:session-expired';

/**
 * Supabase answered "Invalid API key": the app's own key is wrong, not the user's session. Told
 * apart from an expired session because both are a 401, but this one hits every endpoint, /auth/v1
 * included, and no sign-in can fix it.
 */
export const INVALID_API_KEY_EVENT = 'supabase:invalid-api-key';

let apiKeyRejected = false;

/**
 * Whether Supabase has already rejected the key during this page load. The rejection can arrive
 * before the auth provider has started listening for the event (the first request is made while
 * the app is still mounting), so the provider asks as well as listens.
 */
export function hasApiKeyBeenRejected(): boolean {
  return apiKeyRejected;
}

async function isInvalidApiKey(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { message?: unknown };
    return typeof body.message === 'string' && /invalid api key/i.test(body.message);
  } catch {
    return false; // not JSON: an ordinary 401 from a function or the Storage API
  }
}

/**
 * A 401 from REST/RPC/Storage/an Edge Function always means the caller's access token was
 * missing/invalid/expired — every Edge Function in this app checks it explicitly and returns
 * 401 for exactly that, and PostgREST itself only returns 401 for a bad JWT, never for an
 * RLS/permission rejection (those come back as 403 or an empty result). `/auth/v1/*` is
 * excluded — AuthContext's onAuthStateChange/getSession already own that lifecycle, and a
 * wrong-password sign-in returns 400, not 401, so there's no overlap to worry about.
 * Dispatched as a window event rather than importing AuthContext directly, to avoid a
 * fetch-layer -> React-context import cycle (supabase-client is a dependency of auth.context,
 * not the other way around).
 */
async function authAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (response.status === 401) {
    if (await isInvalidApiKey(response)) {
      apiKeyRejected = true;
      window.dispatchEvent(new Event(INVALID_API_KEY_EVENT));
    } else if (!url.includes('/auth/v1/')) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
  }
  return response;
}

/**
 * The Data API exposes only the `fitfine` schema (spec/frontend/backend-api.md §1). With it,
 * supabase-js sends `Accept-Profile: fitfine` on reads and `Content-Profile: fitfine` on writes and
 * RPCs; without it every `.from()` / `.rpc()` goes to `public` and fails. Storage and Edge Function
 * calls don't use it.
 */
export const DB_SCHEMA = 'fitfine';

// Before createClient: its session detection clears the tokens from the URL, and with them the only
// sign that this page load is a password-reset link (see recovery-flag.ts).
rememberRecoveryFromUrl();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: DB_SCHEMA },
  global: { fetch: authAwareFetch },
});
