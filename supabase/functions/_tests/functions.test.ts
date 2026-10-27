// Each function's own job: its request schema, the call it makes and how it maps the database's
// refusals. The gates every function shares are in gates.test.ts.
import { access, assert, assertEquals, call, dataCalls, loadFunction, queries, rpcCalls, world } from './harness.ts';

const GOOD_ITEM = { plan_id: 1, member_id: 5, shared_member_id: null, start_date: '2026-03-01', quantity: 2, amount_paid: null };
const PLANS = [
  { id: 1, name: 'Monthly', category: 'membership', duration_days: 30, price: 1000, max_members: 1 },
  { id: 2, name: 'Couple', category: 'membership', duration_days: 30, price: 1800, max_members: 2 },
  { id: 3, name: 'Locker', category: 'addon', duration_days: null, price: 200, max_members: 1 },
];
const refuse = (status: string, message: string) => ({ error: { code: `PT${status}`, message } });
const body = (r: { json: Record<string, unknown> | null }) => r.json;

// create-subscription ---------------------------------------------------------------------------

function setupCreate(o: { plans?: unknown[]; members?: number[]; rpc?: () => unknown } = {}) {
  world.reset();
  access('active');
  world.tables['members'] = () => ({ data: (o.members ?? [5, 6]).map((id) => ({ id })) });
  world.tables['plans'] = () => ({ data: o.plans ?? PLANS });
  world.rpc['create_subscription_with_items'] = (o.rpc as never) ?? (() => ({ data: { subscription: { id: 9 }, items: [] } }));
}
const create = async (b: unknown) => await call(await loadFunction('create-subscription'), { body: b });
const checkout = (items: unknown[], extra: Record<string, unknown> = {}) => ({ member_id: 5, payment_mode: 'UPI', notes: ' Paid ', items, ...extra });

Deno.test('create-subscription: computes end_date = start + duration x quantity - 1 and defaults the amount', async () => {
  setupCreate();
  const r = await create(checkout([GOOD_ITEM]));
  assertEquals(r.status, 201);
  assertEquals(r.json, { subscription: { id: 9 }, items: [] });
  const args = rpcCalls('create_subscription_with_items')[0].args as Record<string, unknown>;
  assertEquals(args.p_caller_id, 'caller-1');
  assertEquals(args.p_notes, 'Paid');
  assertEquals(args.p_items, [{
    plan_id: 1, member_id: 5, shared_member_id: null, start_date: '2026-03-01',
    end_date: '2026-04-29', quantity: 2, amount_paid: 2000,
  }]);
});

Deno.test('create-subscription: an indefinite plan has no end_date and quantity 1', async () => {
  setupCreate();
  const r = await create(checkout([GOOD_ITEM, { ...GOOD_ITEM, plan_id: 3, quantity: null }]));
  assertEquals(r.status, 201);
  const items = (rpcCalls('create_subscription_with_items')[0].args as { p_items: Record<string, unknown>[] }).p_items;
  assertEquals([items[1].end_date, items[1].quantity, items[1].amount_paid], [null, 1, 200]);
});

Deno.test('create-subscription: a quantity on an indefinite plan is 400', async () => {
  setupCreate();
  const r = await create(checkout([GOOD_ITEM, { ...GOOD_ITEM, plan_id: 3, quantity: 2 }]));
  assertEquals(r.status, 400);
  assert(String(r.json?.error).includes('indefinite'));
});

Deno.test('create-subscription: a leap-year end date is computed in plain dates', async () => {
  setupCreate();
  await create(checkout([{ ...GOOD_ITEM, start_date: '2028-02-01', quantity: 1 }]));
  const items = (rpcCalls('create_subscription_with_items')[0].args as { p_items: Record<string, unknown>[] }).p_items;
  assertEquals(items[0].end_date, '2028-03-01');
});

Deno.test('create-subscription: an item for another member is 400', async () => {
  setupCreate();
  const r = await create(checkout([{ ...GOOD_ITEM, member_id: 6 }]));
  assertEquals(r.status, 400);
  assertEquals(rpcCalls('create_subscription_with_items').length, 0);
});

Deno.test('create-subscription: a deleted or missing header or shared member is 404', async () => {
  setupCreate({ members: [6] });
  assertEquals((await create(checkout([GOOD_ITEM]))).status, 404);
  setupCreate({ members: [5] });
  assertEquals((await create(checkout([{ ...GOOD_ITEM, plan_id: 2, shared_member_id: 6 }]))).status, 404);
  assertEquals(rpcCalls('create_subscription_with_items').length, 0);
});

Deno.test('create-subscription: the member lookup excludes soft-deleted rows', async () => {
  setupCreate();
  await create(checkout([GOOD_ITEM]));
  const q = queries().find((l) => l.name === 'members')!.q!;
  assert(q.has('is', 'deleted_at', null));
});

Deno.test('create-subscription: a shared member needs a two-member membership plan', async () => {
  setupCreate();
  assertEquals((await create(checkout([{ ...GOOD_ITEM, shared_member_id: 6 }]))).status, 400);
  assertEquals((await create(checkout([{ ...GOOD_ITEM, plan_id: 2, shared_member_id: 5 }]))).status, 400);
  assertEquals((await create(checkout([{ ...GOOD_ITEM, plan_id: 2, shared_member_id: 6 }]))).status, 201);
});

Deno.test('create-subscription: exactly one membership item, and only active plans', async () => {
  setupCreate();
  assertEquals((await create(checkout([{ ...GOOD_ITEM, plan_id: 3, quantity: null }]))).status, 400);
  assertEquals((await create(checkout([GOOD_ITEM, { ...GOOD_ITEM, plan_id: 2 }]))).status, 400);
  setupCreate({ plans: [PLANS[0]] });
  const r = await create(checkout([GOOD_ITEM, { ...GOOD_ITEM, plan_id: 3, quantity: null }]));
  assertEquals(r.status, 400);
  assertEquals(r.json?.error, 'Plan 3 does not exist or is not active');
});

Deno.test('create-subscription: request schema', async () => {
  const bad: [string, unknown][] = [
    ['no items', checkout([])],
    ['more than 20 items', checkout(Array.from({ length: 21 }, () => GOOD_ITEM))],
    ['payment_mode', checkout([GOOD_ITEM], { payment_mode: 'Bitcoin' })],
    ['member_id 0', checkout([GOOD_ITEM], { member_id: 0 })],
    ['member_id as a filter string', checkout([GOOD_ITEM], { member_id: '1,id.gt.0' })],
    ['a date that does not exist', checkout([{ ...GOOD_ITEM, start_date: '2026-02-30' }])],
    ['a negative amount', checkout([{ ...GOOD_ITEM, amount_paid: -1 }])],
    ['quantity 0', checkout([{ ...GOOD_ITEM, quantity: 0 }])],
    ['notes over 200 characters', checkout([GOOD_ITEM], { notes: 'n'.repeat(201) })],
    ['an unknown item field', checkout([{ ...GOOD_ITEM, end_date: '2026-01-01' }])],
  ];
  for (const [label, b] of bad) {
    setupCreate();
    assertEquals((await create(b)).status, 400, label);
    assertEquals(dataCalls().length, 0, `${label}: no data touched`);
  }
});

Deno.test('create-subscription: notes are optional, blank notes are null', async () => {
  setupCreate();
  await create({ member_id: 5, payment_mode: 'Cash', items: [GOOD_ITEM] });
  assertEquals((rpcCalls('create_subscription_with_items')[0].args as Record<string, unknown>).p_notes, null);
  setupCreate();
  await create(checkout([GOOD_ITEM], { notes: '   ' }));
  assertEquals((rpcCalls('create_subscription_with_items')[0].args as Record<string, unknown>).p_notes, null);
});

Deno.test('create-subscription: database refusals map to their status', async () => {
  for (const [status, message] of [['409', 'This member already has an active indefinite item'], ['404', 'Member 5 not found'], ['400', 'Plan 1 is not active']]) {
    setupCreate({ rpc: () => refuse(status, message) });
    const r = await create(checkout([GOOD_ITEM]));
    assertEquals([r.status, r.json?.error], [Number(status), message]);
  }
});

// update-subscription ------------------------------------------------------------------------------

const update = async (b: unknown) => await call(await loadFunction('update-subscription'), { body: b });
function setupUpdate(rpc?: () => unknown) {
  world.reset();
  access('active');
  world.rpc['update_subscription_header'] = (rpc as never) ?? (() => ({ data: { id: 3, payment_mode: 'Card' } }));
}

Deno.test('update-subscription: header fields reach the RPC, and notes_provided tells omitted from null', async () => {
  const args = () => rpcCalls('update_subscription_header').at(-1)!.args as Record<string, unknown>;
  setupUpdate();
  assertEquals((await update({ subscription_id: 3, payment_mode: 'Card' })).json, { id: 3, payment_mode: 'Card' });
  assertEquals([args().p_payment_mode, args().p_notes, args().p_notes_provided], ['Card', null, false]);
  await update({ subscription_id: 3, notes: null });
  assertEquals([args().p_payment_mode, args().p_notes, args().p_notes_provided], [null, null, true]);
  await update({ subscription_id: 3, notes: ' hi ' });
  assertEquals([args().p_notes, args().p_notes_provided], ['hi', true]);
  assertEquals(args().p_caller_id, 'caller-1');
});

Deno.test('update-subscription: request schema and error mapping', async () => {
  for (const b of [{}, { subscription_id: 0 }, { subscription_id: 3, payment_mode: 'Cheque' }, { subscription_id: 3, notes: 'n'.repeat(201) }, { subscription_id: 3, items: [] }]) {
    setupUpdate();
    assertEquals((await update(b)).status, 400, JSON.stringify(b));
    assertEquals(dataCalls().length, 0);
  }
  setupUpdate(() => refuse('404', 'Subscription 3 not found'));
  const r = await update({ subscription_id: 3 });
  assertEquals([r.status, r.json?.error], [404, 'Subscription 3 not found']);
});

// delete-member / plan / branch / role ----------------------------------------------------------------

for (const [fn, field, rpc, level] of [
  ['delete-member', 'member_id', 'soft_delete_member', 'active'],
  ['delete-plan', 'plan_id', 'soft_delete_plan', 'admin'],
  ['delete-branch', 'branch_id', 'soft_delete_branch', 'admin'],
  ['delete-role', 'role_id', 'soft_delete_role', 'admin'],
] as const) {
  const run = async (b: unknown) => await call(await loadFunction(fn), { body: b });

  Deno.test(`${fn}: calls ${rpc} with the caller and the id, and touches no table`, async () => {
    world.reset();
    access(level);
    world.rpc[rpc] = () => ({ data: null });
    const r = await run({ [field]: 7 });
    assertEquals([r.status, r.json], [200, { success: true }]);
    assertEquals(rpcCalls(rpc)[0].args, { p_caller_id: 'caller-1', p_id: 7 });
    assertEquals(queries().length, 0, 'no table query, so nothing is built from the id');
  });

  Deno.test(`${fn}: ${field} must be a positive integer (400, nothing called)`, async () => {
    for (const bad of [undefined, 0, -1, 1.5, '7', '1,id.gt.0', '1)', null, [7]]) {
      world.reset();
      access(level);
      assertEquals((await run(bad === undefined ? {} : { [field]: bad })).status, 400, JSON.stringify(bad));
      assertEquals(rpcCalls(rpc).length, 0);
    }
  });

  Deno.test(`${fn}: 409 in use, 404 missing, 403 reserved keep their message`, async () => {
    for (const [status, message] of [['409', 'Cannot delete — used by 2 things'], ['404', 'Not found'], ['403', 'reserved']]) {
      world.reset();
      access(level);
      world.rpc[rpc] = () => refuse(status, message);
      const r = await run({ [field]: 7 });
      assertEquals([r.status, r.json?.error], [Number(status), message]);
    }
  });
}

Deno.test('delete-member / purge-member: the response carries the member error code for 404 and 409', async () => {
  for (const [fn, rpc, level, field, expected] of [
    ['delete-member', 'soft_delete_member', 'active', 'member_id', { 409: 'MEMBER_IN_USE', 404: 'MEMBER_NOT_FOUND' }],
    ['purge-member', 'purge_member', 'system_admin', 'member_id', { 409: 'MEMBER_IS_SHARED_PARTNER', 404: 'MEMBER_NOT_FOUND' }],
  ] as const) {
    for (const status of [409, 404] as const) {
      world.reset();
      access(level);
      world.rpc[rpc] = () => refuse(String(status), 'm');
      const r = await call(await loadFunction(fn), { body: { [field]: 7 } });
      assertEquals([r.status, r.json], [status, { error: 'm', code: expected[status] }], `${fn} ${status}`);
    }
    world.reset();
    access(level);
    world.rpc[rpc] = () => refuse('403', 'reserved');
    assertEquals((await call(await loadFunction(fn), { body: { [field]: 7 } })).json, { error: 'reserved' }, `${fn} 403 has no code`);
  }
});

// invite-user -------------------------------------------------------------------------------------

const invite = async (b: unknown) => await call(await loadFunction('invite-user'), { body: b });
function setupInvite(level: 'admin' | 'system_admin' = 'admin', roleRows: { id: number; name: string }[] = [{ id: 2, name: 'staff' }]) {
  world.reset();
  access(level);
  world.tables['roles'] = () => ({ data: roleRows });
}
const INVITE = { email: ' New@Example.com ', full_name: ' New  User ', roles: ['staff'] };

Deno.test('invite-user: the roles travel in the invite metadata; no separate role insert', async () => {
  setupInvite();
  const sent: unknown[] = [];
  world.inviteUser = (email, opts) => { sent.push([email, opts]); return { data: { user: { id: 'u-1', email } }, error: null }; };
  const r = await invite(INVITE);
  assertEquals([r.status, r.json], [201, { id: 'u-1', email: 'New@Example.com' }]);
  assertEquals(sent, [['New@Example.com', { data: { full_name: 'New  User', invited_by: 'caller-1', role_ids: [2] } }]]);
  assertEquals(queries().map((q) => q.name), ['roles']);
});

Deno.test('invite-user: roles must exist and be active', async () => {
  setupInvite('admin', []);
  const r = await invite(INVITE);
  assertEquals([r.status, r.json?.error], [400, 'One or more roles do not exist or are not active']);
  assertEquals(world.log.some((l) => l.kind === 'query' && l.q!.has('is', 'deleted_at', null)), true);
});

Deno.test('invite-user: system_admin only from a system admin and only together with admin', async () => {
  const both = [{ id: 1, name: 'admin' }, { id: 3, name: 'system_admin' }];
  setupInvite('admin', both);
  assertEquals((await invite({ ...INVITE, roles: ['admin', 'system_admin'] })).status, 403);
  setupInvite('system_admin', [{ id: 3, name: 'system_admin' }]);
  assertEquals((await invite({ ...INVITE, roles: ['system_admin'] })).status, 400);
  setupInvite('system_admin', both);
  assertEquals((await invite({ ...INVITE, roles: ['admin', 'system_admin'] })).status, 201);
});

Deno.test('invite-user: an email already registered is 409; other invite failures are the generic 500', async () => {
  setupInvite();
  world.inviteUser = () => ({ error: { message: 'A user with this email address has already been registered' } });
  assertEquals((await invite(INVITE)).status, 409);
  setupInvite();
  world.inviteUser = () => ({ error: { message: 'smtp exploded at 10.0.0.1' } });
  const realError = console.error;
  console.error = () => {};
  const r = await invite(INVITE);
  console.error = realError;
  assertEquals([r.status, r.json?.error], [500, 'Something went wrong — please try again']);
});

Deno.test('invite-user: request schema', async () => {
  for (const b of [{}, { ...INVITE, email: 'nope' }, { ...INVITE, full_name: '  ' }, { ...INVITE, full_name: 'n'.repeat(81) }, { ...INVITE, roles: [] }, { ...INVITE, roles: 'staff' }, { ...INVITE, roles: Array(21).fill('staff') }]) {
    setupInvite();
    assertEquals((await invite(b)).status, 400, JSON.stringify(b).slice(0, 60));
    assertEquals(queries().length, 0);
  }
});

// list-users --------------------------------------------------------------------------------------

Deno.test('list-users: joins profiles with emails, sorts by name, hides deleted users unless asked', async () => {
  const profiles = [
    { id: 'u-2', full_name: 'Zed', roles: ['staff'], is_active: true, deleted_at: null },
    { id: 'u-1', full_name: 'Amy', roles: ['admin'], is_active: false, deleted_at: null },
    { id: 'u-3', full_name: 'Noemail', roles: [], is_active: true, deleted_at: null },
  ];
  world.reset();
  access('admin');
  world.tables['profiles_with_roles'] = () => ({ data: profiles });
  world.listUsersPages = [[{ id: 'u-2', email: 'z@x.test' }, { id: 'u-1', email: 'a@x.test' }, { id: 'u-3', email: null }]];
  const r = await call(await loadFunction('list-users'), { body: {} });
  assertEquals((r.json?.users as { email: string }[]).map((u) => u.email), ['a@x.test', 'z@x.test']);
  assert(queries()[0].q!.has('is', 'deleted_at', null));

  world.reset();
  access('admin');
  world.tables['profiles_with_roles'] = () => ({ data: profiles });
  world.listUsersPages = [[]];
  await call(await loadFunction('list-users'), { body: { include_deleted: true } });
  assert(!queries()[0].q!.has('is', 'deleted_at', null));
});

Deno.test('list-users: reads every page of auth users', async () => {
  world.reset();
  access('admin');
  world.tables['profiles_with_roles'] = () => ({
    data: [{ id: 'u-250', full_name: 'Late', roles: [], is_active: true, deleted_at: null }],
  });
  world.listUsersPages = [
    Array.from({ length: 200 }, (_, i) => ({ id: `u-${i}`, email: `${i}@x.test` })),
    Array.from({ length: 60 }, (_, i) => ({ id: `u-${200 + i}`, email: `${200 + i}@x.test` })),
  ];
  const r = await call(await loadFunction('list-users'), { body: {} });
  assertEquals((r.json?.users as unknown[]).length, 1);
});

Deno.test('list-users: include_deleted must be a boolean', async () => {
  world.reset();
  access('admin');
  assertEquals((await call(await loadFunction('list-users'), { body: { include_deleted: 'yes' } })).status, 400);
});

// update-user -------------------------------------------------------------------------------------

const TARGET = 'a0000000-0000-4000-8000-000000000002';
const upd = async (b: unknown) => await call(await loadFunction('update-user'), { body: b });
function setupUpdateUser(o: { roles?: { id: number; name: string }[]; updated?: unknown; errors?: Record<string, ReturnType<typeof refuse>> } = {}) {
  world.reset();
  access('admin', 2);
  world.tables['roles'] = () => ({ data: o.roles ?? [{ id: 2, name: 'staff' }] });
  world.tables['profiles_with_roles'] = () => ({ data: 'updated' in o ? o.updated : { id: TARGET, full_name: 'X', roles: ['staff'], is_active: true } });
  for (const rpc of ['update_profile_fields', 'soft_delete_profile', 'restore_profile', 'replace_user_roles']) {
    world.rpc[rpc] = () => o.errors?.[rpc] ?? { data: null };
  }
}

Deno.test('update-user: name and active flag go to update_profile_fields, and the profile is returned', async () => {
  setupUpdateUser();
  const r = await upd({ user_id: TARGET, full_name: ' Xavier ', is_active: false });
  assertEquals(r.status, 200);
  assertEquals(rpcCalls('update_profile_fields')[0].args, { p_caller_id: 'caller-1', p_target_user_id: TARGET, p_full_name: 'Xavier', p_is_active: false });
  assertEquals(r.json, { id: TARGET, full_name: 'X', roles: ['staff'], is_active: true });
});

Deno.test('update-user: roles go to replace_user_roles as ids', async () => {
  setupUpdateUser();
  await upd({ user_id: TARGET, roles: ['staff'] });
  assertEquals(rpcCalls('replace_user_roles')[0].args, { p_caller_id: 'caller-1', p_target_user_id: TARGET, p_role_ids: [2] });
  assertEquals(rpcCalls('update_profile_fields').length, 0);
});

Deno.test('update-user: delete and restore', async () => {
  setupUpdateUser();
  assertEquals((await upd({ user_id: TARGET, delete: true })).json, { success: true });
  assertEquals(rpcCalls('soft_delete_profile')[0].args, { p_caller_id: 'caller-1', p_target_user_id: TARGET });
  assertEquals((await upd({ user_id: TARGET, restore: true })).json, { success: true });
  assertEquals(rpcCalls('restore_profile').length, 1);
});

Deno.test('update-user: no one changes their own roles, active status or deletes themselves', async () => {
  const self = 'caller-1-uuid';
  world.reset();
  access('admin');
  world.user = { id: 'a0000000-0000-4000-8000-0000000000aa' };
  const me = 'a0000000-0000-4000-8000-0000000000aa';
  assertEquals((await upd({ user_id: me, delete: true })).status, 403);
  assertEquals((await upd({ user_id: me, roles: ['staff'] })).status, 403);
  assertEquals((await upd({ user_id: me, is_active: false })).status, 403);
  assertEquals(dataCalls().length, 0);
  void self;
  setupUpdateUser();
  world.user = { id: me };
  assertEquals((await upd({ user_id: me, full_name: 'Me' })).status, 200);
});

Deno.test('update-user: the last active admin is refused up front, and by the database', async () => {
  world.reset();
  access('admin', 0);
  world.tables['roles'] = () => ({ data: [{ id: 2, name: 'staff' }] });
  // access('admin', 0) answers for the caller and the target alike: the target is an admin with no other admin.
  assertEquals((await upd({ user_id: TARGET, roles: ['staff'] })).json?.error, 'Cannot remove — this is the last active admin.');
  assertEquals((await upd({ user_id: TARGET, is_active: false })).json?.error, 'Cannot deactivate — this is the last active admin.');
  assertEquals(rpcCalls('replace_user_roles').length + rpcCalls('update_profile_fields').length, 0);

  setupUpdateUser({ errors: { soft_delete_profile: refuse('409', 'Cannot delete — this is the last active admin.') } });
  const r = await upd({ user_id: TARGET, delete: true });
  assertEquals([r.status, r.json?.error], [409, 'Cannot delete — this is the last active admin.']);
});

Deno.test('update-user: system_admin rules from the database keep their status', async () => {
  setupUpdateUser({ errors: { replace_user_roles: refuse('403', 'Only a system admin can grant or remove the system_admin role.') } });
  assertEquals((await upd({ user_id: TARGET, roles: ['staff'] })).status, 403);
  setupUpdateUser({ errors: { replace_user_roles: refuse('400', 'The system_admin role can only be held together with admin.') } });
  assertEquals((await upd({ user_id: TARGET, roles: ['staff'] })).status, 400);
});

Deno.test('update-user: unknown roles, nothing to update and a missing user', async () => {
  setupUpdateUser({ roles: [] });
  assertEquals((await upd({ user_id: TARGET, roles: ['ghost'] })).status, 400);
  setupUpdateUser();
  assertEquals((await upd({ user_id: TARGET })).json?.error, 'No fields to update');
  setupUpdateUser({ updated: null });
  assertEquals((await upd({ user_id: TARGET, full_name: 'X' })).status, 404);
});

Deno.test('update-user: request schema', async () => {
  for (const b of [{}, { user_id: 'u' }, { user_id: TARGET, roles: [] }, { user_id: TARGET, full_name: ' ' }, { user_id: TARGET, is_active: 'no' }, { user_id: TARGET, full_name: 'n'.repeat(81) }]) {
    setupUpdateUser();
    assertEquals((await upd(b)).status, 400, JSON.stringify(b).slice(0, 60));
    assertEquals(dataCalls().length, 0);
  }
});

// purge-member --------------------------------------------------------------------------------------

const purge = async (b: unknown) => await call(await loadFunction('purge-member'), { body: b });
function setupPurge(o: { paths?: string[]; listed?: string[]; purge?: () => unknown; removeError?: boolean } = {}) {
  world.reset();
  access('system_admin');
  world.rpc['purge_member'] = (o.purge as never) ?? (() => ({ data: { photo_paths: o.paths ?? ['5/original-1.jpg', '5/thumbnail-1.jpg'], subscriptions: 1, items: 2 } }));
  world.storageList = () => (o.listed ?? []).map((name) => ({ name }));
  if (o.removeError) world.storageRemove = () => ({ error: { message: 'storage down' } });
}
const removed = () => world.log.filter((l) => l.name === 'member-photos.remove').map((l) => l.args);

Deno.test('purge-member: purges, then removes the member\'s photos and everything in their folder', async () => {
  setupPurge({ listed: ['original-0.jpg', 'original-1.jpg'] });
  const r = await purge({ member_id: 5 });
  assertEquals([r.status, r.json], [200, { success: true, photos_removed: true }]);
  assertEquals(rpcCalls('purge_member')[0].args, { p_caller_id: 'caller-1', p_member_id: 5 });
  assertEquals((removed()[0] as string[]).sort(), ['5/original-0.jpg', '5/original-1.jpg', '5/thumbnail-1.jpg']);
});

Deno.test('purge-member: an object outside <member_id>/ is left alone even when purge_member returns it', async () => {
  setupPurge({ paths: ['5/original-1.jpg', '6/original-9.jpg', '../7/original-1.jpg', '50/original-1.jpg', 'x.jpg'] });
  await purge({ member_id: 5 });
  assertEquals(removed(), [['5/original-1.jpg']]);
});

Deno.test('purge-member: a storage failure is reported, never an error response', async () => {
  setupPurge({ removeError: true });
  const realError = console.error;
  console.error = () => {};
  const r = await purge({ member_id: 5 });
  console.error = realError;
  assertEquals([r.status, r.json], [200, { success: true, photos_removed: false }]);
});

Deno.test('purge-member: nothing to remove calls no remove', async () => {
  setupPurge({ paths: [] });
  await purge({ member_id: 5 });
  assertEquals(removed().length, 0);
});

Deno.test('purge-member: 404 missing and 409 shared member keep their message; no storage call', async () => {
  for (const [status, message] of [['404', 'Member 5 not found'], ['409', 'Cannot purge — shared'], ['403', 'System admin access required']]) {
    setupPurge({ purge: () => refuse(status, message) });
    const r = await purge({ member_id: 5 });
    assertEquals([r.status, r.json?.error], [Number(status), message]);
    assertEquals(world.log.filter((l) => l.kind === 'storage').length, 0);
  }
});

Deno.test('purge-member: member_id must be a positive integer', async () => {
  for (const b of [{}, { member_id: 0 }, { member_id: -3 }, { member_id: '5' }, { member_id: 1.5 }, { member_id: null }]) {
    setupPurge();
    assertEquals((await purge(b)).status, 400, JSON.stringify(b));
    assertEquals(rpcCalls('purge_member').length, 0);
  }
});

// update-member-number-sequence ------------------------------------------------------------------------

const seq = async (b: unknown) => await call(await loadFunction('update-member-number-sequence'), { body: b });

Deno.test('update-member-number-sequence: one RPC; the response reports the value applied', async () => {
  world.reset();
  access('admin');
  world.rpc['set_member_number_sequence'] = () => ({ data: { next_sequence: 8, requested: 5, adjusted: true } });
  const r = await seq({ branch_id: 2, next_sequence: 5 });
  assertEquals(r.json, { success: true, next_sequence: 8, requested: 5, adjusted: true });
  assertEquals(rpcCalls('set_member_number_sequence')[0].args, { p_caller_id: 'caller-1', p_branch_id: 2, p_next_sequence: 5 });
  assertEquals(queries().length, 0, 'no LIKE pattern or table read in the function');
});

Deno.test('update-member-number-sequence: request schema and error mapping', async () => {
  for (const b of [{}, { branch_id: 2 }, { branch_id: 2, next_sequence: 0 }, { branch_id: 2, next_sequence: 1.5 }, { branch_id: 2, next_sequence: 2147483648 }, { branch_id: '2', next_sequence: 1 }]) {
    world.reset();
    access('admin');
    assertEquals((await seq(b)).status, 400, JSON.stringify(b));
    assertEquals(rpcCalls('set_member_number_sequence').length, 0);
  }
  for (const [status, message] of [['409', 'Could not find an available member number after 10000 attempts'], ['400', 'branch_id does not reference an active branch']]) {
    world.reset();
    access('admin');
    world.rpc['set_member_number_sequence'] = () => refuse(status, message);
    const r = await seq({ branch_id: 2, next_sequence: 1 });
    assertEquals([r.status, r.json?.error], [Number(status), message]);
  }
});

void body;
