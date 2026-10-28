// The member entity (_entities/member/) tested without the Edge Function around it: each layer
// against a hand-written fake of the one below, no Supabase client faked at all except where the
// layer itself is the thing that calls it.
import { assert, assertEquals } from './harness.ts';
import type { Client } from '../_shared/clients.ts';
import { ConflictError, NotFoundError } from '../_shared/errors.ts';
import { createMemberRequest, type MemberPhoto, type MemberRow, memberIdRequest } from '../_entities/member/dto.ts';
import { toMemberResponse } from '../_entities/member/mapper.ts';
import { memberPhotoStorage, type MemberPhotoStorage, type PhotoCleanup } from '../_entities/member/photo-storage.ts';
import { type MemberRepository, memberRepository } from '../_entities/member/repository.ts';
import {
  isInPhotoFolder, MAX_PHOTO_BYTES, MAX_THUMBNAIL_BYTES, onlyInPhotoFolder, photoFolder, photoFromFiles, photoPaths, photoProblem,
} from '../_entities/member/rules.ts';
import { createMemberService } from '../_entities/member/service.ts';
import { HttpError } from '../_shared/errors.ts';
import { parseBody } from '../_shared/validate.ts';

// rules ---------------------------------------------------------------------------------------------

Deno.test('photo folder: only paths under "<member_id>/" belong to the member', () => {
  assertEquals(photoFolder(5), '5');
  assert(isInPhotoFolder(5, '5/original-1.jpg'));
  for (const outside of ['50/original-1.jpg', '6/original-1.jpg', '../5/original-1.jpg', '5', '5original.jpg', '']) {
    assert(!isInPhotoFolder(5, outside), outside);
  }
});

Deno.test('onlyInPhotoFolder: keeps the member\'s paths once each', () => {
  assertEquals(onlyInPhotoFolder(5, ['5/a.jpg', '6/b.jpg', '5/a.jpg', '50/c.jpg', '5/d.jpg']), ['5/a.jpg', '5/d.jpg']);
  assertEquals(onlyInPhotoFolder(5, new Set(['5/x.jpg'])), ['5/x.jpg']);
  assertEquals(onlyInPhotoFolder(5, []), []);
});

// dto -----------------------------------------------------------------------------------------------

Deno.test('memberIdRequest: a positive integer member_id and nothing else', () => {
  assertEquals(parseBody(memberIdRequest, { member_id: 7 }), { member_id: 7 });
  for (const bad of [{}, { member_id: 0 }, { member_id: '7' }, { member_id: 7, deleted_at: null }]) {
    try {
      parseBody(memberIdRequest, bad);
      throw new Error(`accepted ${JSON.stringify(bad)}`);
    } catch (e) {
      assert(String(e).includes('HttpError') || (e as { status?: number }).status === 400, String(e));
    }
  }
});

// repository ----------------------------------------------------------------------------------------

type RpcResult = { data?: unknown; error?: { message: string; code?: string } | null };
function fakeClient(handlers: Record<string, (args: Record<string, unknown>) => RpcResult>) {
  const calls: [string, Record<string, unknown>][] = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      return Promise.resolve({ data: null, error: null, ...handlers[name](args) });
    },
  } as unknown as Client;
  return { client, calls };
}

Deno.test('repository.softDelete: calls soft_delete_member with the caller and the id', async () => {
  const { client, calls } = fakeClient({ soft_delete_member: () => ({}) });
  await memberRepository(client).softDelete('caller-1', 7);
  assertEquals(calls, [['soft_delete_member', { p_caller_id: 'caller-1', p_id: 7 }]]);
});

Deno.test('repository.softDelete: 409 is MEMBER_IN_USE, 404 is MEMBER_NOT_FOUND, 403 has no code', async () => {
  for (const [pt, Err, code] of [['PT409', ConflictError, 'MEMBER_IN_USE'], ['PT404', NotFoundError, 'MEMBER_NOT_FOUND'], ['PT403', undefined, undefined]] as const) {
    const { client } = fakeClient({ soft_delete_member: () => ({ error: { code: pt, message: 'm' } }) });
    try {
      await memberRepository(client).softDelete('c', 7);
      throw new Error('not thrown');
    } catch (e) {
      assertEquals((e as { code?: string }).code, code);
      if (Err) assert(e instanceof Err, String(e));
    }
  }
});

Deno.test('repository.purge: 409 is MEMBER_IS_SHARED_PARTNER; a missing result is read as empty, not as a crash', async () => {
  const shared = fakeClient({ purge_member: () => ({ error: { code: 'PT409', message: 'shared' } }) });
  try {
    await memberRepository(shared.client).purge('c', 7);
    throw new Error('not thrown');
  } catch (e) {
    assertEquals((e as { code?: string }).code, 'MEMBER_IS_SHARED_PARTNER');
  }
  const empty = fakeClient({ purge_member: () => ({ data: null }) });
  assertEquals(await memberRepository(empty.client).purge('c', 7), { photo_paths: [], subscriptions: 0, items: 0 });
  const full = fakeClient({ purge_member: () => ({ data: { photo_paths: ['7/a.jpg'], subscriptions: 2, items: 3 } }) });
  assertEquals(await memberRepository(full.client).purge('c', 7), { photo_paths: ['7/a.jpg'], subscriptions: 2, items: 3 });
});

// photo storage -------------------------------------------------------------------------------------

function fakeBucket(opts: { files?: string[]; listError?: boolean; removeError?: boolean } = {}) {
  const removed: string[][] = [];
  const client = {
    storage: {
      from: (_bucket: string) => ({
        list: (_folder: string, { limit, offset }: { limit: number; offset: number }) =>
          Promise.resolve(opts.listError
            ? { data: null, error: { message: 'list down' } }
            : { data: (opts.files ?? []).slice(offset, offset + limit).map((name) => ({ name })), error: null }),
        remove: (paths: string[]) => {
          removed.push(paths);
          return Promise.resolve({ data: null, error: opts.removeError ? { message: 'remove down' } : null });
        },
      }),
    },
  } as unknown as Client;
  return { storage: memberPhotoStorage(client), removed };
}

Deno.test('photo storage: removes the known paths and everything listed, across list pages', async () => {
  const files = Array.from({ length: 103 }, (_, i) => `original-${i}.jpg`);
  const { storage, removed } = fakeBucket({ files });
  const r = await storage.removeAll(5, ['5/thumbnail-1.jpg', '6/other.jpg']);
  assertEquals(r.removed, true);
  assertEquals(removed.length, 1);
  assertEquals(removed[0].length, 104, '103 listed + the known thumbnail; the other member\'s path is dropped');
  assert(removed[0].every((p) => p.startsWith('5/')));
});

Deno.test('photo storage: nothing to remove calls no remove', async () => {
  const { storage, removed } = fakeBucket();
  assertEquals((await storage.removeAll(5, [])).removed, true);
  assertEquals(removed.length, 0);
});

Deno.test('photo storage: a list or remove failure is returned, never thrown', async () => {
  for (const o of [{ listError: true }, { removeError: true, files: ['a.jpg'] }]) {
    const { storage } = fakeBucket(o);
    const r = await storage.removeAll(5, ['5/known.jpg']);
    assertEquals(r.removed, false);
    assert(r.error !== undefined);
    assert(r.paths.includes('5/known.jpg'), 'the paths found so far are reported');
  }
});

// service -------------------------------------------------------------------------------------------

function fakeDeps(o: { purge?: () => Promise<{ photo_paths: string[]; subscriptions: number; items: number }>; cleanup?: PhotoCleanup } = {}) {
  const calls: string[] = [];
  const logged: unknown[][] = [];
  const repo: MemberRepository = {
    create: () => Promise.reject(new Error('create is not faked here')),
    setPhoto: () => Promise.reject(new Error('setPhoto is not faked here')),
    softDelete: (c, id) => { calls.push(`softDelete ${c} ${id}`); return Promise.resolve(); },
    purge: o.purge ?? ((() => { calls.push('purge'); return Promise.resolve({ photo_paths: ['5/a.jpg'], subscriptions: 1, items: 1 }); })),
  };
  const photos: MemberPhotoStorage = {
    upload: () => Promise.reject(new Error('upload is not faked here')),
    remove: () => Promise.reject(new Error('remove is not faked here')),
    removeAll: (id, known) => { calls.push(`removeAll ${id} ${known.join(',')}`); return Promise.resolve(o.cleanup ?? { removed: true, paths: known }); },
  };
  return { service: createMemberService({ repo, photos, log: (...a) => logged.push(a) }), calls, logged };
}

Deno.test('service.softDelete: delegates to the repository and answers { success: true }', async () => {
  const { service, calls } = fakeDeps();
  assertEquals(await service.softDelete('caller-1', 7), { success: true });
  assertEquals(calls, ['softDelete caller-1 7']);
});

Deno.test('service.purge: removes the photos after the rows, passing the RPC\'s paths', async () => {
  const { service, calls, logged } = fakeDeps();
  assertEquals(await service.purge('c', 5), { success: true, photos_removed: true });
  assertEquals(calls, ['purge', 'removeAll 5 5/a.jpg']);
  assertEquals(logged.length, 0);
});

Deno.test('service.purge: a photo failure is logged and reported, not an error', async () => {
  const { service, logged } = fakeDeps({ cleanup: { removed: false, paths: ['5/a.jpg'], error: new Error('storage down') } });
  assertEquals(await service.purge('c', 5), { success: true, photos_removed: false });
  assertEquals(logged.length, 1);
  assertEquals(logged[0].slice(0, 3), ['purge-member: member', 5, 'erased but photos were not (fully) removed:']);
});

Deno.test('service.purge: when the purge is refused, no photo is touched', async () => {
  const { service, calls } = fakeDeps({ purge: () => Promise.reject(new ConflictError('shared', 'MEMBER_IS_SHARED_PARTNER')) });
  try {
    await service.purge('c', 5);
    throw new Error('not thrown');
  } catch (e) {
    assert(e instanceof ConflictError);
  }
  assertEquals(calls.length, 0);
});

// create: schema ------------------------------------------------------------------------------------

const validMember = (extra: Record<string, unknown> = {}) => ({
  name: 'Priya Sharma', phone: '9876543210', date_of_birth: '1995-04-02', date_of_joining: '2026-10-27', gender: 'Female',
  weight_kg: 58.5, height_cm: 162, under_doctor_care: false, doctor_care_details: null,
  emergency_contact_name: 'Ravi Sharma', emergency_contact_phone: '9123456780', emergency_contact_relationship: 'Brother',
  branch_id: 3, email: null, residential_address: null, pincode: null, aadhaar_number: null, occupation: null, handled_by_staff: null,
  ...extra,
});
const refused = (body: unknown): string | null => {
  try {
    parseBody(createMemberRequest, body);
    return null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 400) return e.message;
    throw e;
  }
};

Deno.test('createMemberRequest: a complete member parses; optional fields may be left out', () => {
  assertEquals(parseBody(createMemberRequest, validMember()).name, 'Priya Sharma');
  const minimal: Record<string, unknown> = validMember();
  for (const k of ['doctor_care_details', 'email', 'residential_address', 'pincode', 'aadhaar_number', 'occupation', 'handled_by_staff']) delete minimal[k];
  assertEquals(refused(minimal), null);
});

Deno.test('createMemberRequest: normalizes text and blank optional text', () => {
  const m = parseBody(createMemberRequest, validMember({ name: '  Priya  ', occupation: '   ', residential_address: ' 12 MG Road\nPune ' }));
  assertEquals([m.name, m.occupation, m.residential_address], ['Priya', null, '12 MG Road\nPune']);
});

Deno.test('createMemberRequest: every constraint-mirroring failure is a 400 naming the field', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ name: '   ' }, /^name must not be blank/],
    [{ name: 'a'.repeat(81) }, /^name must be at most 80/],
    [{ phone: '98765' }, /^phone must be exactly 10 digits/],
    [{ phone: '98765 43210' }, /^phone must be exactly 10 digits/],
    [{ emergency_contact_phone: 'abc' }, /^emergency_contact_phone must be exactly 10 digits/],
    [{ emergency_contact_relationship: 'x'.repeat(41) }, /^emergency_contact_relationship must be at most 40/],
    [{ date_of_birth: '2026-02-30' }, /^date_of_birth must be a real calendar date/],
    [{ date_of_joining: 'today' }, /^date_of_joining must be a date/],
    [{ gender: 'male' }, /^gender must be one of Male, Female, Other/],
    [{ weight_kg: 0 }, /^weight_kg must be a number from 1 to 500/],
    [{ weight_kg: '58' }, /^weight_kg must be a number from 1 to 500/],
    [{ height_cm: 301 }, /^height_cm must be a number from 1 to 300/],
    [{ under_doctor_care: 'no' }, /^under_doctor_care must be true or false/],
    [{ branch_id: 0 }, /^branch_id must be a positive integer id/],
    [{ branch_id: '3' }, /^branch_id must be a positive integer id/],
    [{ email: 'not-an-email' }, /^email must be an email address/],
    [{ pincode: '4110' }, /^pincode must be exactly 6 digits/],
    [{ aadhaar_number: '1234' }, /^aadhaar_number must be exactly 12 digits/],
    [{ handled_by_staff: 'someone' }, /^handled_by_staff must be a UUID/],
    [{ doctor_care_details: 'x'.repeat(1001), under_doctor_care: true }, /^doctor_care_details must be at most 1000/],
    [{ residential_address: 'x'.repeat(501) }, /^residential_address must be at most 500/],
  ];
  for (const [extra, message] of cases) {
    const got = refused(validMember(extra));
    assert(got !== null && message.test(got), `${JSON.stringify(extra)} -> ${got}`);
  }
});

Deno.test('createMemberRequest: doctor care details are required, non-blank, when under doctor care', () => {
  const left_out: Record<string, unknown> = validMember({ under_doctor_care: true });
  delete left_out.doctor_care_details;
  assertEquals(refused(left_out), 'doctor_care_details is required when under_doctor_care is true');
  for (const details of [null, '', '   ']) {
    assertEquals(refused(validMember({ under_doctor_care: true, doctor_care_details: details })), 'doctor_care_details is required when under_doctor_care is true');
  }
  assertEquals(refused(validMember({ under_doctor_care: true, doctor_care_details: 'Asthma' })), null);
  assertEquals(refused(validMember({ under_doctor_care: false, doctor_care_details: null })), null);
});

Deno.test('createMemberRequest: a required field left out, or a field the database sets, is a 400', () => {
  const missing: Record<string, unknown> = validMember();
  delete missing.phone;
  assertEquals(refused(missing), 'phone is required');
  for (const field of ['member_number', 'created_by', 'deleted_at', 'photo_url', 'photo_thumbnail_url', 'id', '__proto__']) {
    assertEquals(refused(JSON.parse(JSON.stringify(validMember()).replace(/^\{/, `{"${field}": "x",`))), `${field} is not a known field`, field);
  }
});

// create: rules -------------------------------------------------------------------------------------

Deno.test('photoPaths: built from the member id and timestamp, in the member\'s folder, in the shape the database requires', () => {
  const p = photoPaths(42, 1700000000000);
  assertEquals(p, { original: '42/original-1700000000000.jpg', thumbnail: '42/thumbnail-1700000000000.jpg' });
  assert(/^[1-9][0-9]*\/(original|thumbnail)-[0-9]+\.jpg$/.test(p.original) && /^[1-9][0-9]*\/(original|thumbnail)-[0-9]+\.jpg$/.test(p.thumbnail));
});

const file = (type: string, size: number) => new File([new Uint8Array(size)], 'p', { type });

Deno.test('photoProblem: image types only, not empty, within the limit', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) assertEquals(photoProblem(file(type, 10), MAX_PHOTO_BYTES), null, type);
  for (const type of ['image/svg+xml', 'image/gif', 'text/html', 'application/pdf', '']) {
    assert(photoProblem(file(type, 10), MAX_PHOTO_BYTES)?.startsWith('must be an image'), type);
  }
  assertEquals(photoProblem(file('image/jpeg', 0), MAX_PHOTO_BYTES), 'must not be empty');
  assertEquals(photoProblem(file('image/jpeg', MAX_PHOTO_BYTES), MAX_PHOTO_BYTES), null);
  assertEquals(photoProblem(file('image/jpeg', MAX_PHOTO_BYTES + 1), MAX_PHOTO_BYTES), 'must be at most 5120 KiB');
  assertEquals(photoProblem(file('image/jpeg', MAX_THUMBNAIL_BYTES + 1), MAX_THUMBNAIL_BYTES), 'must be at most 1024 KiB');
});

Deno.test('photoFromFiles: both parts or neither', () => {
  const original = file('image/jpeg', 5), thumbnail = file('image/jpeg', 2);
  assertEquals(photoFromFiles({}), null);
  assert(photoFromFiles({ original, thumbnail })?.original === original);
  for (const lone of [{ original }, { thumbnail }] as Record<string, File>[]) {
    try {
      photoFromFiles(lone);
      throw new Error('accepted');
    } catch (e) {
      assert(String(e).includes('both photo parts or neither'), String(e));
    }
  }
});

// create: mapper ------------------------------------------------------------------------------------

const memberRow = (extra: Record<string, unknown> = {}): MemberRow => ({
  ...validMember(), id: 7, member_number: 'TA-2026-0007', photo_url: null, photo_thumbnail_url: null, created_by: 'u1',
  email: null, residential_address: null, pincode: null, aadhaar_number: null, occupation: null, doctor_care_details: null, handled_by_staff: null,
  // What to_jsonb(members) carries besides the contract: none of it may reach the client.
  created_at: '2026-10-27T00:00:00Z', changed_at: null, changed_by: null, deleted_at: null, deleted_by: null, internal_note: 'x',
  ...extra,
}) as unknown as MemberRow;

Deno.test('toMemberResponse: only the contract\'s fields; audit and unknown columns stay on the server', () => {
  const r = toMemberResponse(memberRow());
  for (const hidden of ['created_at', 'changed_at', 'changed_by', 'deleted_at', 'deleted_by', 'internal_note']) {
    assert(!(hidden in r), hidden);
  }
  assertEquals([r.id, r.member_number, r.created_by, r.name], [7, 'TA-2026-0007', 'u1', 'Priya Sharma']);
});

Deno.test('toMemberResponse: a photo stored after the row was read is reflected', () => {
  const r = toMemberResponse(memberRow(), { original: '7/original-1.jpg', thumbnail: '7/thumbnail-1.jpg' });
  assertEquals([r.photo_url, r.photo_thumbnail_url], ['7/original-1.jpg', '7/thumbnail-1.jpg']);
});

// create: repository --------------------------------------------------------------------------------

Deno.test('repository.create: calls create_member with the caller and the member, returns the row', async () => {
  const { client, calls } = fakeClient({ create_member: () => ({ data: memberRow() }) });
  const input = parseBody(createMemberRequest, validMember());
  const row = await memberRepository(client).create('caller-1', input);
  assertEquals(calls, [['create_member', { p_caller_id: 'caller-1', p_member: input }]]);
  assertEquals(row.id, 7);
});

Deno.test('repository.create: 409 is MEMBER_PHONE_IN_USE, 400 is MEMBER_INVALID_REFERENCE, 403 has no code', async () => {
  const input = parseBody(createMemberRequest, validMember());
  for (const [pt, code] of [['PT409', 'MEMBER_PHONE_IN_USE'], ['PT400', 'MEMBER_INVALID_REFERENCE'], ['PT403', undefined]] as const) {
    const { client } = fakeClient({ create_member: () => ({ error: { code: pt, message: 'm' } }) });
    try {
      await memberRepository(client).create('c', input);
      throw new Error('not thrown');
    } catch (e) {
      assertEquals((e as { code?: string }).code, code, pt);
    }
  }
});

Deno.test('repository.create: a result that is not a member row is an unexpected error, not a crash later', async () => {
  const input = parseBody(createMemberRequest, validMember());
  for (const data of [null, {}, { id: '7' }, [1]]) {
    const { client } = fakeClient({ create_member: () => ({ data }) });
    try {
      await memberRepository(client).create('c', input);
      throw new Error('accepted');
    } catch (e) {
      assert(String(e).includes('create_member returned no member row'), String(e));
    }
  }
});

Deno.test('repository.setPhoto: calls set_member_photo with both paths', async () => {
  const { client, calls } = fakeClient({ set_member_photo: () => ({}) });
  await memberRepository(client).setPhoto('caller-1', 7, { original: '7/original-1.jpg', thumbnail: '7/thumbnail-1.jpg' });
  assertEquals(calls, [['set_member_photo', { p_caller_id: 'caller-1', p_member_id: 7, p_photo_url: '7/original-1.jpg', p_thumbnail_url: '7/thumbnail-1.jpg' }]]);
});

// create: photo storage -----------------------------------------------------------------------------

function uploadBucket(o: { failOn?: 'original' | 'thumbnail'; removeError?: boolean } = {}) {
  const uploads: { path: string; type: string }[] = [];
  const removed: string[][] = [];
  const client = {
    storage: {
      from: (_bucket: string) => ({
        upload: (path: string, f: File) => {
          uploads.push({ path, type: f.type });
          const fails = o.failOn !== undefined && path.includes(`/${o.failOn}-`);
          return Promise.resolve({ data: null, error: fails ? { message: `${o.failOn} down` } : null });
        },
        remove: (paths: string[]) => {
          removed.push(paths);
          return Promise.resolve({ data: null, error: o.removeError ? { message: 'remove down' } : null });
        },
      }),
    },
  } as unknown as Client;
  return { storage: memberPhotoStorage(client, () => 1700000000000), uploads, removed };
}
const photo = (): MemberPhoto => ({ original: file('image/png', 9), thumbnail: file('image/jpeg', 3) });

Deno.test('photo storage upload: stores both at server-built paths with their own content types', async () => {
  const { storage, uploads } = uploadBucket();
  const paths = await storage.upload(7, photo());
  assertEquals(paths, { original: '7/original-1700000000000.jpg', thumbnail: '7/thumbnail-1700000000000.jpg' });
  assertEquals(uploads.map((u) => [u.path, u.type]).sort(), [
    ['7/original-1700000000000.jpg', 'image/png'], ['7/thumbnail-1700000000000.jpg', 'image/jpeg'],
  ]);
});

Deno.test('photo storage upload: when one side fails the other is removed and the error is thrown', async () => {
  for (const failOn of ['original', 'thumbnail'] as const) {
    const { storage, removed } = uploadBucket({ failOn });
    try {
      await storage.upload(7, photo());
      throw new Error('not thrown');
    } catch (e) {
      assertEquals((e as { message: string }).message, `${failOn} down`);
    }
    const other = failOn === 'original' ? 'thumbnail' : 'original';
    assertEquals(removed, [[`7/${other}-1700000000000.jpg`]], failOn);
  }
});

Deno.test('photo storage upload: a failed cleanup does not hide the upload error', async () => {
  const { storage } = uploadBucket({ failOn: 'thumbnail', removeError: true });
  try {
    await storage.upload(7, photo());
    throw new Error('not thrown');
  } catch (e) {
    assertEquals((e as { message: string }).message, 'thumbnail down');
  }
});

// create: service -----------------------------------------------------------------------------------

function createDeps(o: { upload?: 'ok' | 'fail'; setPhoto?: 'ok' | 'fail' } = {}) {
  const calls: string[] = [];
  const logged: unknown[][] = [];
  const paths = { original: '7/original-1.jpg', thumbnail: '7/thumbnail-1.jpg' };
  const repo: MemberRepository = {
    create: () => { calls.push('create'); return Promise.resolve(memberRow()); },
    setPhoto: () => { calls.push('setPhoto'); return o.setPhoto === 'fail' ? Promise.reject(new Error('db down')) : Promise.resolve(); },
    softDelete: () => Promise.reject(new Error('unused')),
    purge: () => Promise.reject(new Error('unused')),
  };
  const photos: MemberPhotoStorage = {
    upload: () => { calls.push('upload'); return o.upload === 'fail' ? Promise.reject(new Error('storage down')) : Promise.resolve(paths); },
    remove: (p) => { calls.push(`remove ${p.join(',')}`); return Promise.resolve(); },
    removeAll: () => Promise.reject(new Error('unused')),
  };
  return { service: createMemberService({ repo, photos, log: (...a) => logged.push(a) }), calls, logged };
}
const input = () => parseBody(createMemberRequest, validMember());

Deno.test('service.create without a photo: registers the member and touches no storage', async () => {
  const { service, calls } = createDeps();
  const r = await service.create('caller-1', input(), null);
  assertEquals(calls, ['create']);
  assertEquals([r.photo_error, r.member.id, r.member.photo_url], [null, 7, null]);
});

Deno.test('service.create with a photo: registers, uploads, then stores the paths on the member', async () => {
  const { service, calls, logged } = createDeps();
  const r = await service.create('caller-1', input(), photo());
  assertEquals(calls, ['create', 'upload', 'setPhoto']);
  assertEquals([r.photo_error, r.member.photo_url, r.member.photo_thumbnail_url], [null, '7/original-1.jpg', '7/thumbnail-1.jpg']);
  assertEquals(logged.length, 0);
});

Deno.test('service.create: an upload failure keeps the member, reports photo_error and stores no paths (REQ-MEM-004)', async () => {
  const { service, calls, logged } = createDeps({ upload: 'fail' });
  const r = await service.create('caller-1', input(), photo());
  assertEquals(calls, ['create', 'upload']);
  assertEquals([r.photo_error, r.member.id, r.member.photo_url], ['PHOTO_UPLOAD_FAILED', 7, null]);
  assertEquals(logged.length, 1);
});

Deno.test('service.create: when storing the paths fails the uploaded files are removed and the member is kept', async () => {
  const { service, calls } = createDeps({ setPhoto: 'fail' });
  const r = await service.create('caller-1', input(), photo());
  assertEquals(calls, ['create', 'upload', 'setPhoto', 'remove 7/original-1.jpg,7/thumbnail-1.jpg']);
  assertEquals([r.photo_error, r.member.photo_url], ['PHOTO_UPLOAD_FAILED', null]);
});

Deno.test('service.create: when the member is refused nothing is uploaded and the refusal propagates', async () => {
  const calls: string[] = [];
  const service = createMemberService({
    repo: {
      create: () => Promise.reject(new ConflictError('phone in use', 'MEMBER_PHONE_IN_USE')),
      setPhoto: () => Promise.reject(new Error('unused')), softDelete: () => Promise.reject(new Error('unused')), purge: () => Promise.reject(new Error('unused')),
    },
    photos: { upload: () => { calls.push('upload'); return Promise.reject(new Error('unused')); }, remove: () => Promise.reject(new Error('unused')), removeAll: () => Promise.reject(new Error('unused')) },
  });
  try {
    await service.create('caller-1', input(), photo());
    throw new Error('not thrown');
  } catch (e) {
    assert(e instanceof ConflictError && e.code === 'MEMBER_PHONE_IN_USE', String(e));
  }
  assertEquals(calls.length, 0);
});
