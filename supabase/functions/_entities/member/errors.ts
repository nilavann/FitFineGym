// The member entity's error codes: the `code` of each refusal an RPC can raise, by status. The
// message comes from the database and is for a person; the client switches on the code.
import type { RpcStatus } from '../../_shared/errors.ts';

export type MemberErrorCode =
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_IN_USE'
  | 'MEMBER_IS_SHARED_PARTNER'
  | 'MEMBER_PHONE_IN_USE'
  | 'MEMBER_INVALID_REFERENCE';

export const MEMBER_ERRORS = {
  /** create_member: 400 branch_id / handled_by_staff names nothing active; 409 phone already used by a live member. */
  create: { 400: 'MEMBER_INVALID_REFERENCE', 409: 'MEMBER_PHONE_IN_USE' },
  /** set_member_photo: 404 the member is missing or deleted. */
  setPhoto: { 404: 'MEMBER_NOT_FOUND' },
  /** soft_delete_member: 404 missing or already deleted; 409 live subscription items use it. */
  softDelete: { 404: 'MEMBER_NOT_FOUND', 409: 'MEMBER_IN_USE' },
  /** purge_member: 404 missing; 409 the member is the shared member on someone else's items. */
  purge: { 404: 'MEMBER_NOT_FOUND', 409: 'MEMBER_IS_SHARED_PARTNER' },
} as const satisfies Record<string, Partial<Record<RpcStatus, MemberErrorCode>>>;
