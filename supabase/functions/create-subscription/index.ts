// One checkout: a subscription header and its items (spec/backend/subscription-management.md). The server computes every item's end_date
// (start_date + duration_days x quantity - 1, or NULL for an indefinite plan) and amount default;
// create_subscription_with_items writes header and items in one transaction and re-checks the
// members, the plans and the duplicate-indefinite rule there.
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { HttpError, json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { amount, array, date, id, integer, nullable, object, oneOf, optional, parseBody, textOrNull } from '../_shared/validate.ts';

const schema = object({
  member_id: id(),
  payment_mode: oneOf(['Cash', 'UPI', 'Card'] as const),
  notes: optional(textOrNull({ max: 200, multiline: true })),
  items: array(
    object({
      plan_id: id(),
      member_id: id(),
      shared_member_id: optional(nullable(id())),
      start_date: date(),
      quantity: optional(nullable(integer({ min: 1, max: 1000 }))),
      amount_paid: optional(nullable(amount())),
    }),
    { min: 1, max: 20 },
  ),
});

interface PlanRow {
  id: number;
  name: string;
  category: 'membership' | 'addon';
  duration_days: number | null;
  price: number;
  max_members: number;
}

/** `start_date + days` in plain YYYY-MM-DD arithmetic: both sides are dates, no timezone. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

serve('create-subscription', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'active', admin);
  const body = parseBody(schema, await readJsonObject(req));

  // Every item is for the header's member; a couple plan's partner goes in shared_member_id.
  for (const item of body.items) {
    if (item.member_id !== body.member_id) {
      throw new HttpError(400, "Every item must be for the subscription's member (a partner goes in shared_member_id)");
    }
  }

  // The header member and every shared member exist and aren't soft-deleted.
  const memberIds = [...new Set([body.member_id, ...body.items.flatMap((i) => (i.shared_member_id ? [i.shared_member_id] : []))])];
  const { data: members, error: membersError } = await admin.from('members').select('id').in('id', memberIds).is('deleted_at', null);
  if (membersError) throw membersError;
  const found = new Set(((members ?? []) as { id: number }[]).map((m) => m.id));
  const missing = memberIds.find((m) => !found.has(m));
  if (missing !== undefined) throw new HttpError(404, `Member ${missing} not found`);

  const planIds = [...new Set(body.items.map((i) => i.plan_id))];
  const { data: plans, error: plansError } = await admin
    .from('plans')
    .select('id, name, category, duration_days, price, max_members')
    .in('id', planIds)
    .is('deleted_at', null);
  if (plansError) throw plansError;
  const planById = new Map(((plans ?? []) as PlanRow[]).map((p) => [p.id, p]));
  for (const item of body.items) {
    if (!planById.has(item.plan_id)) throw new HttpError(400, `Plan ${item.plan_id} does not exist or is not active`);
  }

  const membershipItems = body.items.reduce((n, i) => n + (planById.get(i.plan_id)!.category === 'membership' ? 1 : 0), 0);
  if (membershipItems !== 1) {
    throw new HttpError(400, 'A checkout must include exactly one membership-category item');
  }

  const items = body.items.map((item) => {
    const plan = planById.get(item.plan_id)!;
    const indefinite = plan.duration_days === null;
    if (indefinite && item.quantity != null && item.quantity !== 1) {
      throw new HttpError(400, `Plan "${plan.name}" is indefinite and does not accept a quantity`);
    }
    const quantity = indefinite ? 1 : item.quantity ?? 1;
    if (item.shared_member_id != null) {
      if (plan.category !== 'membership' || plan.max_members !== 2) {
        throw new HttpError(400, `Plan "${plan.name}" does not support a shared member`);
      }
      if (item.shared_member_id === item.member_id) throw new HttpError(400, 'shared_member_id cannot equal member_id');
    }
    return {
      plan_id: item.plan_id,
      member_id: item.member_id,
      shared_member_id: item.shared_member_id ?? null,
      start_date: item.start_date,
      end_date: indefinite ? null : addDays(item.start_date, plan.duration_days! * quantity - 1),
      quantity,
      amount_paid: item.amount_paid ?? Number(plan.price) * quantity,
    };
  });

  const { data, error } = await admin.rpc('create_subscription_with_items', {
    p_caller_id: caller.id,
    p_member_id: body.member_id,
    p_payment_mode: body.payment_mode,
    p_notes: body.notes ?? null,
    p_items: items,
  });
  rpcError(error);
  return json(data, 201);
});
