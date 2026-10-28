// How create-member reads its request: multipart/form-data with the member as JSON in the `member`
// part and, optionally, the photo as `original` and `thumbnail` files. This is HTTP, not domain:
// it turns the form into the data the schema checks and the files the service stores, and refuses
// a malformed form with a 400 before anything is written. defineFunction runs it after the access
// check.
import type { BodyReader } from '../../_shared/define-function.ts';
import { HttpError, parseJsonObject, readMultipart } from '../../_shared/http.ts';
import { MAX_PHOTO_BYTES, MAX_THUMBNAIL_BYTES, photoProblem } from './rules.ts';

/** The photo, its thumbnail and the member JSON, plus room for the multipart framing. */
export const MAX_FORM_BYTES = MAX_PHOTO_BYTES + MAX_THUMBNAIL_BYTES + 128 * 1024;

export const readCreateMemberForm: BodyReader = async (req) => {
  const { fields, files } = await readMultipart(req, {
    maxBytes: MAX_FORM_BYTES,
    fields: ['member'],
    files: ['original', 'thumbnail'],
  });

  if (fields.member === undefined) throw new HttpError(400, 'member is required');
  const data = parseJsonObject(fields.member, 'member');

  if (Boolean(files.original) !== Boolean(files.thumbnail)) {
    throw new HttpError(400, 'original and thumbnail must be sent together');
  }
  for (const [part, max] of [['original', MAX_PHOTO_BYTES], ['thumbnail', MAX_THUMBNAIL_BYTES]] as const) {
    const problem = files[part] && photoProblem(files[part], max);
    if (problem) throw new HttpError(400, `${part} ${problem}`);
  }

  return { data, files };
};
