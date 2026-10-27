// Soft-deletes a role (admin). soft_delete_role locks the row, refuses system_admin and any role a
// user holds, and soft-deletes it, attributed to the caller, in one transaction.
// Its refusals arrive as 409 (in use), 404 (missing or already deleted) and 403 (system_admin).
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { id, object, parseBody } from '../_shared/validate.ts';

const schema = object({ role_id: id({ max: 32767 }) });

serve('delete-role', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'admin', admin);
  const body = parseBody(schema, await readJsonObject(req));

  const { error } = await admin.rpc('soft_delete_role', { p_caller_id: caller.id, p_id: body.role_id });
  rpcError(error);
  return json({ success: true }, 200);
});
