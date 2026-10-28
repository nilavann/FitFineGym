// Database result -> response DTO, field by field. Nothing is spread: a column the row gains later
// (an audit column, a deleted_at) stays on the server until it is added here on purpose.
import type { MemberResponse, MemberRow, PhotoPaths } from './dto.ts';

export function toMemberResponse(row: MemberRow, photo: PhotoPaths | null = null): MemberResponse {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    date_of_birth: row.date_of_birth,
    date_of_joining: row.date_of_joining,
    gender: row.gender,
    weight_kg: row.weight_kg,
    height_cm: row.height_cm,
    under_doctor_care: row.under_doctor_care,
    doctor_care_details: row.doctor_care_details,
    emergency_contact_name: row.emergency_contact_name,
    emergency_contact_phone: row.emergency_contact_phone,
    emergency_contact_relationship: row.emergency_contact_relationship,
    email: row.email,
    residential_address: row.residential_address,
    pincode: row.pincode,
    aadhaar_number: row.aadhaar_number,
    occupation: row.occupation,
    // A photo stored after the row was created is not on the row this was built from.
    photo_url: photo ? photo.original : row.photo_url,
    photo_thumbnail_url: photo ? photo.thumbnail : row.photo_thumbnail_url,
    branch_id: row.branch_id,
    member_number: row.member_number,
    handled_by_staff: row.handled_by_staff,
    created_by: row.created_by,
  };
}
