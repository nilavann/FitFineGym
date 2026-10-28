// Soft-deletes a member (staff or admin, REQ-MEM-007). soft_delete_member locks the row, refuses a
// member that live subscription items use (as member or shared member), and soft-deletes it,
// attributed to the caller, in one transaction.
// Its refusals arrive as 409 MEMBER_IN_USE and 404 MEMBER_NOT_FOUND (_entities/member/errors.ts).
import { defineFunction } from '../_shared/define-function.ts';
import { json } from '../_shared/http.ts';
import { memberIdRequest } from '../_entities/member/dto.ts';
import { memberServiceFor } from '../_entities/member/service.ts';

defineFunction({ name: 'delete-member', level: 'active', schema: memberIdRequest }, async ({ admin, caller, body }) => {
  return json(await memberServiceFor(admin).softDelete(caller.id, body.member_id));
});
