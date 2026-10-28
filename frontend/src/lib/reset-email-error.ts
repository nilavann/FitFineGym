import { INVALID_API_KEY_MESSAGE } from './config-errors';
import { isNetworkError } from './network-error';

/** Thrown by a caller's own timeout around the request (not by Supabase). */
export const RESET_EMAIL_TIMEOUT = 'reset-email-timeout';

/**
 * What to tell someone whose password-reset email could not be sent.
 *
 * Supabase answers an unknown email exactly like a known one (success), so none of these failures says
 * anything about whether an account exists: they are about the request or the project's email setup.
 * That is why they can be shown, and the old "always say it was sent" was hiding real problems (a
 * rejected API key, the built-in mail service's rate limit and approved-recipients rule, a broken SMTP
 * setup). The success message, by contrast, stays identical for registered and unregistered emails.
 *
 * Switches on the error's `status` / `code` (supabase-js AuthApiError), never on its English message.
 */
export function describeResetEmailFailure(error: unknown): string {
  const { status, code, message } = (error ?? {}) as { status?: number; code?: string; message?: string };

  if (message === RESET_EMAIL_TIMEOUT) return 'This is taking longer than expected. Check your connection and try again.';
  if (isNetworkError(error)) return "Couldn't send the email — check your connection and try again.";

  // A 401 on this request is Supabase refusing the app's own key; nothing the user does can fix it.
  if (status === 401 || /invalid api key/i.test(message ?? '')) return INVALID_API_KEY_MESSAGE;

  if (status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
    return 'Too many reset requests. Please wait a few minutes before trying again.';
  }
  // The built-in mail service only delivers to approved addresses until custom SMTP is configured.
  if (code === 'email_address_not_authorized') {
    return "The email service isn't set up to send to this address yet. Contact your administrator.";
  }
  if (code === 'email_address_invalid') return "That doesn't look like a valid email address.";

  return "Couldn't send the reset email. Please try again, and contact your administrator if it keeps happening.";
}
