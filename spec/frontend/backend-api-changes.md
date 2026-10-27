# Updating the frontend for the fitfine backend

The backend in `supabase/` is the `fitfine` schema: tables, views and functions moved out of
`public`, access enforced by RLS and by SECURITY DEFINER functions, and Edge Functions rebuilt on a
shared structure ([../backend/edge-function-structure.md](../backend/edge-function-structure.md)).
This page lists what the frontend has to change to talk to it, and what it will notice. Names of
tables, views, RPCs and Edge Functions did not change, so most repositories keep their queries.

Status: everything on this page that is code is in the frontend. What is left is operational: the
security headers checked on a Vercel preview, the CSP narrowed to the final project's origin at cutover
(section 9), and every active user holding a role (section 7).

---

## 1. Point the client at the `fitfine` schema

The Data API exposes only `fitfine`. Without this option every `.from()` and `.rpc()` call goes to
`public` and fails.

```ts
// frontend/src/lib/supabase-client.ts
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: 'fitfine' },
  global: { fetch: authAwareFetch },
});
```

supabase-js then sends `Accept-Profile: fitfine` on reads and `Content-Profile: fitfine` on writes.
URLs stay `/rest/v1/<name>`. Storage (`member-photos`) and Edge Function calls are not affected by
this option.

What the repositories call, all unchanged by name:

| Repository / helper | Tables and views | RPC / Storage |
|---|---|---|
| `member.repository.ts` | `members` (read, edit) | Edge Functions: `create-member`, `delete-member`, `purge-member` |
| `member-list.repository.ts` | `member_list_view` | |
| `subscription.repository.ts` | `subscriptions`, `subscription_items`, `member_current_items` | Edge Functions: `create-subscription`, `update-subscription` |
| `report.repository.ts` | `members`, `plans`, `subscriptions`, `subscription_items` | |
| `plan.repository.ts` / `branch.repository.ts` / `role.repository.ts` | `plans` / `branches` / `roles` | `delete-plan` / `delete-branch` / `delete-role` |
| `profile.repository.ts` | `profiles`, `profiles_with_roles` | `list-users`, `invite-user`, `update-user` |
| `member-numbering.repository.ts` | `branches`, `configuration`, `member_number_sequences` | `rpc('update_member_number_config')`, `update-member-number-sequence` |
| `audit-log.repository.ts` | `audit_log`, `profiles` | |
| `lib/photo-urls.ts`, `member.service.ts` (`uploadPhoto`) | | Storage `member-photos` |

## 2. Edge Function errors: switch on `code`

Every function answers an error as `{ error, code? }`. `error` is for a person and may change;
`code` is stable. Use `toEdgeFunctionError()` in the repository and check `err.code` in the page
(`lib/edge-function-error.ts`). Never match on the message text.

| Status | Meaning | Handle as |
|---|---|---|
| 400 | a field failed validation (message names it), or a bad reference | inline error |
| 401 | missing or expired session | already handled: `authAwareFetch` signs the user out |
| 403 | the caller's access is too low | "not allowed" message |
| 404 | the row is missing or already deleted (deletes used to succeed silently) | refresh the list |
| 409 | in use, or a conflict (duplicate phone, last admin, shared member) | show the message |
| 413 | body too large (JSON over 64 KiB; create-member over 6.1 MiB) | "file too large" |
| 415 | `create-member` was not sent as multipart | a client bug |
| 500 | anything unexpected: always "Something went wrong — please try again" | generic error; database text never arrives |

Codes defined so far (`supabase/functions/_entities/member/errors.ts`): `MEMBER_NOT_FOUND`,
`MEMBER_IN_USE`, `MEMBER_IS_SHARED_PARTNER`, `MEMBER_PHONE_IN_USE`, `MEMBER_INVALID_REFERENCE`.
Other functions return `{ error }` without a code until their entity is moved to the same structure.
`EdgeFunctionError` also carries the HTTP `status`. Pages use `isNotFound()` (a 404 delete closes the
dialog and reloads, or leaves Member Detail as a successful delete would) and `refusalMessage()` (the
function's own message for a 400/403/409/413; a 500 shows the page's generic wording). Read-only calls
(`list-users`) and `create-subscription` still use `extractFunctionErrorMessage`.

Direct writes throw a `DbError` (`lib/db-error.ts`) with the SQLSTATE and the constraint name. Pages
switch on `23505` (duplicate) and `23514` (a CHECK, shown on its field), never on the message:
`chk_branches_code_format` contains "code" exactly as a duplicate code does.

## 3. Registering a member: `create-member` (done)

One `multipart/form-data` request instead of an insert, two uploads and an update:

- parts: `member` (JSON of `NewMember`), and optionally `original` + `thumbnail` (both or neither);
- answer: `201 { member, photo_error }`, where `photo_error` is `null` or `"PHOTO_UPLOAD_FAILED"`.
  The member is saved even when the photo is not (REQ-MEM-004);
- refusals: 409 `MEMBER_PHONE_IN_USE`, 400 `MEMBER_INVALID_REFERENCE`, 400 for a bad field.

Implemented in `member.repository.ts` (`create`), `member.service.ts` (`create`) and
`AddMemberPage.tsx`. Details: [../backend/edge-functions.md](../backend/edge-functions.md) §2.

## 4. The client RPC now refuses instead of doing nothing

`rpc('update_member_number_config', …)` used to report success for a non-admin and change nothing.
It now fails: HTTP 403 for a non-admin, 400 when a value is not a positive integer. Show the error
instead of the "Saved" message.

## 5. Form rules must match the database

Direct writes (`members` edit, `plans`, `branches`, `roles`, `subscriptions` notes, `profiles`) hit
CHECK constraints. A violation returns PostgREST error code `23514` naming the constraint. Make the
forms check the same rules first, so the constraint is never the first line of feedback, and show a
`23514` that still arrives as a field error, not as raw text.

| Field | Rule |
|---|---|
| member `name`, `emergency_contact_name`, `occupation`; profile `full_name`; branch, plan and role `name` | at most 80 characters, not blank |
| member `emergency_contact_relationship` | at most 40 characters |
| member `residential_address`, role `description` | at most 500 characters (line breaks allowed in the address) |
| member `doctor_care_details` | at most 1000 characters; required, not blank, when under doctor's care |
| subscription `notes` | at most 200 characters |
| member `phone`, `emergency_contact_phone` | exactly 10 digits (strip spaces first, as today) |
| member `pincode` | exactly 6 digits |
| member `aadhaar_number` | exactly 12 digits (strip spaces like phone). **New rule: the form doesn't check it yet** |
| member `email` | at most 254 characters, `x@y.z` shape |
| branch `code` | 1 to 10 letters or digits; no `-`, spaces or wildcards |
| any of the text fields above | no control or bidirectional-override characters. Strip them in the service before writing, the way the Edge Functions' `validate.ts` does |

Characters are counted as the database counts them (code points), so use `Array.from(s).length`
rather than `s.length` for the limits.

## 6. Storage: `member-photos`

- Private bucket: show photos through signed URLs (`lib/photo-urls.ts`, unchanged).
- Writes are accepted only at `<member_id>/original-<timestamp>.jpg` and
  `<member_id>/thumbnail-<timestamp>.jpg`. `uploadPhoto` already uses this shape. Any other path is refused.
- jpeg, png or webp, at most 5 MiB. SVG is refused.
- Deleting a photo now really deletes it (it used to be refused silently).

## 7. Access changes the app will notice

- **Anonymous requests get nothing.** Every table, view and function needs a signed-in, active user.
- **A user with no role has no access**, even when the profile is active. The app shows them nothing
  after sign-in. Before cutover, give every active user a role (`run.sh --validate-backend` lists
  any without one).
- **An uninvited sign-in (password or Google) gets no profile**, as today; the existing sign-out stays.
- **The views follow RLS:** a deactivated user's still-valid token stops returning data.
- **Clients can't write** `deleted_at`, `deleted_by`, `member_number`, `created_by` or the photo
  paths on create. Soft deletes go through the Edge Functions. Nothing in the app writes them directly today.

## 8. Tests

Per CLAUDE.md, every changed repository, service and page ships its Vitest test, and the flows get
Playwright coverage in a desktop and a mobile project.

- `e2e/fixtures/supabase-mock.ts`: assert that PostgREST requests carry `Accept-Profile: fitfine`
  (reads) and `Content-Profile: fitfine` (writes), so a missing `db.schema` fails the suite.
- Add the new error answers to the mock where pages handle them (404, 403, generic 500, 413).
- A Vitest source scan: fail on `.or(`, `.filter(`, `.not(`, `.like(`, `.ilike(` or `.textSearch(`
  with an argument built from a template literal or concatenation under `frontend/src` (the Edge
  Functions already have this: `supabase/functions/_tests/source-scan.test.ts`).

## 9. Deploying the frontend

- Until cutover, production keeps pointing at the old project. Don't redeploy production from `main`:
  `main` now calls `create-member`, which exists only on the new backend.
- Test on a Vercel preview with `VITE_SUPABASE_URL=https://<final-ref>.supabase.co` and the final
  project's anon key (never the service-role key).
- Add browser security headers in `frontend/vercel.json`: `Content-Security-Policy` (`default-src 'self'`;
  `connect-src` and `img-src` limited to the project's Supabase origin, `img-src` also `blob:`;
  `object-src 'none'`; `base-uri 'self'`; `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`. Check them on the preview: `vite preview` doesn't send them.
- At cutover: switch the production env vars to the final project, then revoke the old project's keys.

## Checklist

- [x] `create-member` request, response and error code (section 3)
- [x] `EdgeFunctionError` with `code` (section 2)
- [x] `db: { schema: 'fitfine' }` in `lib/supabase-client.ts` (section 1)
- [x] mock asserts the `fitfine` profile headers (section 8)
- [x] error handling for 404, 403, 413 and the generic 500 where pages need it (section 2)
- [x] `update_member_number_config` errors shown (section 4)
- [x] form rules match the constraints, including Aadhaar; unsafe characters stripped; `23514` as a field error (section 5) — `lib/text-rules.ts`
- [x] frontend source scan (section 8) — `repositories/postgrest-filters.test.ts`
- [ ] security headers in `vercel.json` (done; CSP allows `https://*.supabase.co` until the final origin is known), checked on a preview (section 9)
- [ ] every active user holds a role (section 7)
