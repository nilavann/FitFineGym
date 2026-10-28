import { describe, expect, it } from 'vitest';
import { describeResetEmailFailure, RESET_EMAIL_TIMEOUT } from './reset-email-error';

const apiError = (status: number, code?: string, message = 'x') => Object.assign(new Error(message), { status, code });

describe('describeResetEmailFailure', () => {
  it.each([
    ['a rate limit by code', apiError(429, 'over_email_send_rate_limit'), /Too many reset requests/],
    ['a rate limit by status alone', apiError(429), /Too many reset requests/],
    ['the request rate limit', apiError(429, 'over_request_rate_limit'), /Too many reset requests/],
    ['an address the built-in mail service may not send to', apiError(400, 'email_address_not_authorized'), /isn't set up to send to this address/],
    ['an invalid address', apiError(400, 'email_address_invalid'), /valid email address/],
    ['a rejected API key', apiError(401, undefined, 'Invalid API key'), /Supabase API key is invalid or disabled/],
    ['a 401 whatever its wording', apiError(401, undefined, 'something else'), /Supabase API key is invalid or disabled/],
    ['an API-key message with no status', new Error('Invalid API key'), /Supabase API key is invalid or disabled/],
    ['being offline (Chrome)', new TypeError('Failed to fetch'), /check your connection/],
    ['being offline (Safari)', new TypeError('Load failed'), /check your connection/],
    ['a timeout', new Error(RESET_EMAIL_TIMEOUT), /taking longer than expected/],
    ['a mail-sending failure', apiError(500, 'unexpected_failure', 'Error sending recovery email'), /Couldn't send the reset email/],
    ['anything unrecognised', new Error('boom'), /Couldn't send the reset email/],
    ['a non-error value', undefined, /Couldn't send the reset email/],
  ])('describes %s', (_label, error, expected) => {
    expect(describeResetEmailFailure(error)).toMatch(expected);
  });

  it('never echoes the raw error text (which can carry provider or SMTP internals)', () => {
    expect(describeResetEmailFailure(apiError(500, 'unexpected_failure', 'smtp.example.com: 550 mailbox unavailable'))).not.toMatch(/smtp|550/);
  });

  it('switches on the code, not on the message wording', () => {
    expect(describeResetEmailFailure(apiError(400, 'email_address_not_authorized', 'a different sentence entirely'))).toMatch(
      /isn't set up to send to this address/
    );
  });
});
