// The two Supabase clients. Both talk to the `fitfine`
// schema, the only one the Data API exposes. Neither keeps a session: every call is one request.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// No generated Database type: the RPC and table shapes are checked by the SQL tests and by the
// request schemas, not by the client.
// deno-lint-ignore no-explicit-any
export type Client = SupabaseClient<any, 'fitfine', any>;

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const options = {
  db: { schema: 'fitfine' },
  auth: { persistSession: false, autoRefreshToken: false },
};

/** Service role: bypasses RLS. Writes only through the fitfine Edge Function RPCs. */
export function serviceClient(): Client {
  // deno-lint-ignore no-explicit-any
  return createClient<any, 'fitfine', any>(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), options);
}

/** The caller's own JWT, used only to verify it (auth.getUser). */
export function callerClient(authorization: string): Client {
  // deno-lint-ignore no-explicit-any
  return createClient<any, 'fitfine', any>(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    ...options,
    global: { headers: { Authorization: authorization } },
  });
}
