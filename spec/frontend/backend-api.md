# How the frontend talks to the backend

The backend in `supabase/` is the `fitfine` schema: tables, views and functions, access enforced by
RLS and by SECURITY DEFINER functions, and Edge Functions built on a shared structure
([../backend/edge-function-structure.md](../backend/edge-function-structure.md)). This page is the
contract the frontend relies on.

---

## 1. The client uses the `fitfine` schema

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

What the repositories call:

| Repository / helper | Tables and views | RPC / Storage |
|---|---|---|
| `member.repository.ts` | `members` (read, edit) | Edge Functions: `create-member`, `delete-member` |
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
| 404 | the row is missing or already deleted | refresh the list |
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

## 3. Registering a member: `create-member`

One `multipart/form-data` request:

- parts: `member` (JSON of `NewMember`), and optionally `original` + `thumbnail` (both or neither);
- answer: `201 { member, photo_error }`, where `photo_error` is `null` or `"PHOTO_UPLOAD_FAILED"`.
  The member is saved even when the photo is not (REQ-MEM-004);
- refusals: 409 `MEMBER_PHONE_IN_USE`, 400 `MEMBER_INVALID_REFERENCE`, 400 for a bad field.

Implemented in `member.repository.ts` (`create`), `member.service.ts` (`create`) and
`AddMemberPage.tsx`. Details: [../backend/edge-functions.md](../backend/edge-functions.md) §2.

## 4. The client RPC refuses rather than doing nothing

`rpc('update_member_number_config', …)` fails with HTTP 403 for a non-admin and 400 when a value is
not a positive integer. The page shows that error instead of the "Saved" message.

## 5. Form rules match the database

Direct writes (`members` edit, `plans`, `branches`, `roles`, `subscriptions` notes, `profiles`) hit
CHECK constraints. A violation returns PostgREST error code `23514` naming the constraint. The forms
check the same rules first (`lib/text-rules.ts`), so the constraint is never the first line of
feedback, and a `23514` that still arrives is shown as a field error, not as raw text.

| Field | Rule |
|---|---|
| member `name`, `emergency_contact_name`, `occupation`; profile `full_name`; branch, plan and role `name` | at most 80 characters, not blank |
| member `emergency_contact_relationship` | at most 40 characters |
| member `residential_address`, role `description` | at most 500 characters (line breaks allowed in the address) |
| member `doctor_care_details` | at most 1000 characters; required, not blank, when under doctor's care |
| subscription `notes` | at most 200 characters |
| member `phone`, `emergency_contact_phone` | exactly 10 digits (spaces stripped first) |
| member `pincode` | exactly 6 digits |
| member `aadhaar_number` | exactly 12 digits (spaces stripped like phone) |
| member `email` | at most 254 characters, `x@y.z` shape |
| branch `code` | 1 to 10 letters or digits; no `-`, spaces or wildcards |
| any of the text fields above | no control or bidirectional-override characters. The service strips them before writing, the way the Edge Functions' `validate.ts` does |

Characters are counted as the database counts them (code points), so use `Array.from(s).length`
rather than `s.length` for the limits.

## 6. Storage: `member-photos`

- Private bucket: photos are shown through signed URLs (`lib/photo-urls.ts`).
- Writes are accepted only at `<member_id>/original-<timestamp>.jpg` and
  `<member_id>/thumbnail-<timestamp>.jpg`. `uploadPhoto` uses this shape. Any other path is refused.
- jpeg, png or webp, at most 5 MiB. SVG is refused.
- Deleting a photo really deletes it.

## 7. Access rules the app relies on

- **Anonymous requests get nothing.** Every table, view and function needs a signed-in, active user.
- **A user with no role has no access**, even when the profile is active. The app shows them nothing
  after sign-in, so every active user must hold a role.
- **An uninvited sign-in (password or Google) gets no profile**; the app signs them out.
- **The views follow RLS:** a deactivated user's still-valid token stops returning data.
- **Clients can't write** `member_number`, `created_by` or the photo paths on create, and
  can't delete anything: members, checkouts, plans, branches and roles are deleted through the
  `delete-*` Edge Functions, which run the usage guard. Users are never deleted, only deactivated.

## 8. Tests

Per CLAUDE.md, every changed repository, service and page ships its Vitest test, and the flows get
Playwright coverage in a desktop and a mobile project.

- `e2e/fixtures/supabase-mock.ts` asserts that PostgREST requests carry `Accept-Profile: fitfine`
  (reads) and `Content-Profile: fitfine` (writes), so a missing `db.schema` fails the suite.
- The mock answers 404, 403, generic 500 and 413 where pages handle them.
- `repositories/postgrest-filters.test.ts` scans `frontend/src` and fails on `.or(`, `.filter(`,
  `.not(`, `.like(`, `.ilike(` or `.textSearch(` with an argument built from a template literal or
  concatenation (the Edge Functions have the same scan: `supabase/functions/_tests/source-scan.test.ts`).

## 9. Browser security headers

`frontend/vercel.json` sends `Content-Security-Policy` (`default-src 'self'`; `connect-src` and
`img-src` limited to Supabase, `img-src` also `blob:`; `object-src 'none'`; `base-uri 'self'`;
`frame-ancestors 'none'`), `X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin`. The CSP allows `https://*.supabase.co`; narrowing
it to the project's own origin is optional hardening. `vite preview` doesn't send these headers, so
check them on a Vercel deployment.
