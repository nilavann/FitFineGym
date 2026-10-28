// Deletes a checkout (staff or admin): its items, then its header, attributed to the caller, in one
// transaction (delete_subscription). It is how a mistaken checkout is undone, and it is what frees
// a member to be deleted (delete-member refuses a member that subscription items use).
// A missing subscription is a 404.
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { id, object, parseBody } from '../_shared/validate.ts';

const schema = object({ subscription_id: id() });

serve('delete-subscription', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'active', admin);
  const body = parseBody(schema, await readJsonObject(req));

  const { error } = await admin.rpc('delete_subscription', { p_caller_id: caller.id, p_id: body.subscription_id });
  rpcError(error);
  return json({ success: true }, 200);
});
