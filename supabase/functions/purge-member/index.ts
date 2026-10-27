// Permanently erases a member (REQ-MEM-008, system admin only): purge_member removes the rows,
// then the member's photos are removed from storage. The one permanent delete in the app.
// The photo handling (everything under `<member_id>/`, nothing outside it) is in
// _entities/member/photo-storage.ts and rules.ts.
import { defineFunction } from '../_shared/define-function.ts';
import { json } from '../_shared/http.ts';
import { memberIdRequest } from '../_entities/member/dto.ts';
import { memberServiceFor } from '../_entities/member/service.ts';

defineFunction({ name: 'purge-member', level: 'system_admin', schema: memberIdRequest }, async ({ admin, caller, body }) => {
  return json(await memberServiceFor(admin).purge(caller.id, body.member_id));
});
