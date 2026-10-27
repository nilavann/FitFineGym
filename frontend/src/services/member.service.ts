import { memberRepository } from '../repositories/member.repository';
import { compressImage } from '../lib/photo-compression';
import { supabase } from '../lib/supabase-client';
import { charLength, cleanText, TEXT_LIMITS } from '../lib/text-rules';
import { constraintField } from '../lib/db-error';
import type { Gender, Member, NewMember, NewMemberPhoto, UpdateMember } from '../types/member';

/**
 * Fields shared by both the Add Member form and Member Detail's inline edit form — every
 * Member field except branch_id (create-only, immutable after — REQ-MEM-006).
 * handled_by_staff is shared too (settable at creation, defaulting to the logged-in staff
 * member — AddMemberPage seeds it via useAuth() — and independently editable afterward from
 * Member Detail, same field either way — REQ-MEM-003).
 */
interface MemberFieldsDraft {
  name: string;
  phone: string;
  date_of_birth: string;
  date_of_joining: string;
  gender: Gender | '';
  /** Raw text while editing (e.g. "72." mid-entry) — masked to at most 2 decimals, parsed on validate/submit. */
  weight_kg: string;
  height_cm: string;
  under_doctor_care: boolean;
  doctor_care_details: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_relationship: string;
  email: string;
  residential_address: string;
  /** 6-digit Indian postal code, optional — see spec/frontend/member-management.md §2. */
  pincode: string;
  aadhaar_number: string;
  occupation: string;
  /** Profile id, or '' for "not set" — see member-detail.md §12. */
  handled_by_staff: string;
}

/**
 * The Add Member form's working state — looser than NewMember (numeric/enum fields can be
 * '' while unselected/unfilled) so the form can hold an incomplete draft. Converted to a
 * real NewMember only after validation passes. See spec/frontend/member-management.md §2.
 */
export interface NewMemberDraft extends MemberFieldsDraft {
  branch_id: number | '';
}

/** Member Detail's inline-edit form state (member-detail.md §7/§12) — same fields as NewMemberDraft, minus branch_id (immutable after creation). */
export type MemberEditDraft = MemberFieldsDraft;

export type MemberFormErrors = Partial<Record<keyof NewMemberDraft, string>>;
export type MemberEditFormErrors = Partial<Record<keyof MemberEditDraft, string>>;

const PHONE_REGEX = /^\d{10}$/;
/** Every form field, keyed for memberFieldForConstraint (only the keys are used). */
const MEMBER_FIELDS: Record<keyof MemberFieldsDraft, true> = {
  name: true, phone: true, date_of_birth: true, date_of_joining: true, gender: true, weight_kg: true, height_cm: true,
  under_doctor_care: true, doctor_care_details: true, emergency_contact_name: true, emergency_contact_phone: true,
  emergency_contact_relationship: true, email: true, residential_address: true, pincode: true, aadhaar_number: true,
  occupation: true, handled_by_staff: true,
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PINCODE_REGEX = /^\d{6}$/;
const AADHAAR_REGEX = /^\d{12}$/;

const stripSpaces = (value: string) => value.trim().replace(/\s+/g, '');
const tooLong = (value: string, max: number) => charLength(value) > max;

/**
 * Shared by validateNewMember/validateMemberEdit — the `fitfine.members` CHECK constraints are the
 * authoritative copy (spec/frontend/backend-api-changes.md §5). Lengths are counted on the cleaned
 * value, in code points, exactly as the database will see it.
 */
function validateMemberFields(form: MemberFieldsDraft): Partial<Record<keyof MemberFieldsDraft, string>> {
  const errors: Partial<Record<keyof MemberFieldsDraft, string>> = {};

  const name = cleanText(form.name);
  if (!name) errors.name = 'Name is required';
  else if (charLength(name) < 2 || tooLong(name, TEXT_LIMITS.name)) errors.name = 'Name must be 2-80 characters';

  const phone = form.phone.trim().replace(/\s+/g, '');
  if (!phone) errors.phone = 'Phone is required';
  else if (!PHONE_REGEX.test(phone)) errors.phone = 'Enter a valid 10-digit phone number';

  if (!form.date_of_birth) errors.date_of_birth = 'Date of birth is required';
  if (!form.date_of_joining) errors.date_of_joining = 'Date of joining is required';
  if (form.gender === '') errors.gender = 'Select a gender';

  if (form.weight_kg.trim() === '') {
    errors.weight_kg = 'Weight is required';
  } else {
    const weightKg = Number(form.weight_kg);
    if (Number.isNaN(weightKg) || weightKg < 1 || weightKg > 500) {
      errors.weight_kg = 'Weight must be between 1 and 500 kg';
    }
  }
  if (form.height_cm.trim() === '') {
    errors.height_cm = 'Height is required';
  } else {
    const heightCm = Number(form.height_cm);
    if (Number.isNaN(heightCm) || heightCm < 1 || heightCm > 300) {
      errors.height_cm = 'Height must be between 1.0 and 300.0 cm';
    }
  }

  if (form.under_doctor_care) {
    const details = cleanText(form.doctor_care_details, true);
    if (!details) errors.doctor_care_details = "Details are required when under doctor's care";
    else if (tooLong(details, TEXT_LIMITS.doctorCareDetails)) errors.doctor_care_details = 'Details must be at most 1000 characters';
  }

  const emergencyName = cleanText(form.emergency_contact_name);
  if (!emergencyName) errors.emergency_contact_name = 'Emergency contact name is required';
  else if (tooLong(emergencyName, TEXT_LIMITS.name)) errors.emergency_contact_name = 'Name must be at most 80 characters';

  const emergencyPhone = form.emergency_contact_phone.trim().replace(/\s+/g, '');
  if (!emergencyPhone) errors.emergency_contact_phone = 'Emergency contact phone is required';
  else if (!PHONE_REGEX.test(emergencyPhone)) errors.emergency_contact_phone = 'Enter a valid 10-digit phone number';

  const relationship = cleanText(form.emergency_contact_relationship);
  if (!relationship) errors.emergency_contact_relationship = 'Emergency contact relationship is required';
  else if (tooLong(relationship, TEXT_LIMITS.relationship)) errors.emergency_contact_relationship = 'Relationship must be at most 40 characters';

  const email = form.email.trim();
  if (email && (!EMAIL_REGEX.test(email) || tooLong(email, TEXT_LIMITS.email))) {
    errors.email = 'Enter a valid email address';
  }

  if (form.pincode.trim() && !PINCODE_REGEX.test(form.pincode.trim())) {
    errors.pincode = 'Must be exactly 6 digits';
  }

  const aadhaar = stripSpaces(form.aadhaar_number);
  if (aadhaar && !AADHAAR_REGEX.test(aadhaar)) errors.aadhaar_number = 'Must be exactly 12 digits';

  if (tooLong(cleanText(form.occupation), TEXT_LIMITS.name)) errors.occupation = 'Occupation must be at most 80 characters';
  if (tooLong(cleanText(form.residential_address, true), TEXT_LIMITS.address)) {
    errors.residential_address = 'Address must be at most 500 characters';
  }

  return errors;
}

export function validateNewMember(form: NewMemberDraft): MemberFormErrors {
  const errors: MemberFormErrors = validateMemberFields(form);
  if (form.branch_id === '') errors.branch_id = 'Select a branch';
  return errors;
}

export function validateMemberEdit(form: MemberEditDraft): MemberEditFormErrors {
  return validateMemberFields(form);
}

/**
 * The form field a `fitfine.members` CHECK constraint guards (`chk_members_aadhaar_number_format` ->
 * `aadhaar_number`), so a 23514 that still arrives shows as that field's error rather than raw text.
 */
export function memberFieldForConstraint(constraint: string | undefined): keyof MemberFieldsDraft | undefined {
  return constraintField(constraint, 'members', Object.keys(MEMBER_FIELDS) as (keyof MemberFieldsDraft)[]);
}

export function isMemberFormValid(errors: MemberFormErrors | MemberEditFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

/** Unsafe characters are stripped here, the way the Edge Functions' validate.ts does, so a direct write never trips a `*_text` CHECK. */
function draftToMemberFieldsUpdate(form: MemberFieldsDraft) {
  return {
    name: cleanText(form.name),
    phone: stripSpaces(form.phone),
    date_of_birth: form.date_of_birth,
    date_of_joining: form.date_of_joining,
    gender: form.gender as Gender,
    weight_kg: Number(form.weight_kg),
    height_cm: Number(form.height_cm),
    under_doctor_care: form.under_doctor_care,
    doctor_care_details: form.under_doctor_care ? cleanText(form.doctor_care_details, true) : null,
    emergency_contact_name: cleanText(form.emergency_contact_name),
    emergency_contact_phone: stripSpaces(form.emergency_contact_phone),
    emergency_contact_relationship: cleanText(form.emergency_contact_relationship),
    email: form.email.trim() || null,
    residential_address: cleanText(form.residential_address, true) || null,
    pincode: form.pincode.trim() || null,
    aadhaar_number: stripSpaces(form.aadhaar_number) || null,
    occupation: cleanText(form.occupation) || null,
    handled_by_staff: form.handled_by_staff || null,
  };
}

function draftToNewMember(form: NewMemberDraft): NewMember {
  return { ...draftToMemberFieldsUpdate(form), branch_id: form.branch_id as number };
}

/** Member -> MemberEditDraft, the inverse of draftToMemberFieldsUpdate — member-detail.md §4.1's `memberForm` init. */
export function editDraftFromMember(member: Member): MemberEditDraft {
  return {
    name: member.name,
    phone: member.phone,
    date_of_birth: member.date_of_birth,
    date_of_joining: member.date_of_joining,
    gender: member.gender,
    weight_kg: String(member.weight_kg),
    height_cm: String(member.height_cm),
    under_doctor_care: member.under_doctor_care,
    doctor_care_details: member.doctor_care_details ?? '',
    emergency_contact_name: member.emergency_contact_name,
    emergency_contact_phone: member.emergency_contact_phone,
    emergency_contact_relationship: member.emergency_contact_relationship,
    email: member.email ?? '',
    residential_address: member.residential_address ?? '',
    pincode: member.pincode ?? '',
    aadhaar_number: member.aadhaar_number ?? '',
    occupation: member.occupation ?? '',
    handled_by_staff: member.handled_by_staff ?? '',
  };
}

export interface CreateMemberResult {
  member: Member;
  /** Set only if a photo was supplied and could not be stored — the member record above still saved regardless (REQ-MEM-004). */
  photoError: string | null;
}

const PHOTO_SAVE_FAILED_MESSAGE = "The member was saved, but the photo couldn't be uploaded. You can retry from the member's page.";

/** The member-photos bucket's own limits (spec/backend/member-management.md §8): the server refuses anything else. */
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const isUploadablePhoto = (file: File) => PHOTO_TYPES.includes(file.type) && file.size > 0 && file.size <= MAX_PHOTO_BYTES;

export const memberService = {
  validateNewMember,
  validateMemberEdit,
  isMemberFormValid,
  memberFieldForConstraint,
  editDraftFromMember,

  /**
   * Personal Details/Body Metrics/Doctor's Care/Emergency Contact/handled_by_staff save
   * (member-detail.md §13). Returns the coerced payload actually sent, so the caller can
   * merge it into local Member state without re-fetching (types differ from the string-typed
   * draft — e.g. weight_kg goes back to a number here).
   */
  async updateMember(id: number, form: MemberEditDraft): Promise<UpdateMember> {
    const payload: UpdateMember = draftToMemberFieldsUpdate(form);
    await memberRepository.update(id, payload);
    return payload;
  },

  /**
   * Registers the member and stores their photo in one create-member request. The thumbnail is
   * compressed here first (browser canvas). A photo that can't be used — an unsupported type or
   * size, or compression failing — is left out of the request, and one the server can't store
   * comes back as `photo_error`: either way the member is saved and the caller gets `photoError`
   * (member-management.md §3.1/§4, REQ-MEM-004).
   */
  async create(draft: NewMemberDraft, photoFile: File | null): Promise<CreateMemberResult> {
    let photo: NewMemberPhoto | null = null;
    let photoSkipped = false;
    if (photoFile) {
      try {
        if (!isUploadablePhoto(photoFile)) throw new Error('unsupported-photo');
        photo = { original: photoFile, thumbnail: await compressImage(photoFile) };
      } catch {
        photoSkipped = true;
      }
    }

    const { member, photo_error } = await memberRepository.create(draftToNewMember(draft), photo);
    return { member, photoError: photoSkipped || photo_error ? PHOTO_SAVE_FAILED_MESSAGE : null };
  },

  /** Uploads both the original and a compressed thumbnail, then saves both URLs (REQ-MEM-004). */
  async uploadPhoto(memberId: number, file: File): Promise<void> {
    const compressed = await compressImage(file);
    const timestamp = Date.now();
    const originalPath = `${memberId}/original-${timestamp}.jpg`;
    const thumbnailPath = `${memberId}/thumbnail-${timestamp}.jpg`;

    const [originalResult, thumbnailResult] = await Promise.all([
      supabase.storage.from('member-photos').upload(originalPath, file, { upsert: true }),
      supabase.storage.from('member-photos').upload(thumbnailPath, compressed, { upsert: true }),
    ]);
    if (originalResult.error || thumbnailResult.error) {
      // One side may have already landed in storage even though the other failed — clean
      // it up so a failed upload doesn't leave an orphaned blob nothing ever references.
      const uploadedPaths = [
        originalResult.error ? null : originalPath,
        thumbnailResult.error ? null : thumbnailPath,
      ].filter((p): p is string => p !== null);
      if (uploadedPaths.length > 0) {
        await supabase.storage.from('member-photos').remove(uploadedPaths);
      }
      throw originalResult.error ?? thumbnailResult.error;
    }

    try {
      // member-photos is a private bucket — store the bucket-relative path, not a public
      // URL. Resolved to a short-lived signed URL on read (lib/photo-urls.ts), since a
      // signed URL itself can't be persisted (it expires).
      await memberRepository.update(memberId, { photo_url: originalPath, photo_thumbnail_url: thumbnailPath });
    } catch (err) {
      await supabase.storage.from('member-photos').remove([originalPath, thumbnailPath]);
      throw err;
    }
  },
};

export type MemberService = typeof memberService;
