// Manage Users (REQ-ADMIN-004, admin): every profile with its roles and its sign-in email. The
// emails live only in auth.users, which only the service role's admin API can read; deleted users
// are included on request (include_deleted), which is why this reads through the service role.
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { json, readJsonObject, serve } from '../_shared/http.ts';
import { boolean, object, optional, parseBody } from '../_shared/validate.ts';

const schema = object({ include_deleted: optional(boolean()) });

interface ProfileWithRoles {
  id: string;
  full_name: string;
  roles: string[];
  is_active: boolean;
  deleted_at: string | null;
}

serve('list-users', async (req) => {
  const admin = serviceClient();
  await requireCaller(req, 'admin', admin);
  const body = parseBody(schema, await readJsonObject(req));

  let query = admin.from('profiles_with_roles').select('id, full_name, roles, is_active, deleted_at');
  if (!body.include_deleted) query = query.is('deleted_at', null);
  const { data: profiles, error: profilesError } = await query;
  if (profilesError) throw profilesError;

  // auth.admin.listUsers is paginated: a page shorter than perPage is the last one.
  const emailById = new Map<string, string>();
  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    for (const u of data.users) if (u.email) emailById.set(u.id, u.email);
    if (data.users.length < perPage) break;
  }

  // A profile always has its auth user (profiles.id references auth.users); one without an email
  // (a phone-only user) is left out rather than shown without one.
  const users = ((profiles ?? []) as ProfileWithRoles[])
    .flatMap((p) => {
      const email = emailById.get(p.id);
      return email === undefined
        ? []
        : [{ id: p.id, email, full_name: p.full_name, roles: p.roles, is_active: p.is_active, deleted_at: p.deleted_at }];
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name));

  return json({ users }, 200);
});
