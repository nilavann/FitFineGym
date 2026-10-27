// Edits a subscription's header (payment_mode, notes). Items are immutable after creation: a
// change to an item is a new checkout (spec/backend/subscription-management.md §4).
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { id, object, oneOf, optional, parseBody, textOrNull } from '../_shared/validate.ts';

const schema = object({
  subscription_id: id(),
  payment_mode: optional(oneOf(['Cash', 'UPI', 'Card'] as const)),
  notes: optional(textOrNull({ max: 200, multiline: true })),
});

serve('update-subscription', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'active', admin);
  const body = parseBody(schema, await readJsonObject(req));

  const { data, error } = await admin.rpc('update_subscription_header', {
    p_caller_id: caller.id,
    p_subscription_id: body.subscription_id,
    p_payment_mode: body.payment_mode ?? null,
    p_notes: body.notes ?? null,
    // "notes left out" (keep them) and "notes: null" (clear them) both reach the RPC as NULL;
    // this flag carries the difference.
    p_notes_provided: Object.hasOwn(body, 'notes'),
  });
  rpcError(error);
  return json(data, 200);
});
