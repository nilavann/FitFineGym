// The member use cases: what the member functions do, apart from HTTP and from SQL. It depends on
// the repository and the photo storage as interfaces, so a test hands it fakes.
import type { Client } from '../../_shared/clients.ts';
import type {
  CreateMemberRequest, CreateMemberResponse, DeleteMemberResponse, MemberPhoto,
} from './dto.ts';
import { toMemberResponse } from './mapper.ts';
import { type MemberPhotoStorage, memberPhotoStorage } from './photo-storage.ts';
import { type MemberRepository, memberRepository } from './repository.ts';

export interface MemberService {
  create(callerId: string, input: CreateMemberRequest, photo: MemberPhoto | null): Promise<CreateMemberResponse>;
  delete(callerId: string, memberId: number): Promise<DeleteMemberResponse>;
}

interface Deps {
  repo: MemberRepository;
  photos: MemberPhotoStorage;
  log?: (...args: unknown[]) => void;
}

export function createMemberService({ repo, photos, log = console.error }: Deps): MemberService {
  return {
    // The member is registered first and kept whatever happens to the photo (REQ-MEM-004): a photo
    // that can't be stored is reported as `photo_error`, never as a failed request, because the
    // member exists and a retry of the whole request would only meet its own phone number.
    async create(callerId, input, photo) {
      const row = await repo.create(callerId, input);
      if (!photo) return { member: toMemberResponse(row), photo_error: null };

      try {
        const paths = await photos.upload(row.id, photo);
        try {
          await repo.setPhoto(callerId, row.id, paths);
        } catch (error) {
          await photos.remove([paths.original, paths.thumbnail]).catch(() => {});
          throw error;
        }
        return { member: toMemberResponse(row, paths), photo_error: null };
      } catch (error) {
        log('create-member: member', row.id, 'saved but the photo was not stored:', error);
        return { member: toMemberResponse(row), photo_error: 'PHOTO_UPLOAD_FAILED' };
      }
    },

    // The row is gone and can't be restored, so a storage failure is logged and reported, never
    // turned into an error: a retry would only find no member.
    async delete(callerId, memberId) {
      const deleted = await repo.delete(callerId, memberId);
      const cleanup = await photos.removeAll(memberId, deleted.photo_paths);
      if (!cleanup.removed) {
        log('delete-member: member', memberId, 'deleted but photos were not (fully) removed:', cleanup.paths, cleanup.error);
      }
      return { success: true, photos_removed: cleanup.removed };
    },
  };
}

/** The service wired to a Supabase client: what the Edge Functions use. */
export function memberServiceFor(admin: Client): MemberService {
  return createMemberService({ repo: memberRepository(admin), photos: memberPhotoStorage(admin) });
}
