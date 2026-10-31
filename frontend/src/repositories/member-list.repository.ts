import { supabase } from '../lib/supabase-client';
import { resolvePhotoUrls } from '../lib/photo-urls';
import type { MemberListRow } from '../types/member-list';

const MEMBER_LIST_SELECT =
  'id, name, phone, member_number, date_of_joining, gender, photo_url, photo_thumbnail_url, current_membership_plan_id, current_membership_plan_name, current_membership_end_date, current_addon_plan_ids' as const;

/**
 * Reads from `member_list_view` (spec/backend/member-management.md §5) — never re-derives
 * this from raw `subscription_items` on the client. Fetches the full result set once per
 * route entry; search/filter/sort all happen client-side over it (performance note, same doc).
 */
export const memberListRepository = {
  async getAll(): Promise<MemberListRow[]> {
    const { data, error } = await supabase
      .from('member_list_view')
      .select(MEMBER_LIST_SELECT)
      .order('date_of_joining', { ascending: false });
    if (error) throw new Error(error.message);
    return resolvePhotoUrls((data ?? []) as unknown as MemberListRow[]);
  },

  /**
   * Action Center's bounded queue (spec/frontend/action-center.md) — a real Postgres-side
   * filter via supabase-js, same view, same RLS, rather than fetching every member just to
   * build a near-term-expiry queue. `from`/`to` arrive pre-computed (no date math here, per
   * the layering rule — see lib/action-center.ts).
   */
  async getActionCenterQueue({ from, to }: { from: string; to: string }): Promise<MemberListRow[]> {
    const { data, error } = await supabase
      .from('member_list_view')
      .select(MEMBER_LIST_SELECT)
      .gte('current_membership_end_date', from)
      .lte('current_membership_end_date', to)
      .order('current_membership_end_date', { ascending: true });
    if (error) throw new Error(error.message);
    return resolvePhotoUrls((data ?? []) as unknown as MemberListRow[]);
  },

  /**
   * How many members are in the Action Center queue - for the nav badge, which only shows a number. A HEAD request
   * with `count=exact` on the same view and window as getActionCenterQueue(): no rows come back and no photo URLs
   * are signed, so the badge costs one small round trip instead of the whole list plus a Storage call.
   */
  async getActionCenterCount({ from, to }: { from: string; to: string }): Promise<number> {
    const { count, error } = await supabase
      .from('member_list_view')
      .select('id', { count: 'exact', head: true })
      .gte('current_membership_end_date', from)
      .lte('current_membership_end_date', to);
    if (error) throw new Error(error.message);
    return count ?? 0;
  },
};

export type MemberListRepository = typeof memberListRepository;
