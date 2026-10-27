// Invites a user by email, with their roles (spec/backend/auth.md, phase-2-plan.md §2.3; F17). The
// roles are checked here (they exist and aren't deleted; system_admin only from a system admin and
// only together with admin), then travel in the invite's metadata: handle_new_auth_user creates the
// profile and its user_roles rows in the same transaction as the auth.users insert, so an invite
// yields a profile with its roles or fails as a whole.
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { HttpError, json, readJsonObject, serve } from '../_shared/http.ts';
import { array, email, object, parseBody, text } from '../_shared/validate.ts';

const schema = object({
  email: email(),
  full_name: text({ max: 80 }),
  roles: array(text({ max: 80 }), { min: 1, max: 20 }),
});

serve('invite-user', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'admin', admin);
  const body = parseBody(schema, await readJsonObject(req));
  const roleNames = [...new Set(body.roles)];

  // Checked against the live roles, not a fixed list: a role added in Manage Roles is assignable at once.
  const { data: roles, error: rolesError } = await admin.from('roles').select('id, name').in('name', roleNames).is('deleted_at', null);
  if (rolesError) throw rolesError;
  const roleRows = (roles ?? []) as { id: number; name: string }[];
  if (roleRows.length !== roleNames.length) throw new HttpError(400, 'One or more roles do not exist or are not active');

  if (roleRows.some((r) => r.name === 'system_admin')) {
    if (!caller.isSystemAdmin) throw new HttpError(403, 'Only a system admin can grant the system_admin role.');
    if (!roleRows.some((r) => r.name === 'admin')) {
      throw new HttpError(400, 'The system_admin role can only be held together with admin.');
    }
  }

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(body.email, {
    data: { full_name: body.full_name, invited_by: caller.id, role_ids: roleRows.map((r) => r.id) },
  });
  if (inviteError) {
    if (inviteError.message?.toLowerCase().includes('already been registered')) {
      throw new HttpError(409, 'This email is already registered.');
    }
    throw inviteError;
  }

  return json({ id: invited.user!.id, email: invited.user!.email }, 201);
});
