/**
 * "This tab arrived from a password-reset email and has not set a new password yet."
 *
 * supabase-js reports a reset link once, as a PASSWORD_RECOVERY event, and then clears the
 * tokens from the URL. Held only in React state that is a single point of failure: if the
 * event fires before the listener exists, or the page is reloaded, the recovery session looks
 * like an ordinary sign-in and the user never sees the new-password form. So the intent is read
 * from the URL while the tokens are still there (supabase-client.ts calls this before it creates
 * the client) and kept in sessionStorage for the tab, until a password is set or the session ends.
 *
 * sessionStorage, not localStorage: a recovery link belongs to the tab it was opened in, and a
 * stale flag must not follow the user into other tabs. It expires with the link itself.
 */
const KEY = 'fitfine-password-recovery';
const MAX_AGE_MS = 60 * 60 * 1000; // a recovery link is valid for an hour

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // blocked storage: fall back to the in-memory event alone
  }
}

/** True when the URL carries a recovery callback (`type=recovery` in the hash or the query). */
export function urlIsRecoveryCallback(location: Pick<Location, 'hash' | 'search'>): boolean {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const fromQuery = new URLSearchParams(location.search);
  const type = fromHash.get('type') ?? fromQuery.get('type');
  const hasCredentials = ['access_token', 'code', 'token_hash'].some((name) => fromHash.has(name) || fromQuery.has(name));
  return type === 'recovery' && hasCredentials;
}

export function setRecoveryPending(now: number = Date.now()): void {
  storage()?.setItem(KEY, String(now));
}

export function clearRecoveryPending(): void {
  storage()?.removeItem(KEY);
}

export function isRecoveryPending(now: number = Date.now()): boolean {
  const raw = storage()?.getItem(KEY);
  if (!raw) return false;
  const since = Number(raw);
  if (!Number.isFinite(since) || now - since > MAX_AGE_MS) {
    clearRecoveryPending();
    return false;
  }
  return true;
}

/** Call once, before supabase-js can clear the URL. */
export function rememberRecoveryFromUrl(): void {
  if (urlIsRecoveryCallback(window.location)) setRecoveryPending();
}
