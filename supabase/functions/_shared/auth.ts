// requireCaller: verifies the JWT, then makes the
// one user_access call, so the access rule lives only in the database (fitfine_private.access_of).
import { callerClient, type Client } from './clients.ts';
import { HttpError } from './http.ts';

export type Level = 'active' | 'admin';

export interface Caller {
  id: string;
  isActive: boolean;
  isAdmin: boolean;
  /** Active admins other than the caller. */
  otherActiveAdmins: number;
}

export interface Access {
  is_active: boolean;
  is_admin: boolean;
  other_active_admins: number;
}

/** One user's access, from fitfine.user_access. */
export async function userAccess(admin: Client, userId: string): Promise<Access> {
  const { data, error } = await admin.rpc('user_access', { p_user_id: userId });
  if (error) throw error;
  return data as Access;
}

const REFUSAL: Record<Level, string> = {
  active: 'Active account required',
  admin: 'Admin access required',
};

/** The verified caller at `level`, or a 401 / 403. Runs before any other query. */
export async function requireCaller(req: Request, level: Level, admin: Client): Promise<Caller> {
  const authorization = req.headers.get('Authorization');
  if (!authorization) throw new HttpError(401, 'Missing Authorization header');

  const { data, error } = await callerClient(authorization).auth.getUser();
  if (error || !data.user) throw new HttpError(401, 'Invalid or expired session');

  const access = await userAccess(admin, data.user.id);
  const allowed = level === 'active' ? access.is_active : access.is_admin;
  if (!allowed) throw new HttpError(403, REFUSAL[level]);

  return {
    id: data.user.id,
    isActive: access.is_active,
    isAdmin: access.is_admin,
    otherActiveAdmins: access.other_active_admins,
  };
}
