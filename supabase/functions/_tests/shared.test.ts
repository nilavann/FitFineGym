// The shared module (_shared/): body reading, the error handler, rpcError, every validate.ts rule
// and requireCaller per level. Special characters are built from code points, so no invisible
// character sits in this file.
import { requireCaller } from '../_shared/auth.ts';
import { callerClient, serviceClient } from '../_shared/clients.ts';
import { GENERIC_ERROR, handle, HttpError, MAX_BODY_BYTES, readBytes, readJsonObject, readMultipart, rpcError } from '../_shared/http.ts';
import * as v from '../_shared/validate.ts';
import { access, assert, assertEquals, world } from './harness.ts';

const cp = (...points: number[]) => String.fromCodePoint(...points);
const ZWNJ = cp(0x200c), ZWJ = cp(0x200d);

Deno.env.set('SUPABASE_URL', 'http://localhost:54321');
Deno.env.set('SUPABASE_ANON_KEY', 'anon');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');

function post(body: string | undefined, headers: Record<string, string> = {}) {
  return new Request('http://localhost/fn', { method: 'POST', body, headers });
}

/** The 400 message a rule throws for `value`, or null when it accepts it. */
function refusal(rule: v.Rule<unknown>, value: unknown, path = 'f'): string | null {
  try {
    rule.parse(value, path);
    return null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 400) return e.message;
    throw e;
  }
}

// http.ts: body reading ---------------------------------------------------------------------------

Deno.test('readJsonObject: an empty body is {}', async () => {
  assertEquals(await readJsonObject(post(undefined)), {});
  assertEquals(await readJsonObject(post('  ')), {});
});
Deno.test('readJsonObject: a JSON object is returned as is', async () => {
  assertEquals(await readJsonObject(post('{"a":1,"b":[2]}')), { a: 1, b: [2] });
});
for (const [label, body] of [['not JSON', '{nope'], ['a JSON array', '[1,2]'], ['a JSON string', '"x"'], ['JSON null', 'null'], ['a number', '5']]) {
  Deno.test(`readJsonObject: ${label} is 400`, async () => {
    try {
      await readJsonObject(post(body));
      throw new Error('accepted');
    } catch (e) {
      assert(e instanceof HttpError && e.status === 400, String(e));
    }
  });
}
Deno.test('readJsonObject: a body over 64 KiB is 413, a body of exactly 64 KiB is read', async () => {
  const big = JSON.stringify({ x: 'a'.repeat(65 * 1024) });
  try {
    await readJsonObject(post(big));
    throw new Error('accepted');
  } catch (e) {
    assert(e instanceof HttpError && e.status === 413, String(e));
  }
  const exact = JSON.stringify({ x: '' }).length;
  const fits = JSON.stringify({ x: 'a'.repeat(MAX_BODY_BYTES - exact) });
  assertEquals(fits.length, MAX_BODY_BYTES);
  assertEquals((await readJsonObject(post(fits))).x !== undefined, true);
});
Deno.test('readJsonObject: a declared Content-Length over 64 KiB is 413 before reading', async () => {
  try {
    await readJsonObject(post('{}', { 'Content-Length': String(MAX_BODY_BYTES + 1) }));
    throw new Error('accepted');
  } catch (e) {
    assert(e instanceof HttpError && e.status === 413, String(e));
  }
});

// http.ts: readBytes and readMultipart -----------------------------------------------------------

Deno.test('readBytes: returns the body, and refuses one over the limit with a 413', async () => {
  assertEquals(new TextDecoder().decode(await readBytes(post('hello'), 10)), 'hello');
  try {
    await readBytes(post('x'.repeat(11)), 10);
    throw new Error('accepted');
  } catch (e) {
    assert(e instanceof HttpError && e.status === 413, String(e));
  }
});

const SHAPE = { maxBytes: 1024, fields: ['member'], files: ['original', 'thumbnail'] } as const;
const multipartRequest = (form: FormData, headers: Record<string, string> = {}) =>
  new Request('http://localhost/fn', { method: 'POST', body: form, headers });
const multipartStatus = async (req: Request): Promise<[number, string] | null> => {
  try {
    await readMultipart(req, SHAPE);
    return null;
  } catch (e) {
    if (e instanceof HttpError) return [e.status, e.message];
    throw e;
  }
};

Deno.test('readMultipart: splits text parts from file parts', async () => {
  const form = new FormData();
  form.set('member', '{"a":1}');
  form.set('original', new File(['abc'], 'p.jpg', { type: 'image/jpeg' }));
  const { fields, files } = await readMultipart(multipartRequest(form), SHAPE);
  assertEquals(fields, { member: '{"a":1}' });
  assertEquals(Object.keys(files), ['original']);
  assertEquals([files.original.type, files.original.size], ['image/jpeg', 3]);
});

Deno.test('readMultipart: a body that is not multipart/form-data is 415', async () => {
  assertEquals(await multipartStatus(post('{}', { 'Content-Type': 'application/json' })), [415, 'Request body must be multipart/form-data']);
  assertEquals(await multipartStatus(post('x')), [415, 'Request body must be multipart/form-data']);
});

Deno.test('readMultipart: an unknown part, a repeated part and a text/file mix-up are 400', async () => {
  const unknown = new FormData();
  unknown.set('member_number', 'X');
  assertEquals(await multipartStatus(multipartRequest(unknown)), [400, 'member_number is not a known field']);

  const twice = new FormData();
  twice.append('member', 'a');
  twice.append('member', 'b');
  assertEquals(await multipartStatus(multipartRequest(twice)), [400, 'member must appear only once']);

  const fileForText = new FormData();
  fileForText.set('member', new File(['{}'], 'm.json'));
  assertEquals(await multipartStatus(multipartRequest(fileForText)), [400, 'member must be text']);

  const textForFile = new FormData();
  textForFile.set('original', 'not a file');
  assertEquals(await multipartStatus(multipartRequest(textForFile)), [400, 'original must be a file']);
});

Deno.test('readMultipart: a body over the limit is 413; malformed multipart is 400', async () => {
  const big = new FormData();
  big.set('original', new File(['x'.repeat(2000)], 'p.jpg', { type: 'image/jpeg' }));
  assertEquals(await multipartStatus(multipartRequest(big)), [413, 'Request body is too large']);
  const bad = new Request('http://localhost/fn', { method: 'POST', body: 'not a form', headers: { 'Content-Type': 'multipart/form-data; boundary=zz' } });
  assertEquals((await multipartStatus(bad))?.[0], 400);
});

// http.ts: the handler ----------------------------------------------------------------------------

Deno.test('handle: an expected error keeps its message and status', async () => {
  for (const status of [400, 401, 403, 404, 409, 413]) {
    const res = await handle('t', () => Promise.reject(new HttpError(status, `msg ${status}`)))(post('{}'));
    assertEquals(res.status, status);
    assertEquals(await res.json(), { error: `msg ${status}` });
  }
});
Deno.test('handle: an unexpected error is logged in full and answered with the generic 500', async () => {
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const res = await handle('t', () => Promise.reject(new Error('relation "fitfine.members" violates constraint x')))(post('{}'));
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { error: GENERIC_ERROR });
  } finally {
    console.error = realError;
  }
  assertEquals(logged.length, 1);
  assert(String(logged[0][1]).includes('fitfine.members'), 'the real error is logged');
});
Deno.test('handle: OPTIONS is the CORS preflight, anything but POST is 405', async () => {
  const fn = handle('t', () => Promise.resolve(new Response('ran')));
  const pre = await fn(new Request('http://localhost/fn', { method: 'OPTIONS' }));
  assertEquals(pre.status, 200);
  assertEquals(pre.headers.get('Access-Control-Allow-Origin'), '*');
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    assertEquals((await fn(new Request('http://localhost/fn', { method }))).status, 405, method);
  }
});

Deno.test('rpcError: PT400/403/404/409 become that status with the database message', () => {
  for (const status of [400, 403, 404, 409]) {
    try {
      rpcError({ code: `PT${status}`, message: `refused ${status}` });
      throw new Error('not thrown');
    } catch (e) {
      assert(e instanceof HttpError && e.status === status && e.message === `refused ${status}`, String(e));
    }
  }
});
Deno.test('rpcError: any other error is rethrown as unexpected; no error is a no-op', () => {
  rpcError(null);
  for (const code of ['23514', 'P0001', 'PT500', '42501', undefined]) {
    try {
      rpcError({ code, message: 'boom' });
      throw new Error('not thrown');
    } catch (e) {
      assert(!(e instanceof HttpError), `${code} must not be an expected error`);
    }
  }
});

// validate.ts -------------------------------------------------------------------------------------

Deno.test('text: trims, rejects blank and non-strings, enforces the length in characters', () => {
  const name = v.text({ max: 5 });
  assertEquals(name.parse('  Asha  ', 'f'), 'Asha');
  assert(refusal(name, '   ')?.includes('must not be blank'));
  assert(refusal(name, 5)?.includes('must be a string'));
  assert(refusal(name, null)?.includes('must be a string'));
  assert(refusal(name, 'abcdef')?.includes('at most 5 characters'));
  // Five characters, more than five UTF-16 units: counted as Postgres counts them.
  assertEquals(name.parse(cp(0x1f600).repeat(5), 'f'), cp(0x1f600).repeat(5));
});

Deno.test('text: strips the database-rejected characters, keeping ZWNJ and ZWJ', () => {
  const name = v.text({ max: 80 });
  for (const point of [0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff]) {
    assertEquals(name.parse(`a${cp(point)}b`, 'f'), 'ab', `U+${point.toString(16)}`);
  }
  const hindi = cp(0x915, 0x94d) + ZWJ + cp(0x937);
  const malayalam = cp(0xd38, 0xd4d) + ZWJ + cp(0xd28) + ZWNJ + cp(0xd2e);
  assertEquals(name.parse(hindi, 'f'), hindi);
  assertEquals(name.parse(malayalam, 'f'), malayalam);
  assertEquals(name.parse('a' + String.fromCharCode(0xd800) + 'b', 'f'), 'ab', 'a lone surrogate');
});

Deno.test('text: no escaping, markup and quotes are kept as typed', () => {
  assertEquals(v.text({ max: 80 }).parse(`<script>alert("x")</script> O'Brien`, 'f'), `<script>alert("x")</script> O'Brien`);
});

Deno.test('text (multiline): keeps line feeds, strips carriage returns and tabs', () => {
  const notes = v.text({ max: 200, multiline: true });
  assertEquals(notes.parse('line one\r\nline two\tend', 'f'), 'line one\nline twoend');
});

Deno.test('textOrNull: null and blank become null', () => {
  const notes = v.textOrNull({ max: 200, multiline: true });
  assertEquals(notes.parse(null, 'f'), null);
  assertEquals(notes.parse('  ' + cp(0x200b) + ' ', 'f'), null);
  assertEquals(notes.parse(' paid ', 'f'), 'paid');
  assert(refusal(notes, 'x'.repeat(201))?.includes('at most 200'));
});

Deno.test('id, integer, amount', () => {
  const memberId = v.id();
  assertEquals(memberId.parse(7, 'f'), 7);
  for (const bad of [0, -1, 1.5, '7', null, true, Number.MAX_SAFE_INTEGER + 2, '1,id.gt.0', '1)']) {
    assert(refusal(memberId, bad) !== null, `id ${JSON.stringify(bad)}`);
  }
  assert(refusal(v.id({ max: 32767 }), 32768) !== null);
  const qty = v.integer({ min: 1, max: 1000 });
  assertEquals(qty.parse(1000, 'f'), 1000);
  assert(refusal(qty, 1001) !== null && refusal(qty, 0) !== null);
  const money = v.amount();
  assertEquals(money.parse(1499.5, 'f'), 1499.5);
  assertEquals(money.parse(0, 'f'), 0);
  for (const bad of [-1, 1.234, Infinity, NaN, '10', 100_000_000]) assert(refusal(money, bad) !== null, `amount ${bad}`);
});

Deno.test('uuid, date, boolean, oneOf, email', () => {
  assertEquals(v.uuid().parse('A0000000-0000-4000-8000-000000000001', 'f'), 'A0000000-0000-4000-8000-000000000001');
  for (const bad of ['u', '', 'a0000000-0000-4000-8000-00000000000g', 1]) assert(refusal(v.uuid(), bad) !== null);
  assertEquals(v.date().parse('2026-02-28', 'f'), '2026-02-28');
  for (const bad of ['2026-02-30', '2026-2-1', '01/02/2026', '2026-02-28T00:00:00Z', 20260228]) assert(refusal(v.date(), bad) !== null, String(bad));
  assertEquals(v.boolean().parse(false, 'f'), false);
  assert(refusal(v.boolean(), 'true') !== null && refusal(v.boolean(), 0) !== null);
  const mode = v.oneOf(['Cash', 'UPI', 'Card'] as const);
  assertEquals(mode.parse('UPI', 'f'), 'UPI');
  assert(refusal(mode, 'cash') !== null && refusal(mode, 'Bitcoin') !== null);
  assertEquals(v.email().parse(' asha@example.com ', 'f'), 'asha@example.com');
  for (const bad of ['asha', 'a@b', 'a b@c.d', '@c.d', 'a'.repeat(250) + '@c.de']) assert(refusal(v.email(), bad) !== null, bad);
});

Deno.test('array: element rules, minimum and maximum length', () => {
  const ids = v.array(v.id(), { min: 1, max: 3 });
  assertEquals(ids.parse([1, 2, 3], 'f'), [1, 2, 3]);
  assert(refusal(ids, [])?.includes('at least 1'));
  assert(refusal(ids, [1, 2, 3, 4])?.includes('at most 3'));
  assert(refusal(ids, [1, 'x'])?.startsWith('f[1] '));
  assert(refusal(ids, { 0: 1 })?.includes('must be an array'));
});

Deno.test('object: required, optional, nullable fields; the result is the normalized value', () => {
  const schema = v.object({ a: v.id(), b: v.optional(v.text({ max: 5 })), c: v.optional(v.nullable(v.id())) });
  assertEquals(schema.parse({ a: 1 }, ''), { a: 1 });
  assertEquals(schema.parse({ a: 1, b: ' x ', c: null }, ''), { a: 1, b: 'x', c: null });
  assertEquals(refusal(schema, { b: 'x' }, ''), 'a is required');
  assertEquals(refusal(schema, { a: 1, c: 'x' }, ''), 'c must be a positive integer id');
});

Deno.test('object: unknown fields are rejected, including deleted_at, __proto__ and constructor', () => {
  const schema = v.object({ member_id: v.id() });
  assertEquals(refusal(schema, { member_id: 1, deleted_at: '2026-01-01' }, ''), 'deleted_at is not a known field');
  assertEquals(refusal(schema, JSON.parse('{"member_id": 1, "__proto__": {"admin": true}}'), ''), '__proto__ is not a known field');
  assertEquals(refusal(schema, JSON.parse('{"member_id": 1, "constructor": {"prototype": {}}}'), ''), 'constructor is not a known field');
  assertEquals(refusal(schema, JSON.parse('{"member_id": 1, "toString": 1}'), ''), 'toString is not a known field');
  // A field the schema knows is looked up on the object itself, never on its prototype.
  const inherited = Object.create({ member_id: 5 });
  assertEquals(refusal(schema, inherited, ''), 'member_id is required');
  assertEquals(({} as Record<string, unknown>).admin, undefined, 'nothing was polluted');
});

Deno.test('object: nested paths name the failing field', () => {
  const schema = v.object({ items: v.array(v.object({ plan_id: v.id() }), { max: 5 }) });
  assertEquals(refusal(schema, { items: [{ plan_id: 1 }, { plan_id: 0 }] }, ''), 'items[1].plan_id must be a positive integer id');
  assertEquals(refusal(schema, { items: [{ plan_id: 1, x: 1 }] }, ''), 'items[0].x is not a known field');
});

// clients.ts and auth.ts ---------------------------------------------------------------------------

Deno.test('clients: both clients use the fitfine schema and keep no session', () => {
  world.reset();
  serviceClient();
  callerClient('Bearer t');
  assertEquals(world.clients.length, 2);
  for (const c of world.clients) {
    const options = c.options as { db: { schema: string }; auth: { persistSession: boolean } };
    assertEquals(options.db.schema, 'fitfine');
    assertEquals(options.auth.persistSession, false);
  }
  assertEquals(world.clients.map((c) => c.key), ['service', 'anon']);
});

async function callerAt(level: 'active' | 'admin', headers: Record<string, string> = { Authorization: 'Bearer t' }) {
  try {
    return await requireCaller(new Request('http://localhost/fn', { method: 'POST', headers }), level, serviceClient());
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

Deno.test('requireCaller: 401 without a header or with an invalid session, before any query', async () => {
  world.reset();
  access('admin');
  assertEquals(await callerAt('active', {}), 401);
  world.user = null;
  assertEquals(await callerAt('active'), 401);
  assertEquals(world.log.length, 0);
});

Deno.test('requireCaller: one user_access call decides each level', async () => {
  const table: [string, 'active' | 'admin', number | 'ok'][] = [
    ['none', 'active', 403], ['active', 'active', 'ok'], ['active', 'admin', 403], ['admin', 'admin', 'ok'],
    ['none', 'admin', 403],
  ];
  for (const [who, level, want] of table) {
    world.reset();
    access(who as 'none');
    const got = await callerAt(level);
    assertEquals(typeof got === 'number' ? got : 'ok', want, `${who} at ${level}`);
    assertEquals(world.log.length, 1);
    assertEquals(world.log[0].args, { p_user_id: 'caller-1' });
  }
});

Deno.test('requireCaller: returns the caller with their access', async () => {
  world.reset();
  access('admin', 2);
  assertEquals(await callerAt('admin'), { id: 'caller-1', isActive: true, isAdmin: true, otherActiveAdmins: 2 });
});

Deno.test('digits: exactly that many ASCII digits, no normalizing', () => {
  const phone = v.digits(10);
  assertEquals(phone.parse('9876543210', 'f'), '9876543210');
  for (const bad of ['987654321', '98765432100', '98765 43210', ' 9876543210', '98765a3210', '٩٨٧٦٥٤٣٢١٠', 9876543210, null]) {
    assert(refusal(phone, bad)?.includes('must be exactly 10 digits'), String(bad));
  }
});

Deno.test('decimal: a finite number within the range, any decimals', () => {
  const weight = v.decimal({ min: 1, max: 500 });
  for (const ok of [1, 500, 58.25, 72.123456]) assertEquals(weight.parse(ok, 'f'), ok);
  for (const bad of [0.99, 500.01, NaN, Infinity, '58', null, undefined]) {
    assert(refusal(weight, bad)?.includes('must be a number from 1 to 500'), String(bad));
  }
});

Deno.test('refine: runs after the object parses and names the offending field under the path', () => {
  const rule = v.refine(
    v.object({ on: v.boolean(), why: v.optional(v.textOrNull({ max: 10 })) }),
    (m) => (m.on && !m.why ? { field: 'why', reason: 'is required when on is true' } : null),
  );
  assertEquals(rule.parse({ on: false }, ''), { on: false });
  assertEquals(rule.parse({ on: true, why: 'x' }, ''), { on: true, why: 'x' });
  assertEquals(refusal(rule, { on: true }, ''), 'why is required when on is true');
  assertEquals(refusal(rule, { on: true, why: '  ' }, 'member'), 'member.why is required when on is true');
  assertEquals(refusal(rule, { on: 'yes' }, ''), 'on must be true or false', 'the object rule fails first');
});
