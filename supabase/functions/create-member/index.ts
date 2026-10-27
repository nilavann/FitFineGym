// Registers a member and stores their photo in one request (staff or admin, REQ-MEM-001/004). The
// request is multipart/form-data: the member as JSON in `member`, and optionally the compressed
// `thumbnail` with the `original` photo. create_member inserts the row (the database generates
// member_number and the audit fields); the photo is stored afterwards, at server-built paths. A
// photo that can't be stored never fails the request: the member is saved and `photo_error` says so.
// Refusals arrive as 400 MEMBER_INVALID_REFERENCE and 409 MEMBER_PHONE_IN_USE (_entities/member/errors.ts).
import { defineFunction } from '../_shared/define-function.ts';
import { json } from '../_shared/http.ts';
import { createMemberRequest } from '../_entities/member/dto.ts';
import { readCreateMemberForm } from '../_entities/member/request.ts';
import { photoFromFiles } from '../_entities/member/rules.ts';
import { memberServiceFor } from '../_entities/member/service.ts';

defineFunction(
  { name: 'create-member', level: 'active', schema: createMemberRequest, reader: readCreateMemberForm },
  async ({ admin, caller, body, files }) => {
    return json(await memberServiceFor(admin).create(caller.id, body, photoFromFiles(files)), 201);
  },
);
