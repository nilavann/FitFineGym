// The member entity's error codes: the `code` of each refusal an RPC can raise, by status. The
// message comes from the database and is for a person; the client switches on the code.
import type { RpcStatus } from '../../_shared/errors.ts';

export type MemberErrorCode =
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_IN_USE'
  | 'MEMBER_PHONE_IN_USE'
  | 'MEMBER_INVALID_REFERENCE';

export const MEMBER_ERRORS = {
  /** create_member: 400 branch_id / handled_by_staff names nothing active; 409 phone already used by a live member. */
  create: { 400: 'MEMBER_INVALID_REFERENCE', 409: 'MEMBER_PHONE_IN_USE' },
  /** set_member_photo: 404 the member does not exist. */
  setPhoto: { 404: 'MEMBER_NOT_FOUND' },
  /** delete_member: 404 missing or already deleted; 409 subscription items use it (as member or shared member). */
  delete: { 404: 'MEMBER_NOT_FOUND', 409: 'MEMBER_IN_USE' },
} as const satisfies Record<string, Partial<Record<RpcStatus, MemberErrorCode>>>;
