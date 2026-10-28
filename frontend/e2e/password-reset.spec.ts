import { expect, test } from './fixtures/test';
import { STAFF } from './fixtures/data';
import { buildSession } from './fixtures/supabase-mock';

// Landing from the password-reset email. Supabase verifies the one-time link, then redirects to the
// app's bare origin with the recovery session in the URL hash (implicit flow). The very first visit
// must show the "set a new password" form: the link is single-use, so a second click is "expired".

const recoveryUrl = (path = '/') => {
  const session = buildSession(STAFF);
  const hash = new URLSearchParams({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: String(session.expires_in),
    expires_at: String(session.expires_at),
    token_type: 'bearer',
    type: 'recovery',
  });
  return `${path}#${hash.toString()}`;
};

test.describe('opening the reset link', () => {
  test('lands on the new-password form the first time, not on the login page', async ({ page, supabase }) => {
    supabase.tables.member_list_view = [];
    await page.goto(recoveryUrl());

    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/reset-password');
    await expect(page.getByLabel('Email')).toHaveCount(0); // not the sign-in form
  });

  // Supabase redirects to the project's Site URL when redirectTo isn't allow-listed, and that can be any page.
  for (const path of ['/login', '/reset-password', '/action-center', '/members/1']) {
    test(`lands on the new-password form when the link arrives at ${path}`, async ({ page, supabase }) => {
      supabase.tables.member_list_view = [];
      await page.goto(recoveryUrl(path));
      await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/reset-password');
    });
  }

  test('stays on the form after a refresh of the page that was redirected to', async ({ page, supabase }) => {
    supabase.tables.member_list_view = [];
    await page.goto(recoveryUrl());
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  });

  test('setting the new password signs the user in', async ({ page, supabase }) => {
    supabase.tables.member_list_view = [];
    supabase.tables.action_center_view = [];
    await page.route('**/auth/v1/user', async (route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(buildSession(STAFF).user) });
      }
      return route.fallback();
    });
    await page.goto(recoveryUrl());
    await page.getByLabel('New password', { exact: true }).fill('a-new-password');
    await page.getByLabel('Confirm new password').fill('a-new-password');
    await page.getByRole('button', { name: 'Update password' }).click();

    await expect(page).toHaveURL(/\/(action-center)?$/);
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  });
});

test.describe('a reset link that no longer works', () => {
  test('says so, instead of dropping the user on a bare login form', async ({ page }) => {
    const error = new URLSearchParams({
      error: 'access_denied',
      error_code: 'otp_expired',
      error_description: 'Email link is invalid or has expired',
    });
    await page.goto(`/#${error.toString()}`);

    await expect(page.getByText('Email link is invalid or has expired')).toBeVisible();
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  });
});

test.describe('a project that rejects the app\'s API key', () => {
  // What happened for real: the key in the app's env was rotated or disabled. Supabase's /verify
  // redirect needs no key, so the reset link is accepted (and used up) and the browser arrives with a
  // valid recovery session; then every call the app makes with its own key is refused. That used to
  // look like an expired session and drop the user on the login page with no explanation.
  test('says the key is the problem, instead of silently showing the login page', async ({ page }) => {
    await page.route('**/*.supabase.co/**', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }),
      })
    );
    await page.goto(recoveryUrl());

    await expect(page.getByText(/its Supabase API key is invalid or disabled/)).toBeVisible();
    await expect(page.getByText('Your session has expired')).toHaveCount(0);
  });
});
