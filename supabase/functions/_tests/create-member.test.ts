// create-member through its real handler: the access level, the multipart body, the validation
// that happens before anything is written, the RPC calls, the photo steps, and what comes back.
// The gates every function shares (preflight, POST only, JWT, level) are in gates.test.ts.
import { access, assert, assertEquals, call, dataCalls, loadFunction, world } from './harness.ts';

const member = (extra: Record<string, unknown> = {}) => ({
  name: 'Priya Sharma', phone: '9876543210', date_of_birth: '1995-04-02', date_of_joining: '2026-10-27', gender: 'Female',
  weight_kg: 58.5, height_cm: 162, under_doctor_care: false, doctor_care_details: null,
  emergency_contact_name: 'Ravi Sharma', emergency_contact_phone: '9123456780', emergency_contact_relationship: 'Brother',
  branch_id: 3, email: null, residential_address: null, pincode: null, aadhaar_number: null, occupation: null, handled_by_staff: null,
  ...extra,
});

const image = (type = 'image/jpeg', size = 16) => new File([new Uint8Array(size)], 'p', { type });

function form(o: { member?: unknown | null; original?: File | null; thumbnail?: File | null; extra?: Record<string, string> } = {}) {
  const f = new FormData();
  if (o.member !== null) f.set('member', typeof o.member === 'string' ? o.member : JSON.stringify(o.member ?? member()));
  if (o.original) f.set('original', o.original);
  if (o.thumbnail) f.set('thumbnail', o.thumbnail);
  for (const [k, v] of Object.entries(o.extra ?? {})) f.set(k, v);
  return f;
}

const create = async (formData: FormData) => await call(await loadFunction('create-member'), { formData });
const rpcLog = (name: string) => world.log.filter((l) => l.kind === 'rpc' && l.name === name);
const storageLog = (op: string) => world.log.filter((l) => l.kind === 'storage' && l.name === `member-photos.${op}`);

function setup(o: { create?: () => unknown; setPhoto?: () => unknown; upload?: (path: string) => unknown } = {}) {
  world.reset();
  access('active');
  world.rpc['create_member'] = (o.create as never) ?? (() => ({
    data: {
      ...member(), id: 7, member_number: 'TA-2026-0007', photo_url: null, photo_thumbnail_url: null, created_by: 'caller-1',
      created_at: '2026-10-27T00:00:00Z', changed_by: null, deleted_at: null, deleted_by: null,
    },
  }));
  world.rpc['set_member_photo'] = (o.setPhoto as never) ?? (() => ({ data: null }));
  if (o.upload) world.storageUpload = (_bucket, path) => o.upload!(path) as never;
}

const refuse = (status: string, message: string) => ({ error: { code: `PT${status}`, message } });

// success -------------------------------------------------------------------------------------------

Deno.test('create-member: a member without a photo is one RPC, 201, and no storage call', async () => {
  setup();
  const r = await create(form());
  assertEquals(r.status, 201);
  assertEquals((r.json?.member as { id: number }).id, 7);
  assertEquals(r.json?.photo_error, null);
  assertEquals(rpcLog('create_member')[0].args, { p_caller_id: 'caller-1', p_member: member() });
  assertEquals(storageLog('upload').length + storageLog('remove').length, 0);
  assertEquals(rpcLog('set_member_photo').length, 0);
});

Deno.test('create-member: with a photo the member is saved, both files are stored, and the paths are recorded', async () => {
  setup();
  const r = await create(form({ original: image('image/png', 40), thumbnail: image('image/jpeg', 8) }));
  assertEquals([r.status, r.json?.photo_error], [201, null]);
  const uploads = storageLog('upload').map((l) => l.args as { path: string; type: string });
  assertEquals(uploads.length, 2);
  for (const u of uploads) assert(/^7\/(original|thumbnail)-\d+\.jpg$/.test(u.path), u.path);
  assertEquals(uploads.map((u) => u.type).sort(), ['image/jpeg', 'image/png']);
  const args = rpcLog('set_member_photo')[0].args as Record<string, unknown>;
  assertEquals([args.p_caller_id, args.p_member_id], ['caller-1', 7]);
  const m = r.json?.member as { photo_url: string; photo_thumbnail_url: string };
  assertEquals([m.photo_url, m.photo_thumbnail_url], [args.p_photo_url, args.p_thumbnail_url]);
});

Deno.test('create-member: the response carries the contract only, never audit columns', async () => {
  setup();
  const m = (await create(form())).json?.member as Record<string, unknown>;
  for (const hidden of ['created_at', 'changed_by', 'deleted_at', 'deleted_by']) assert(!(hidden in m), hidden);
  assertEquals([m.member_number, m.created_by], ['TA-2026-0007', 'caller-1']);
});

// the photo never costs the member (REQ-MEM-004) ----------------------------------------------------

Deno.test('create-member: a failed upload is 201 with photo_error, the member kept, no paths recorded', async () => {
  setup({ upload: (path) => (path.includes('/original-') ? { error: { message: 'bucket down' } } : { data: {} }) });
  const realError = console.error;
  console.error = () => {};
  try {
    const r = await create(form({ original: image(), thumbnail: image() }));
    assertEquals([r.status, r.json?.photo_error], [201, 'PHOTO_UPLOAD_FAILED']);
    assertEquals((r.json?.member as { id: number; photo_url: unknown }).id, 7);
    assertEquals((r.json?.member as { photo_url: unknown }).photo_url, null);
    assertEquals(rpcLog('set_member_photo').length, 0);
    assertEquals(storageLog('remove').length, 1, 'the thumbnail that landed is removed');
  } finally {
    console.error = realError;
  }
});

Deno.test('create-member: if the paths can\'t be recorded the files are removed and the member is kept', async () => {
  setup({ setPhoto: () => refuse('404', 'Member 7 not found') });
  const realError = console.error;
  console.error = () => {};
  try {
    const r = await create(form({ original: image(), thumbnail: image() }));
    assertEquals([r.status, r.json?.photo_error], [201, 'PHOTO_UPLOAD_FAILED']);
    assertEquals(storageLog('remove').length, 1);
    assertEquals((storageLog('remove')[0].args as string[]).length, 2);
  } finally {
    console.error = realError;
  }
});

// refusals from the database ------------------------------------------------------------------------

Deno.test('create-member: a phone already in use is 409 MEMBER_PHONE_IN_USE and no photo is stored', async () => {
  setup({ create: () => refuse('409', 'A member with this phone number already exists') });
  const r = await create(form({ original: image(), thumbnail: image() }));
  assertEquals([r.status, r.json], [409, { error: 'A member with this phone number already exists', code: 'MEMBER_PHONE_IN_USE' }]);
  assertEquals(storageLog('upload').length, 0);
});

Deno.test('create-member: a branch or user that does not exist is 400 MEMBER_INVALID_REFERENCE', async () => {
  setup({ create: () => refuse('400', 'branch_id does not reference an active branch') });
  const r = await create(form());
  assertEquals([r.status, r.json?.code], [400, 'MEMBER_INVALID_REFERENCE']);
});

Deno.test('create-member: an unexpected database error is the generic 500', async () => {
  setup({ create: () => ({ error: { code: '23514', message: 'violates check constraint "chk_members_phone_format"' } }) });
  const realError = console.error;
  console.error = () => {};
  try {
    const r = await create(form());
    assertEquals([r.status, r.json], [500, { error: 'Something went wrong — please try again' }]);
  } finally {
    console.error = realError;
  }
});

// the request: refused before anything is written ---------------------------------------------------

async function assertRefused(label: string, f: FormData, status: number, message: RegExp) {
  setup();
  const r = await create(f);
  assertEquals(r.status, status, `${label}: status`);
  assert(message.test(String(r.json?.error)), `${label}: ${r.json?.error}`);
  assertEquals(dataCalls().length, 0, `${label}: nothing written`);
}

Deno.test('create-member: a malformed form is refused before any write', async () => {
  await assertRefused('no member part', form({ member: null }), 400, /^member is required$/);
  await assertRefused('member not JSON', form({ member: '{nope' }), 400, /^member must be a JSON object$/);
  await assertRefused('member an array', form({ member: '[1]' }), 400, /^member must be a JSON object$/);
  await assertRefused('unknown part', form({ extra: { member_number: 'X-1' } }), 400, /^member_number is not a known field$/);
  await assertRefused('original alone', form({ original: image() }), 400, /^original and thumbnail must be sent together$/);
  await assertRefused('thumbnail alone', form({ thumbnail: image() }), 400, /^original and thumbnail must be sent together$/);
});

Deno.test('create-member: a bad member is refused with the field named', async () => {
  await assertRefused('bad phone', form({ member: member({ phone: '12' }) }), 400, /^phone must be exactly 10 digits$/);
  await assertRefused('no details', form({ member: member({ under_doctor_care: true }) }), 400, /^doctor_care_details is required when under_doctor_care is true$/);
  await assertRefused('member_number', form({ member: { ...member(), member_number: 'FAKE-1' } }), 400, /^member_number is not a known field$/);
  await assertRefused('photo path in the body', form({ member: { ...member(), photo_url: '7/original-1.jpg' } }), 400, /^photo_url is not a known field$/);
});

Deno.test('create-member: a photo that is not an acceptable image, or is too large, is refused', async () => {
  await assertRefused('svg', form({ original: image('image/svg+xml'), thumbnail: image() }), 400, /^original must be an image/);
  await assertRefused('html thumbnail', form({ original: image(), thumbnail: image('text/html') }), 400, /^thumbnail must be an image/);
  await assertRefused('empty', form({ original: image('image/jpeg', 0), thumbnail: image() }), 400, /^original must not be empty$/);
  await assertRefused('large original', form({ original: image('image/jpeg', 5 * 1024 * 1024 + 1), thumbnail: image() }), 400, /^original must be at most 5120 KiB$/);
  await assertRefused('large thumbnail', form({ original: image(), thumbnail: image('image/jpeg', 1024 * 1024 + 1) }), 400, /^thumbnail must be at most 1024 KiB$/);
});

Deno.test('create-member: a body over the limit is 413 and a JSON body is 415', async () => {
  await assertRefused('huge', form({ original: image('image/jpeg', 7 * 1024 * 1024), thumbnail: image() }), 413, /^Request body is too large$/);
  setup();
  const r = await call(await loadFunction('create-member'), { body: member() });
  assertEquals([r.status, r.json?.error], [415, 'Request body must be multipart/form-data']);
  assertEquals(dataCalls().length, 0);
});
