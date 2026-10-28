// Deletes a plan (admin). delete_plan locks the row, refuses a plan that subscription items use, and
// deletes it, attributed to the caller, in one transaction.
// Its refusals arrive as 409 (in use) and 404 (missing or already deleted).
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { id, object, parseBody } from '../_shared/validate.ts';

const schema = object({ plan_id: id() });

serve('delete-plan', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'admin', admin);
  const body = parseBody(schema, await readJsonObject(req));

  const { error } = await admin.rpc('delete_plan', { p_caller_id: caller.id, p_id: body.plan_id });
  rpcError(error);
  return json({ success: true }, 200);
});
