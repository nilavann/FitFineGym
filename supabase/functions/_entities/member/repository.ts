// All of the member entity's database access (the service role, through the fitfine API
// functions). No rules here and no HTTP: it names the RPCs and their parameters, attaches the
// entity's error codes to a refusal, and checks the shape of what comes back.
import type { Client } from '../../_shared/clients.ts';
import { rpcError } from '../../_shared/errors.ts';
import type { CreateMemberRequest, DeleteResult, MemberRow, PhotoPaths } from './dto.ts';
import { MEMBER_ERRORS } from './errors.ts';

export interface MemberRepository {
  /** Registers a member, attributed to the caller. 400 / 409 as in MEMBER_ERRORS.create. */
  create(callerId: string, input: CreateMemberRequest): Promise<MemberRow>;
  /** Stores the photo paths on the member. 404 as in MEMBER_ERRORS.setPhoto. */
  setPhoto(callerId: string, memberId: number, paths: PhotoPaths): Promise<void>;
  /** Guarded delete, attributed to the caller. 404 / 409 as in MEMBER_ERRORS.delete. */
  delete(callerId: string, memberId: number): Promise<DeleteResult>;
}

export function memberRepository(admin: Client): MemberRepository {
  return {
    async create(callerId, input) {
      const { data, error } = await admin.rpc('create_member', { p_caller_id: callerId, p_member: input });
      rpcError(error, MEMBER_ERRORS.create);
      const row = data as Partial<MemberRow> | null;
      if (!row || typeof row.id !== 'number' || typeof row.member_number !== 'string') {
        throw new Error('create_member returned no member row');
      }
      return row as MemberRow;
    },

    async setPhoto(callerId, memberId, paths) {
      const { error } = await admin.rpc('set_member_photo', {
        p_caller_id: callerId,
        p_member_id: memberId,
        p_photo_url: paths.original,
        p_thumbnail_url: paths.thumbnail,
      });
      rpcError(error, MEMBER_ERRORS.setPhoto);
    },

    async delete(callerId, memberId) {
      const { data, error } = await admin.rpc('delete_member', { p_caller_id: callerId, p_id: memberId });
      rpcError(error, MEMBER_ERRORS.delete);
      const result = (data ?? {}) as Partial<DeleteResult>;
      return { photo_paths: result.photo_paths ?? [] };
    },
  };
}
