import { supabase } from '../lib/supabase-client';
import { resolvePhotoUrls } from '../lib/photo-urls';
import { toEdgeFunctionError } from '../lib/edge-function-error';
import { toDbError } from '../lib/db-error';
import type { CreateMemberResponse, Member, NewMember, NewMemberPhoto, UpdateMember } from '../types/member';

// Inlined as a literal in every .select() call below (not shared as a variable) — supabase-js
// parses the select string at the type level to infer the result shape, which only works for
// a literal it can see at the call site, not a runtime string constant.

/**
 * Reads and edits are direct RLS-guarded queries; create and delete go through Edge Functions
 * (member-management.md §7). `member_number`/`created_by` are never sent; `branch_id`
 * is never sent on update — see NewMember/UpdateMember (types/member.ts) for why those aren't
 * even accepted as inputs.
 */
const MEMBER_SELECT =
  'id, name, phone, date_of_birth, date_of_joining, gender, weight_kg, height_cm, under_doctor_care, doctor_care_details, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, email, residential_address, pincode, aadhaar_number, occupation, photo_url, photo_thumbnail_url, branch_id, member_number, handled_by_staff, created_by' as const;

export const memberRepository = {
  /** Live row count for the Settings hub's Data Management card (screens.md WSCR-11). */
  async getCount(): Promise<number> {
    const { count, error } = await supabase.from('members').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return count ?? 0;
  },

  async getById(id: number): Promise<Member | null> {
    const { data, error } = await supabase.from('members').select(MEMBER_SELECT).eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const [resolved] = await resolvePhotoUrls([data as unknown as Member]);
    return resolved;
  },

  /**
   * Registers the member — and stores their photo, if one is given — in one multipart request to
   * the create-member Edge Function: the member as JSON in `member`, the photo as `original` and
   * `thumbnail`. The server generates `member_number`, sets the audit fields and builds the photo
   * paths. A photo that couldn't be stored comes back as `photo_error`; the member is saved
   * regardless (REQ-MEM-004). A refusal throws an EdgeFunctionError carrying its stable `code`
   * (e.g. MEMBER_PHONE_IN_USE).
   */
  async create(data: NewMember, photo: NewMemberPhoto | null): Promise<CreateMemberResponse> {
    const body = new FormData();
    body.set('member', JSON.stringify(data));
    if (photo) {
      body.set('original', photo.original, 'original');
      body.set('thumbnail', photo.thumbnail, 'thumbnail');
    }
    const { data: created, error } = await supabase.functions.invoke('create-member', { body });
    if (error) throw await toEdgeFunctionError(error);
    return created as CreateMemberResponse;
  },

  async update(id: number, data: UpdateMember): Promise<void> {
    const { error } = await supabase.from('members').update(data).eq('id', id);
    if (error) throw toDbError(error);
  },

  /**
   * Deletes the member for real (REQ-MEM-007) and removes their photo files; it cannot be undone.
   * Routed through the delete-member Edge Function (not a direct delete like the reads above)
   * because it needs an authoritative, server-side usage guard: a member that subscription items
   * use (as member or shared member) is refused with 409 MEMBER_IN_USE — delete those
   * subscriptions first. See member-management.md §9.
   */
  async delete(id: number): Promise<void> {
    const { error } = await supabase.functions.invoke('delete-member', { body: { member_id: id } });
    if (error) throw await toEdgeFunctionError(error);
  },
};

export type MemberRepository = typeof memberRepository;
