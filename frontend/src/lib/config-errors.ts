/**
 * Shown when Supabase rejects the app's own API key (VITE_SUPABASE_ANON_KEY): it was rotated,
 * disabled, or belongs to another project. Nothing the user types can fix this, and every request
 * fails the same way, so it must not look like an expired session or a wrong password.
 */
export const INVALID_API_KEY_MESSAGE =
  "This app can't reach its database: its Supabase API key is invalid or disabled. Contact the administrator.";
