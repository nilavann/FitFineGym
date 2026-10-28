// What all twelve functions share, checked on each: CORS preflight, POST only, the JWT, the access
// level (one user_access call), and body reading (non-JSON, arrays, 64 KiB, unknown fields). Every
// refusal happens before any data is touched.
import { access, assertEquals, call, dataCalls, loadFunction, world } from './harness.ts';

type Level = 'active' | 'admin' | 'system_admin';
const FUNCTIONS: [name: string, level: Level, validBody: Record<string, unknown>][] = [
  ['create-subscription', 'active', {
    member_id: 1, payment_mode: 'Cash', notes: null,
    items: [{ plan_id: 1, member_id: 1, shared_member_id: null, start_date: '2026-01-01', quantity: 1, amount_paid: null }],
  }],
  ['update-subscription', 'active', { subscription_id: 1 }],
  ['delete-member', 'active', { member_id: 1 }],
  ['delete-plan', 'admin', { plan_id: 1 }],
  ['delete-branch', 'admin', { branch_id: 1 }],
  ['delete-role', 'admin', { role_id: 1 }],
  ['invite-user', 'admin', { email: 'new@example.com', full_name: 'New User', roles: ['staff'] }],
  ['list-users', 'admin', {}],
  ['update-user', 'admin', { user_id: 'a0000000-0000-4000-8000-000000000002', full_name: 'X' }],
  ['purge-member', 'system_admin', { member_id: 1 }],
  ['create-member', 'active', {}],
  ['update-member-number-sequence', 'admin', { branch_id: 1, next_sequence: 1 }],
];
// Functions that read multipart/form-data, not JSON: the access gates below apply to them as they
// are (they all fail before the body is read), the JSON body-shape cases do not (create-member.test.ts).
const MULTIPART = new Set(['create-member']);
const BELOW: Record<Level, 'none' | 'active' | 'admin'> = { active: 'none', admin: 'active', system_admin: 'admin' };

for (const [fn, level, body] of FUNCTIONS) {
  Deno.test(`${fn}: OPTIONS preflight answers with CORS headers`, async () => {
    world.reset();
    const r = await call(await loadFunction(fn), { method: 'OPTIONS' });
    assertEquals(r.status, 200);
    assertEquals(r.headers.get('Access-Control-Allow-Origin'), '*');
  });

  Deno.test(`${fn}: only POST is served (405)`, async () => {
    world.reset();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      assertEquals((await call(await loadFunction(fn), { method })).status, 405, method);
    }
  });

  Deno.test(`${fn}: no Authorization header is 401, nothing touched`, async () => {
    world.reset();
    access(level);
    assertEquals((await call(await loadFunction(fn), { auth: null, body })).status, 401);
    assertEquals(world.log.length, 0);
  });

  Deno.test(`${fn}: an invalid or expired session is 401, nothing touched`, async () => {
    world.reset();
    access(level);
    world.user = null;
    assertEquals((await call(await loadFunction(fn), { body })).status, 401);
    assertEquals(world.log.length, 0);
  });

  Deno.test(`${fn}: a caller below ${level} is 403 after one user_access call, nothing else`, async () => {
    world.reset();
    access(BELOW[level]);
    const r = await call(await loadFunction(fn), { body });
    assertEquals(r.status, 403);
    assertEquals(world.log.map((l) => l.name), ['user_access']);
    assertEquals(world.log[0].args, { p_user_id: 'caller-1' });
  });

  if (!MULTIPART.has(fn)) {
    for (const [label, rawBody, status] of [
      ['a body that is not JSON', '{"member_id": ', 400],
      ['a JSON array', '[1, 2]', 400],
      ['a body over 64 KiB', JSON.stringify({ x: 'a'.repeat(65 * 1024) }), 413],
    ] as const) {
      Deno.test(`${fn}: ${label} is ${status}, no data touched`, async () => {
        world.reset();
        access(level);
        assertEquals((await call(await loadFunction(fn), { rawBody })).status, status);
        assertEquals(dataCalls().length, 0);
      });
    }

    for (const extra of ['deleted_at', 'created_by', '__proto__', 'constructor']) {
      Deno.test(`${fn}: an unknown field (${extra}) is 400, no data touched`, async () => {
        world.reset();
        access(level);
        const rawBody = JSON.stringify(body).replace(/^\{/, `{"${extra}": "x"${Object.keys(body).length ? ',' : ''}`);
        const r = await call(await loadFunction(fn), { rawBody });
        assertEquals(r.status, 400);
        assertEquals(r.json?.error, `${extra} is not a known field`);
        assertEquals(dataCalls().length, 0);
      });
    }
  }

  Deno.test(`${fn}: an unexpected failure is the generic 500, with no database text`, async () => {
    world.reset();
    world.rpc['user_access'] = () => ({ error: { message: 'relation "fitfine.profiles" does not exist', code: '42P01' } });
    const realError = console.error;
    console.error = () => {};
    try {
      const r = await call(await loadFunction(fn), { body });
      assertEquals(r.status, 500);
      assertEquals(r.json?.error, 'Something went wrong — please try again');
    } finally {
      console.error = realError;
    }
  });
}
