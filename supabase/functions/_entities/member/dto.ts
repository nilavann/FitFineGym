// The member entity's wire contract: what the member functions accept and what they answer. The
// request DTO is the schema's own type, so the validation and the type can't drift apart. A
// response is built field by field (mapper.ts), never the database row or a to_jsonb result, so a
// column added later, or an audit column, can't reach the client by accident.
//
// The limits below mirror the database's chk_members_* constraints, which stay the authority: a
// value accepted here is one the database accepts, and this is only the fast, readable 400.
import {
  boolean, date, decimal, digits, email, id, nullable, object, oneOf, optional, type Parsed, refine,
  text, textOrNull, uuid,
} from '../../_shared/validate.ts';

/** delete-member and purge-member: which member. */
export const memberIdRequest = object({ member_id: id() });
export type MemberIdRequest = Parsed<typeof memberIdRequest>;

export const GENDERS = ['Male', 'Female', 'Other'] as const;

/**
 * create-member: the member part of the request. member_number, created_by, the audit columns and
 * the photo paths are not fields at all (an unknown field is a 400): the database and the photo
 * upload set them.
 */
export const createMemberRequest = refine(
  object({
    name: text({ max: 80 }),
    phone: digits(10),
    date_of_birth: date(),
    date_of_joining: date(),
    gender: oneOf(GENDERS),
    weight_kg: decimal({ min: 1, max: 500 }),
    height_cm: decimal({ min: 1, max: 300 }),
    under_doctor_care: boolean(),
    doctor_care_details: optional(textOrNull({ max: 1000, multiline: true })),
    emergency_contact_name: text({ max: 80 }),
    emergency_contact_phone: digits(10),
    emergency_contact_relationship: text({ max: 40 }),
    branch_id: id(),
    email: optional(nullable(email())),
    residential_address: optional(textOrNull({ max: 500, multiline: true })),
    pincode: optional(nullable(digits(6))),
    aadhaar_number: optional(nullable(digits(12))),
    occupation: optional(textOrNull({ max: 80 })),
    handled_by_staff: optional(nullable(uuid())),
  }),
  (m) => (m.under_doctor_care && !m.doctor_care_details
    ? { field: 'doctor_care_details', reason: 'is required when under_doctor_care is true' }
    : null),
);
export type CreateMemberRequest = Parsed<typeof createMemberRequest>;

/** The photo that comes with a new member: the original and its compressed thumbnail. */
export interface MemberPhoto {
  original: File;
  thumbnail: File;
}

/** Where a member's photo was stored: bucket-relative, under `<member_id>/`. */
export interface PhotoPaths {
  original: string;
  thumbnail: string;
}

/** What fitfine.create_member returns: the new members row (to_jsonb), before the mapper. */
export interface MemberRow {
  id: number;
  name: string;
  phone: string;
  date_of_birth: string;
  date_of_joining: string;
  gender: string;
  weight_kg: number;
  height_cm: number;
  under_doctor_care: boolean;
  doctor_care_details: string | null;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_relationship: string;
  email: string | null;
  residential_address: string | null;
  pincode: string | null;
  aadhaar_number: string | null;
  occupation: string | null;
  photo_url: string | null;
  photo_thumbnail_url: string | null;
  branch_id: number;
  member_number: string;
  handled_by_staff: string | null;
  created_by: string | null;
}

/**
 * A member as the client receives it: the fields the frontend's Member type reads. Declared
 * apart from MemberRow on purpose: the row is what the database holds, this is the contract, and
 * the mapper is the only place that connects them. Photo paths are bucket-relative.
 */
export interface MemberResponse {
  id: number;
  name: string;
  phone: string;
  date_of_birth: string;
  date_of_joining: string;
  gender: string;
  weight_kg: number;
  height_cm: number;
  under_doctor_care: boolean;
  doctor_care_details: string | null;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_relationship: string;
  email: string | null;
  residential_address: string | null;
  pincode: string | null;
  aadhaar_number: string | null;
  occupation: string | null;
  photo_url: string | null;
  photo_thumbnail_url: string | null;
  branch_id: number;
  member_number: string;
  handled_by_staff: string | null;
  created_by: string | null;
}

/** Why a photo that came with a new member is not stored; the member itself is saved. */
export type PhotoErrorCode = 'PHOTO_UPLOAD_FAILED';

export interface CreateMemberResponse {
  member: MemberResponse;
  photo_error: PhotoErrorCode | null;
}

export interface DeleteMemberResponse {
  success: true;
}

export interface PurgeMemberResponse {
  success: true;
  /** false when the rows are gone but some photos could not be removed (logged, to clean up by hand). */
  photos_removed: boolean;
}

/** What fitfine.purge_member returns: the stored photo paths and how many rows went with the member. */
export interface PurgeResult {
  photo_paths: string[];
  subscriptions: number;
  items: number;
}
