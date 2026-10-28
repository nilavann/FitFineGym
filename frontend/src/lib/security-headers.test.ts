import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The browser security headers Vercel sends (spec/frontend/backend-api.md §9). `vite preview`
 * doesn't send them, so E2E can't see them: this guards the config, and a Vercel preview is the real check.
 */
const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const all = config.headers.find((h) => h.source === '/(.*)')?.headers ?? [];
const header = (key: string) => all.find((h) => h.key === key)?.value;
const csp = Object.fromEntries(
  (header('Content-Security-Policy') ?? '').split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources])
);

describe('vercel.json security headers', () => {
  it('sends nosniff and a strict referrer policy on every path', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('has a CSP that only reaches the app itself and Supabase', () => {
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['connect-src']).toEqual(["'self'", 'https://*.supabase.co']);
    expect(csp['img-src']).toEqual(["'self'", 'blob:', 'https://*.supabase.co']);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
  });

  it('allows no inline or eval’d script anywhere', () => {
    expect(header('Content-Security-Policy')).not.toMatch(/unsafe-inline|unsafe-eval/);
  });
});
