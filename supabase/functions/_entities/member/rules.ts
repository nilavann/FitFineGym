// Pure member rules: no I/O, so they are tested without a client.
import type { MemberPhoto, PhotoPaths } from './dto.ts';

/** Photos are stored as `<member_id>/(original|thumbnail)-<ts>.jpg`: one folder per member. */
export function photoFolder(memberId: number): string {
  return String(memberId);
}

export function isInPhotoFolder(memberId: number, path: string): boolean {
  return path.startsWith(`${photoFolder(memberId)}/`);
}

/**
 * Only objects under `<member_id>/` are ever removed, even if purge_member returned another
 * path (F29). Duplicates are dropped.
 */
export function onlyInPhotoFolder(memberId: number, paths: Iterable<string>): string[] {
  return [...new Set(paths)].flatMap((p) => (isInPhotoFolder(memberId, p) ? [p] : []));
}

/**
 * The paths a member's photo is stored at. Built here, from the member id and a timestamp, never
 * taken from the request: they have to match the storage policies' path rule and
 * chk_members_photo_url_path (`<member_id>/original-<digits>.jpg`).
 */
export function photoPaths(memberId: number, timestamp: number): PhotoPaths {
  const folder = photoFolder(memberId);
  return { original: `${folder}/original-${timestamp}.jpg`, thumbnail: `${folder}/thumbnail-${timestamp}.jpg` };
}

// The bucket's own limits (supabase/migrations/..._storage.sql): 5 MiB and these three types.
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** The thumbnail is compressed in the browser to about 50 KB; this is a ceiling, not a target. */
export const MAX_THUMBNAIL_BYTES = 1024 * 1024;
export const PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** Why an uploaded photo part is not acceptable, or null. `max` is that part's size limit in bytes. */
export function photoProblem(file: File, max: number): string | null {
  if (!PHOTO_TYPES.includes(file.type)) return `must be an image (${PHOTO_TYPES.join(', ')})`;
  if (file.size === 0) return 'must not be empty';
  if (file.size > max) return `must be at most ${Math.floor(max / 1024)} KiB`;
  return null;
}

/** The photo from the request's file parts: both parts, or neither. A lone one is a mistake. */
export function photoFromFiles(files: Record<string, File>): MemberPhoto | null {
  const { original, thumbnail } = files;
  if (!original && !thumbnail) return null;
  if (!original || !thumbnail) {
    throw new Error('photoFromFiles: both photo parts or neither (the reader checks this first)');
  }
  return { original, thumbnail };
}
