import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRecoveryPending,
  isRecoveryPending,
  rememberRecoveryFromUrl,
  setRecoveryPending,
  urlIsRecoveryCallback,
} from './recovery-flag';

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('urlIsRecoveryCallback', () => {
  const at = (hash: string, search = '') => urlIsRecoveryCallback({ hash, search });

  it('recognises the implicit-flow callback Supabase redirects to', () => {
    expect(at('#access_token=a&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery')).toBe(true);
  });

  it('recognises the PKCE and token-hash shapes too', () => {
    expect(at('', '?code=abc&type=recovery')).toBe(true);
    expect(at('', '?token_hash=h&type=recovery')).toBe(true);
  });

  it.each([
    ['an invite link', '#access_token=a&type=invite'],
    ['a plain sign-in', '#access_token=a&type=signup'],
    ['a recovery type with no credentials in it', '#type=recovery'],
    ['a rejected link', '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid'],
    ['an ordinary page', ''],
  ])('ignores %s', (_label, hash) => {
    expect(at(hash)).toBe(false);
  });
});

describe('the recovery flag', () => {
  it('is off by default, on once set, and off again once cleared', () => {
    expect(isRecoveryPending()).toBe(false);
    setRecoveryPending();
    expect(isRecoveryPending()).toBe(true);
    clearRecoveryPending();
    expect(isRecoveryPending()).toBe(false);
  });

  it('expires with the link, after an hour', () => {
    const now = Date.now();
    setRecoveryPending(now);
    expect(isRecoveryPending(now + 59 * 60 * 1000)).toBe(true);
    expect(isRecoveryPending(now + 61 * 60 * 1000)).toBe(false);
    expect(isRecoveryPending(now)).toBe(false); // and the expired value was dropped, not just ignored
  });

  it('ignores a corrupt value', () => {
    window.sessionStorage.setItem('fitfine-password-recovery', 'not-a-number');
    expect(isRecoveryPending()).toBe(false);
  });

  it('is set from the page URL only when it is a recovery callback', () => {
    window.history.replaceState(null, '', '/#access_token=a&type=invite');
    rememberRecoveryFromUrl();
    expect(isRecoveryPending()).toBe(false);

    window.history.replaceState(null, '', '/#access_token=a&refresh_token=r&type=recovery');
    rememberRecoveryFromUrl();
    expect(isRecoveryPending()).toBe(true);
  });

  it('survives blocked storage: nothing throws, the flag is just never remembered', () => {
    const blocked = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => setRecoveryPending()).not.toThrow();
    expect(isRecoveryPending()).toBe(false);
    expect(() => clearRecoveryPending()).not.toThrow();
    blocked.mockRestore();
  });
});
