// Soft-deletes a branch (admin). soft_delete_branch locks the row, refuses a branch that live members
// belong to, and soft-deletes it, attributed to the caller, in one transaction.
// Its refusals arrive as 409 (in use) and 404 (missing or already deleted).
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { id, object, parseBody } from '../_shared/validate.ts';

const schema = object({ branch_id: id() });

serve('delete-branch', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'admin', admin);
  const body = parseBody(schema, await readJsonObject(req));

  const { error } = await admin.rpc('soft_delete_branch', { p_caller_id: caller.id, p_id: body.branch_id });
  rpcError(error);
  return json({ success: true }, 200);
});
