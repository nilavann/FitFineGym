import { expect, test } from './fixtures/test';
import { STAFF, memberListRow, memberRow } from './fixtures/data';
import type { MockUser } from './fixtures/supabase-mock';

test.describe('sign in', () => {
  test('wrong credentials show a generic error and keep the user on the form', async ({ page, supabase }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(STAFF.email);
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Never confirms whether the email exists (LoginPage.handleSignIn).
    await expect(page.getByText('Wrong email or password.')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(supabase.calls('/auth/v1/token')).toHaveLength(1);
  });

  test('valid credentials land on the Action Center (the default tab)', async ({ page, supabase }) => {
    supabase.tables.member_list_view = [];

    await page.goto('/login');
    await page.getByLabel('Email').fill(STAFF.email);
    await page.getByLabel('Password', { exact: true }).fill(STAFF.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page).toHaveURL(/\/action-center$/);
    await expect(page.getByRole('heading', { name: 'Action Center' })).toBeVisible();
  });
});

const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

async function signInWith(page: import('@playwright/test').Page, user: MockUser) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.describe('the form', () => {
  test('Sign in stays disabled until both fields are filled', async ({ page }) => {
    await page.goto('/login');
    const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(signIn).toBeDisabled();
    await page.getByLabel('Email').fill(STAFF.email);
    await expect(signIn).toBeDisabled();
    await page.getByLabel('Password', { exact: true }).fill('x');
    await expect(signIn).toBeEnabled();
  });

  test('Forgot password needs an email first, then confirms without revealing whether the account exists', async ({ page, supabase }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByText('Enter your email above first, then click "Forgot password?".')).toBeVisible();
    expect(supabase.calls('/auth/v1/recover')).toHaveLength(0);

    await page.getByLabel('Email').fill('nobody@fitandfine.in'); // not a user: the answer must be the same
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByText('If that email is registered, a reset link has been sent.')).toBeVisible();
    expect(supabase.calls('/auth/v1/recover').map((call) => (call.body as { email: string }).email)).toEqual(['nobody@fitandfine.in']);
  });
});

test.describe('Forgot password when the email cannot be sent', () => {
  const failRecover = (page: import('@playwright/test').Page, status: number, body: object) =>
    page.route('**/auth/v1/recover**', (route) =>
      route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
    );

  test('a rate limit is reported, not hidden behind "link sent", and a retry can still succeed', async ({ page, supabase }) => {
    await failRecover(page, 429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
    await page.goto('/login');
    await page.getByLabel('Email').fill(STAFF.email);
    await page.getByRole('button', { name: 'Forgot password?' }).click();

    await expect(page.getByText('Too many reset requests. Please wait a few minutes before trying again.')).toBeVisible();
    await expect(page.getByText('If that email is registered, a reset link has been sent.')).toHaveCount(0);
    await expect(page.getByLabel('Email')).toHaveValue(STAFF.email);

    await page.unroute('**/auth/v1/recover**');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByText('If that email is registered, a reset link has been sent.')).toBeVisible();
    expect(supabase.calls('/auth/v1/recover').length).toBeGreaterThan(0);
  });

  test('an email service that is not set up for this address says so', async ({ page }) => {
    await failRecover(page, 400, { code: 400, error_code: 'email_address_not_authorized', msg: 'Email address not authorized' });
    await page.goto('/login');
    await page.getByLabel('Email').fill(STAFF.email);
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByText("The email service isn't set up to send to this address yet. Contact your administrator.")).toBeVisible();
  });

  test('a server error while sending gets a retry message and no raw provider text', async ({ page }) => {
    await failRecover(page, 500, { code: 500, error_code: 'unexpected_failure', msg: 'Error sending recovery email: smtp 550' });
    await page.goto('/login');
    await page.getByLabel('Email').fill(STAFF.email);
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByText(/Couldn't send the reset email\. Please try again/)).toBeVisible();
    await expect(page.getByText(/smtp 550/)).toHaveCount(0);
  });
});

test.describe('who is allowed in', () => {
  test('a deactivated account is refused, told why, and its session is not kept', async ({ page, supabase }) => {
    const gone: MockUser = { id: 'u-off', email: 'omar@fitandfine.in', password: 'secret-1' };
    supabase.users.push(gone);
    supabase.tables.profiles_with_roles.push({ id: gone.id, full_name: 'Omar Sheikh', roles: ['staff'], is_active: false });

    await signInWith(page, gone);

    await expect(page.getByText('Your account has been deactivated. Contact an admin.')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => supabase.calls('/auth/v1/logout').length).toBeGreaterThan(0); // never left signed in
  });

  test('an email that was never invited is refused with its own message', async ({ page, supabase }) => {
    const stranger: MockUser = { id: 'u-new', email: 'stranger@example.com', password: 'secret-2' };
    supabase.users.push(stranger); // exists in Auth, but there is no profiles row

    await signInWith(page, stranger);

    await expect(page.getByText("This email hasn't been invited — contact your admin.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a signed-out visitor opening a deep link is sent to sign in', async ({ page }) => {
    await page.goto('/members/2');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});

test.describe('a signed-in session', () => {
  test.beforeEach(async ({ supabase, signedInAs }) => {
    supabase.tables.member_list_view = [memberListRow({ id: 2, name: 'Bharat Rao' })];
    supabase.tables.members = [memberRow({ id: 2, name: 'Bharat Rao' })];
    await signedInAs('staff');
  });

  test('survives a refresh on a deep link (pull-to-refresh, or a link opened from a chat app)', async ({ page }) => {
    await page.goto('/members/2');
    await expect(page.locator('.member-detail-name')).toHaveText('Bharat Rao');

    await page.reload();

    await expect(page).toHaveURL(/\/members\/2$/);
    await expect(page.locator('.member-detail-name')).toHaveText('Bharat Rao');
  });

  test('a dead token mid-session lands on the reassuring signed-out screen, then the sign-in form', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();

    // From now on the server rejects the access token.
    await page.route(/\/rest\/v1\/member_list_view/, (route) =>
      route.fulfill({ status: 401, headers: CORS, body: JSON.stringify({ message: 'JWT expired', code: 'PGRST301' }) })
    );
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' }).click();

    await expect(page.getByRole('heading', { name: "You're signed out" })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0); // a calm screen, not an error banner over the form

    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 6_000 }); // it dismisses itself after ~2.5s
    await expect(page).toHaveURL(/\/login$/);
  });

  test('"Sign in again" skips the wait', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    await page.route(/\/rest\/v1\/member_list_view/, (route) =>
      route.fulfill({ status: 401, headers: CORS, body: JSON.stringify({ message: 'JWT expired', code: 'PGRST301' }) })
    );
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' }).click();
    await expect(page.getByRole('heading', { name: "You're signed out" })).toBeVisible();

    await page.getByRole('button', { name: 'Sign in again' }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});
