// Deletes a role (admin). delete_role locks the row, refuses any role a user holds,
// and deletes it, attributed to the caller, in one transaction.
// Its refusals arrive as 409 (in use) and 404 (missing or already deleted).
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { id, object, parseBody } from '../_shared/validate.ts';

const schema = object({ role_id: id({ max: 32767 }) });

serve('delete-role', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'admin', admin);
  const body = parseBody(schema, await readJsonObject(req));

  const { error } = await admin.rpc('delete_role', { p_caller_id: caller.id, p_id: body.role_id });
  rpcError(error);
  return json({ success: true }, 200);
});
