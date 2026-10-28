import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberRepository } from '../repositories/member.repository';

// The service imports the concrete repository/Supabase modules (rather than taking them as
// arguments), so the tests replace those modules. Fakes are typed against the real repository
// so a renamed/removed method is a compile error here.
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  compressImage: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../repositories/member.repository', () => ({
  memberRepository: { create: mocks.create, update: mocks.update } satisfies Partial<MemberRepository>,
}));
vi.mock('../lib/photo-compression', () => ({ compressImage: mocks.compressImage }));
vi.mock('../lib/supabase-client', () => ({
  supabase: { storage: { from: () => ({ upload: mocks.upload, remove: mocks.remove }) } },
}));

import {
  editDraftFromMember,
  isMemberFormValid,
  memberService,
  validateMemberEdit,
  validateNewMember,
  type NewMemberDraft,
} from './member.service';
import { buildMember } from '../test/builders';

const validDraft = (overrides: Partial<NewMemberDraft> = {}): NewMemberDraft => ({
  name: 'Priya Sharma',
  phone: '9876543210',
  date_of_birth: '1995-04-12',
  date_of_joining: '2026-01-15',
  gender: 'Female',
  weight_kg: '60.5',
  height_cm: '165',
  under_doctor_care: false,
  doctor_care_details: '',
  emergency_contact_name: 'Asha Rao',
  emergency_contact_phone: '9123456780',
  emergency_contact_relationship: 'Sister',
  email: '',
  residential_address: '',
  pincode: '',
  aadhaar_number: '',
  occupation: '',
  handled_by_staff: '',
  branch_id: 1,
  ...overrides,
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe('validateNewMember / validateMemberEdit', () => {
  it('accepts a complete draft', () => {
    const errors = validateNewMember(validDraft());
    expect(errors).toEqual({});
    expect(isMemberFormValid(errors)).toBe(true);
  });

  it.each<[string, Partial<NewMemberDraft>, string, string]>([
    ['empty name', { name: '  ' }, 'name', 'Name is required'],
    ['1-char name', { name: 'P' }, 'name', 'Name must be 2-80 characters'],
    ['81-char name', { name: 'x'.repeat(81) }, 'name', 'Name must be 2-80 characters'],
    ['empty phone', { phone: '' }, 'phone', 'Phone is required'],
    ['9-digit phone', { phone: '987654321' }, 'phone', 'Enter a valid 10-digit phone number'],
    ['letters in phone', { phone: '98765abcde' }, 'phone', 'Enter a valid 10-digit phone number'],
    ['missing DOB', { date_of_birth: '' }, 'date_of_birth', 'Date of birth is required'],
    ['missing joining date', { date_of_joining: '' }, 'date_of_joining', 'Date of joining is required'],
    ['no gender', { gender: '' }, 'gender', 'Select a gender'],
    ['empty weight', { weight_kg: '' }, 'weight_kg', 'Weight is required'],
    ['weight below 1', { weight_kg: '0.5' }, 'weight_kg', 'Weight must be between 1 and 500 kg'],
    ['weight above 500', { weight_kg: '501' }, 'weight_kg', 'Weight must be between 1 and 500 kg'],
    ['non-numeric weight', { weight_kg: 'abc' }, 'weight_kg', 'Weight must be between 1 and 500 kg'],
    ['empty height', { height_cm: '' }, 'height_cm', 'Height is required'],
    ['height above 300', { height_cm: '301' }, 'height_cm', 'Height must be between 1.0 and 300.0 cm'],
    ['doctor care without details', { under_doctor_care: true, doctor_care_details: ' ' }, 'doctor_care_details', "Details are required when under doctor's care"],
    ['no emergency name', { emergency_contact_name: '' }, 'emergency_contact_name', 'Emergency contact name is required'],
    ['no emergency phone', { emergency_contact_phone: '' }, 'emergency_contact_phone', 'Emergency contact phone is required'],
    ['bad emergency phone', { emergency_contact_phone: '123' }, 'emergency_contact_phone', 'Enter a valid 10-digit phone number'],
    ['no relationship', { emergency_contact_relationship: '' }, 'emergency_contact_relationship', 'Emergency contact relationship is required'],
    ['bad email', { email: 'not-an-email' }, 'email', 'Enter a valid email address'],
    ['5-digit pincode', { pincode: '12345' }, 'pincode', 'Must be exactly 6 digits'],
    ['11-digit Aadhaar', { aadhaar_number: '12345678901' }, 'aadhaar_number', 'Must be exactly 12 digits'],
    ['81-char emergency name', { emergency_contact_name: 'x'.repeat(81) }, 'emergency_contact_name', 'Name must be at most 80 characters'],
    ['41-char relationship', { emergency_contact_relationship: 'x'.repeat(41) }, 'emergency_contact_relationship', 'Relationship must be at most 40 characters'],
    ['81-char occupation', { occupation: 'x'.repeat(81) }, 'occupation', 'Occupation must be at most 80 characters'],
    ['501-char address', { residential_address: 'x'.repeat(501) }, 'residential_address', 'Address must be at most 500 characters'],
    ['1001-char doctor details', { under_doctor_care: true, doctor_care_details: 'x'.repeat(1001) }, 'doctor_care_details', 'Details must be at most 1000 characters'],
    ['255-char email', { email: `${'x'.repeat(249)}@a.com` }, 'email', 'Enter a valid email address'],
    ['a name of only unsafe characters', { name: '\u200b\u202e' }, 'name', 'Name is required'],
    ['no branch', { branch_id: '' }, 'branch_id', 'Select a branch'],
  ])('rejects %s', (_label, patch, field, message) => {
    expect(validateNewMember(validDraft(patch))).toEqual({ [field]: message });
  });

  it('accepts boundary values: weight 1 and 500, height 1 and 300, a 2-char name', () => {
    expect(validateNewMember(validDraft({ weight_kg: '1', height_cm: '1', name: 'Jo' }))).toEqual({});
    expect(validateNewMember(validDraft({ weight_kg: '500', height_cm: '300' }))).toEqual({});
  });

  it('counts characters as the database does: 80 emoji are 80 characters, not 160', () => {
    expect(validateNewMember(validDraft({ name: '😀'.repeat(80) }))).toEqual({});
  });

  it('accepts a 12-digit Aadhaar, with spaces, and a 500-character address with line breaks', () => {
    expect(validateNewMember(validDraft({ aadhaar_number: '1234 5678 9012', residential_address: `${'x'.repeat(249)}\n${'y'.repeat(250)}` }))).toEqual({});
  });

  it('tolerates spaces inside a phone number and keeps optional fields optional', () => {
    expect(validateNewMember(validDraft({ phone: '98765 43210', email: '', pincode: '' }))).toEqual({});
  });

  it('does not require a branch when editing (branch is immutable after creation)', () => {
    const { branch_id: _branch, ...editDraft } = validDraft();
    expect(validateMemberEdit(editDraft)).toEqual({});
  });
});

describe('editDraftFromMember', () => {
  it('turns numbers into the string form state and nulls into empty strings', () => {
    const draft = editDraftFromMember(buildMember({ weight_kg: 72.5, height_cm: 175, doctor_care_details: null, email: null }));
    expect(draft.weight_kg).toBe('72.5');
    expect(draft.height_cm).toBe('175');
    expect(draft.doctor_care_details).toBe('');
    expect(draft.email).toBe('');
    expect(draft.handled_by_staff).toBe('');
  });
});

describe('memberService.updateMember', () => {
  it('sends trimmed, coerced values and returns the exact payload it sent', async () => {
    mocks.update.mockResolvedValue(undefined);
    const draft = { ...validDraft({ name: '  Priya Sharma ', phone: '98765 43210', weight_kg: '60.5', email: '  ' }) };
    const { branch_id: _branch, ...editDraft } = draft;

    const payload = await memberService.updateMember(7, editDraft);

    expect(mocks.update).toHaveBeenCalledWith(7, payload);
    expect(payload).toMatchObject({
      name: 'Priya Sharma',
      phone: '9876543210',
      weight_kg: 60.5,
      height_cm: 165,
      email: null,
      doctor_care_details: null,
      handled_by_staff: null,
    });
  });

  it('strips control and bidi-override characters, keeps line feeds in the address, and removes Aadhaar spaces', async () => {
    mocks.update.mockResolvedValue(undefined);
    const { branch_id: _branch, ...editDraft } = validDraft({
      name: 'Priya\u202e Sharma\u0000',
      occupation: '\ufeffEngineer',
      residential_address: ' Flat 4\r\nMG Road\u200b ',
      aadhaar_number: '1234 5678 9012',
    });
    const payload = await memberService.updateMember(1, editDraft);
    expect(payload).toMatchObject({
      name: 'Priya Sharma',
      occupation: 'Engineer',
      residential_address: 'Flat 4\nMG Road',
      aadhaar_number: '123456789012',
    });
  });

  it('keeps doctor_care_details only when under doctor care', async () => {
    mocks.update.mockResolvedValue(undefined);
    const { branch_id: _branch, ...editDraft } = validDraft({ under_doctor_care: true, doctor_care_details: ' asthma ' });
    const payload = await memberService.updateMember(1, editDraft);
    expect(payload.doctor_care_details).toBe('asthma');
  });
});

describe('memberService.create', () => {
  const photoFile = () => new File(['x'], 'p.jpg', { type: 'image/jpeg' });

  it('creates the member in one repository call and sends no photo when no file is given', async () => {
    const member = buildMember({ id: 5 });
    mocks.create.mockResolvedValue({ member, photo_error: null });

    await expect(memberService.create(validDraft(), null)).resolves.toEqual({ member, photoError: null });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Priya Sharma', branch_id: 1 }), null);
    expect(mocks.compressImage).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('compresses the thumbnail and sends the original with it, in the same call', async () => {
    const member = buildMember({ id: 5 });
    const thumbnail = new Blob(['t'], { type: 'image/jpeg' });
    const original = photoFile();
    mocks.compressImage.mockResolvedValue(thumbnail);
    mocks.create.mockResolvedValue({ member, photo_error: null });

    await expect(memberService.create(validDraft(), original)).resolves.toEqual({ member, photoError: null });
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), { original, thumbnail });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('keeps the member and reports the photo when the server could not store it (REQ-MEM-004)', async () => {
    const member = buildMember({ id: 5 });
    mocks.compressImage.mockResolvedValue(new Blob(['t']));
    mocks.create.mockResolvedValue({ member, photo_error: 'PHOTO_UPLOAD_FAILED' });

    const result = await memberService.create(validDraft(), photoFile());

    expect(result.member).toBe(member);
    expect(result.photoError).toMatch(/member was saved, but the photo couldn't be uploaded/);
  });

  it('never blocks the member when compression fails: it is created without a photo (REQ-MEM-004)', async () => {
    const member = buildMember({ id: 5 });
    mocks.create.mockResolvedValue({ member, photo_error: null });
    mocks.compressImage.mockRejectedValue(new Error('canvas failed'));

    const result = await memberService.create(validDraft(), photoFile());

    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), null);
    expect(result.member).toBe(member);
    expect(result.photoError).toMatch(/member was saved, but the photo couldn't be uploaded/);
  });

  it.each([
    ['an unsupported type', new File(['x'], 'p.heic', { type: 'image/heic' })],
    ['an empty file', new File([], 'p.jpg', { type: 'image/jpeg' })],
    ['a file over 5 MB', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'p.jpg', { type: 'image/jpeg' })],
  ])('leaves out %s instead of sending a request the server would refuse, and still saves the member', async (_label, file) => {
    const member = buildMember({ id: 5 });
    mocks.create.mockResolvedValue({ member, photo_error: null });

    const result = await memberService.create(validDraft(), file);

    expect(mocks.compressImage).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), null);
    expect(result.photoError).toMatch(/photo couldn't be uploaded/);
  });

  it('propagates a failure to create the member itself', async () => {
    mocks.create.mockRejectedValue(new Error('duplicate'));
    await expect(memberService.create(validDraft(), null)).rejects.toThrow('duplicate');
  });
});

describe('memberService.uploadPhoto', () => {
  const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
  const compressed = new Blob(['y']);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    mocks.compressImage.mockResolvedValue(compressed);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uploads original + thumbnail and stores the bucket-relative PATHS (the bucket is private)', async () => {
    mocks.upload.mockResolvedValue({ error: null });
    mocks.update.mockResolvedValue(undefined);

    await memberService.uploadPhoto(9, file);

    expect(mocks.upload).toHaveBeenCalledWith('9/original-1700000000000.jpg', file, { upsert: true });
    expect(mocks.upload).toHaveBeenCalledWith('9/thumbnail-1700000000000.jpg', compressed, { upsert: true });
    expect(mocks.update).toHaveBeenCalledWith(9, {
      photo_url: '9/original-1700000000000.jpg',
      photo_thumbnail_url: '9/thumbnail-1700000000000.jpg',
    });
  });

  it('cleans up the half that landed when the other upload fails, then throws', async () => {
    const failure = new Error('thumb failed');
    mocks.upload.mockImplementation((path: string) =>
      Promise.resolve({ error: path.includes('thumbnail') ? failure : null })
    );

    await expect(memberService.uploadPhoto(9, file)).rejects.toBe(failure);

    expect(mocks.remove).toHaveBeenCalledWith(['9/original-1700000000000.jpg']);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('removes both blobs when saving their paths on the member fails', async () => {
    mocks.upload.mockResolvedValue({ error: null });
    mocks.update.mockRejectedValue(new Error('rls'));

    await expect(memberService.uploadPhoto(9, file)).rejects.toThrow('rls');
    expect(mocks.remove).toHaveBeenCalledWith(['9/original-1700000000000.jpg', '9/thumbnail-1700000000000.jpg']);
  });
});

describe('memberService.memberFieldForConstraint', () => {
  it('names the form field a members CHECK constraint guards', () => {
    expect(memberService.memberFieldForConstraint('chk_members_aadhaar_number_format')).toBe('aadhaar_number');
    expect(memberService.memberFieldForConstraint('chk_members_emergency_contact_relationship_text')).toBe('emergency_contact_relationship');
  });

  it('is undefined for a constraint with no form field, or none', () => {
    expect(memberService.memberFieldForConstraint('chk_members_photo_url_path')).toBeUndefined();
    expect(memberService.memberFieldForConstraint(undefined)).toBeUndefined();
  });
});
