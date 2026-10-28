// Edits, soft-deletes or restores another user's profile (admin; spec/backend/edge-functions.md
// §5). An Edge Function rather than a direct update because RLS can't express "not the caller's own
// roles or active status". The last-admin rule is enforced inside update_profile_fields,
// soft_delete_profile and replace_user_roles, in the same transaction as the write; the check
// here only fails fast, before a request that changes both roles and active status writes either.
// It is also how an invitee left without roles is fixed.
import { requireCaller, userAccess } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { HttpError, json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { array, boolean, object, optional, parseBody, text, uuid } from '../_shared/validate.ts';

const schema = object({
  user_id: uuid(),
  full_name: optional(text({ max: 80 })),
  roles: optional(array(text({ max: 80 }), { min: 1, max: 20 })),
  is_active: optional(boolean()),
  delete: optional(boolean()),
  restore: optional(boolean()),
});

serve('update-user', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'admin', admin);
  const body = parseBody(schema, await readJsonObject(req));
  const isSelf = body.user_id === caller.id;

  // Soft delete (REQ-ADMIN-006): a separate, more severe action than deactivation.
  if (body.delete) {
    if (isSelf) throw new HttpError(403, 'You cannot delete your own account.');
    const { error } = await admin.rpc('soft_delete_profile', { p_caller_id: caller.id, p_target_user_id: body.user_id });
    rpcError(error);
    return json({ success: true }, 200);
  }

  // Restore: undoes a soft delete, so deleting isn't a dead end.
  if (body.restore) {
    const { error } = await admin.rpc('restore_profile', { p_caller_id: caller.id, p_target_user_id: body.user_id });
    rpcError(error);
    return json({ success: true }, 200);
  }

  if (isSelf && (body.roles !== undefined || body.is_active !== undefined)) {
    throw new HttpError(403, 'You cannot change your own roles or active status.');
  }
  if (body.full_name === undefined && body.roles === undefined && body.is_active === undefined) {
    throw new HttpError(400, 'No fields to update');
  }

  let roleIds: number[] | undefined;
  let losesAdmin = false;
  if (body.roles !== undefined) {
    const names = [...new Set(body.roles)];
    const { data: roles, error: rolesError } = await admin.from('roles').select('id, name').in('name', names).is('deleted_at', null);
    if (rolesError) throw rolesError;
    const rows = (roles ?? []) as { id: number; name: string }[];
    if (rows.length !== names.length) throw new HttpError(400, 'One or more roles do not exist or are not active');
    roleIds = rows.map((r) => r.id);
    losesAdmin = !rows.some((r) => r.name === 'admin');
  }

  if (losesAdmin || body.is_active === false) {
    const target = await userAccess(admin, body.user_id);
    if (target.is_admin && target.other_active_admins === 0) {
      throw new HttpError(409, losesAdmin ? 'Cannot remove — this is the last active admin.' : 'Cannot deactivate — this is the last active admin.');
    }
  }

  if (roleIds !== undefined) {
    const { error } = await admin.rpc('replace_user_roles', {
      p_caller_id: caller.id,
      p_target_user_id: body.user_id,
      p_role_ids: roleIds,
    });
    rpcError(error);
  }

  if (body.full_name !== undefined || body.is_active !== undefined) {
    const { error } = await admin.rpc('update_profile_fields', {
      p_caller_id: caller.id,
      p_target_user_id: body.user_id,
      p_full_name: body.full_name ?? null,
      p_is_active: body.is_active ?? null,
    });
    rpcError(error);
  }

  const { data: updated, error: fetchError } = await admin
    .from('profiles_with_roles')
    .select('id, full_name, roles, is_active')
    .eq('id', body.user_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!updated) throw new HttpError(404, 'User not found');
  return json(updated, 200);
});
