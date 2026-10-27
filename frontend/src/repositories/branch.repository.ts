import { supabase } from '../lib/supabase-client';
import { toEdgeFunctionError } from '../lib/edge-function-error';
import { toDbError } from '../lib/db-error';
import type { Branch } from '../types/branch';

const BRANCH_SELECT = 'id, name, code' as const;

export interface NewBranch {
  name: string;
  code: string;
}

export type UpdateBranch = Partial<NewBranch>;

/**
 * Reads/create/update are direct RLS-guarded calls — no Edge Function needed
 * (master-data-management.md §3): one row, one table, no cross-table atomicity
 * requirement the way members/subscriptions have. Read is open to any active user
 * (`branches_select_active_users`); insert/update are admin-only. Delete is the one
 * exception — it needs the delete-branch Edge Function for its usage guard (§5).
 */
export const branchRepository = {
  /** Live row count for the Settings hub's Data Management card (screens.md WSCR-11). */
  async getCount(): Promise<number> {
    const { count, error } = await supabase.from('branches').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return count ?? 0;
  },

  async getAllActive(): Promise<Branch[]> {
    const { data, error } = await supabase.from('branches').select(BRANCH_SELECT).order('name');
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Branch[];
  },

  async create(data: NewBranch): Promise<Branch> {
    const { data: created, error } = await supabase.from('branches').insert(data).select(BRANCH_SELECT).single();
    if (error) throw toDbError(error);
    return created as unknown as Branch;
  },

  async update(id: number, data: UpdateBranch): Promise<void> {
    const { error } = await supabase.from('branches').update(data).eq('id', id);
    if (error) throw toDbError(error);
  },

  async delete(id: number): Promise<void> {
    const { error } = await supabase.functions.invoke('delete-branch', { body: { branch_id: id } });
    if (error) throw await toEdgeFunctionError(error);
  },
};

export type BranchRepository = typeof branchRepository;
