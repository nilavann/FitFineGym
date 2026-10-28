// Sets what the next member registered at a branch will be numbered (admin; spec/backend/
// member-management.md §3.1). set_member_number_sequence does it atomically: it locks the
// branch's counter, walks a value already issued at that branch forward to the first unused one
// (member_number is never reused, REQ-MEM-007) and primes the counter. The response reports the
// value applied, which the screen shows when it differs from the one requested.
import { requireCaller } from '../_shared/auth.ts';
import { serviceClient } from '../_shared/clients.ts';
import { json, readJsonObject, rpcError, serve } from '../_shared/http.ts';
import { id, integer, object, parseBody } from '../_shared/validate.ts';

const schema = object({
  branch_id: id(),
  next_sequence: integer({ min: 1, max: 2_147_483_647 }),
});

serve('update-member-number-sequence', async (req) => {
  const admin = serviceClient();
  const caller = await requireCaller(req, 'admin', admin);
  const body = parseBody(schema, await readJsonObject(req));

  const { data, error } = await admin.rpc('set_member_number_sequence', {
    p_caller_id: caller.id,
    p_branch_id: body.branch_id,
    p_next_sequence: body.next_sequence,
  });
  rpcError(error);
  return json({ success: true, ...(data as Record<string, unknown>) }, 200);
});
