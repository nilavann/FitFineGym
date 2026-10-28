import { supabase } from '../lib/supabase-client';
import { extractFunctionErrorMessage, toEdgeFunctionError } from '../lib/edge-function-error';
import type { ManagedUser, Profile, ProfileRole } from '../types/profile';

export interface InviteUser {
  email: string;
  full_name: string;
  roles: ProfileRole[];
}

export interface UpdateUser {
  full_name?: string;
  roles?: ProfileRole[];
  is_active?: boolean;
}

/** RLS-gated by `profiles_select_active_users` — see spec/backend/auth.md §3. */
export const profileRepository = {
  /** Live row count for the Settings hub's Data Management card (screens.md WSCR-11). */
  async getCount(): Promise<number> {
    const { count, error } = await supabase.from('profiles').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return count ?? 0;
  },

  /** Returns null if no matching, active, non-deleted profile row exists. */
  async getById(id: string): Promise<Profile | null> {
    const { data, error } = await supabase
      .from('profiles_with_roles')
      .select('id, full_name, roles, is_active')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data;
  },

  /** Every active user — feeds the handled_by_staff *picker* specifically (you shouldn't be
   * able to newly assign a deactivated staffer). For resolving an already-stored
   * created_by/handled_by_staff id to a display name, use getAll() instead — a deactivated
   * staffer's past attributions shouldn't render as "Unknown" just because they can no longer be
   * picked for a new one (member-detail.md §12). */
  async getAllActive(): Promise<Profile[]> {
    const { data, error } = await supabase
      .from('profiles_with_roles')
      .select('id, full_name, roles, is_active')
      .eq('is_active', true)
      .order('full_name');
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Profile[];
  },

  /** Every user regardless of is_active — for resolving created_by/handled_by_staff ids to display
   * names without a deactivated staffer's history looking like "Unknown". `profiles_select_active_users`
   * RLS only requires the CALLER to be active; it doesn't filter the target row on is_active. */
  async getAll(): Promise<Profile[]> {
    const { data, error } = await supabase
      .from('profiles_with_roles')
      .select('id, full_name, roles, is_active')
      .order('full_name');
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Profile[];
  },

  /** Users, WITH email — Manage Users list (screens.md WSCR-09). Admin-only, via list-users
   * (edge-functions.md §5). Every user is listed, deactivated ones included: users are never deleted. */
  async getAllUsers(): Promise<ManagedUser[]> {
    const { data, error } = await supabase.functions.invoke('list-users', { body: {} });
    if (error) throw new Error(await extractFunctionErrorMessage(error));
    return (data?.users ?? []) as ManagedUser[];
  },

  /** Invites a new admin/staff user — sends a Supabase Auth invite email (screens.md WSCR-10). */
  async invite(data: InviteUser): Promise<void> {
    const { error } = await supabase.functions.invoke('invite-user', { body: data });
    if (error) throw await toEdgeFunctionError(error);
  },

  /** Edits full_name/role/is_active on another user's profile — self-protection enforced server-side (edge-functions.md §5). */
  async update(id: string, data: UpdateUser): Promise<Profile> {
    const { data: updated, error } = await supabase.functions.invoke('update-user', { body: { user_id: id, ...data } });
    if (error) throw await toEdgeFunctionError(error);
    return updated as Profile;
  },
};

export type ProfileRepository = typeof profileRepository;
