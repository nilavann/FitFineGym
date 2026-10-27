// The member photo bucket. A replaced photo leaves its old files behind, so a member's photos are
// everything under their folder, not just the two paths on the row.
import type { Client } from '../../_shared/clients.ts';
import type { MemberPhoto, PhotoPaths } from './dto.ts';
import { onlyInPhotoFolder, photoFolder, photoPaths } from './rules.ts';

export const PHOTO_BUCKET = 'member-photos';
const PAGE_SIZE = 100;

export interface PhotoCleanup {
  /** false when listing or removing failed; some photos may then remain. */
  removed: boolean;
  /** The paths found (and, when `removed`, deleted). */
  paths: string[];
  error?: unknown;
}

export interface MemberPhotoStorage {
  /**
   * Stores the original and the thumbnail under the member's folder, at paths built here. If
   * either upload fails, the one that landed is removed and the error is thrown: a failed upload
   * leaves no orphan.
   */
  upload(memberId: number, photo: MemberPhoto): Promise<PhotoPaths>;
  /** Removes these objects. Throws if the bucket refuses. */
  remove(paths: string[]): Promise<void>;
  /** Removes every photo of the member. Never throws: a storage failure comes back as a result. */
  removeAll(memberId: number, knownPaths: string[]): Promise<PhotoCleanup>;
}

export function memberPhotoStorage(admin: Client, now: () => number = Date.now): MemberPhotoStorage {
  const bucket = admin.storage.from(PHOTO_BUCKET);

  async function remove(paths: string[]) {
    const { error } = await bucket.remove(paths);
    if (error) throw error;
  }

  return {
    async upload(memberId, photo) {
      const paths = photoPaths(memberId, now());
      const [original, thumbnail] = await Promise.all([
        bucket.upload(paths.original, photo.original, { contentType: photo.original.type, upsert: false }),
        bucket.upload(paths.thumbnail, photo.thumbnail, { contentType: photo.thumbnail.type, upsert: false }),
      ]);
      const failure = original.error ?? thumbnail.error;
      if (failure) {
        const landed = [original.error ? [] : [paths.original], thumbnail.error ? [] : [paths.thumbnail]].flat();
        if (landed.length > 0) await remove(landed).catch(() => {});
        throw failure;
      }
      return paths;
    },

    remove,

    async removeAll(memberId, knownPaths) {
      const folder = photoFolder(memberId);
      const found = new Set(onlyInPhotoFolder(memberId, knownPaths));
      try {
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const { data: files, error } = await bucket.list(folder, { limit: PAGE_SIZE, offset });
          if (error) throw error;
          for (const file of files ?? []) found.add(`${folder}/${file.name}`);
          if (!files || files.length < PAGE_SIZE) break;
        }
        const paths = onlyInPhotoFolder(memberId, found);
        if (paths.length > 0) await remove(paths);
        return { removed: true, paths };
      } catch (error) {
        return { removed: false, paths: [...found], error };
      }
    },
  };
}
