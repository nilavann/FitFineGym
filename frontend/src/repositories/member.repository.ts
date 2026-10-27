import { supabase } from '../lib/supabase-client';
import { resolvePhotoUrls } from '../lib/photo-urls';
import { toEdgeFunctionError } from '../lib/edge-function-error';
import { toDbError } from '../lib/db-error';
import type { CreateMemberResponse, Member, NewMember, NewMemberPhoto, UpdateMember } from '../types/member';

// Inlined as a literal in every .select() call below (not shared as a variable) — supabase-js
// parses the select string at the type level to infer the result shape, which only works for
// a literal it can see at the call site, not a runtime string constant.

/**
 * Reads and edits are direct RLS-guarded queries; create, delete and purge go through Edge
 * Functions (member-management.md §7). `member_number`/`created_by` are never sent; `branch_id`
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
   * Soft delete only (REQ-MEM-007) — never a real DELETE, database.md enforces this at the
   * trigger level too. Routed through the delete-member Edge Function (not a direct update
   * like create/update above) because this is the one member write that needs an
   * authoritative, server-side usage guard — see member-management.md §9.
   */
  async delete(id: number): Promise<void> {
    const { error } = await supabase.functions.invoke('delete-member', { body: { member_id: id } });
    if (error) throw await toEdgeFunctionError(error);
  },

  /**
   * Permanent delete (REQ-MEM-008) — the one real DELETE in the app, system admin only.
   * Erases the member, their subscriptions, items, audit history and photo files; cannot be
   * undone. `purge-member` re-checks the caller server-side, so the UI gate is UX only.
   * Resolves `photosRemoved: false` when the rows are gone but the files could not be removed.
   */
  async purge(id: number): Promise<{ photosRemoved: boolean }> {
    const { data, error } = await supabase.functions.invoke('purge-member', { body: { member_id: id } });
    if (error) throw await toEdgeFunctionError(error);
    return { photosRemoved: data?.photos_removed !== false };
  },
};

export type MemberRepository = typeof memberRepository;
