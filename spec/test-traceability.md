# Requirements → Implementation → Test Traceability

> Maps each requirement in [requirements-template.md](./requirements-template.md) (functional requirements, Section 10 non-functional requirements, Section 11 constraints) to its implementation and the tests that cover it, edge cases included.
>
> **Status key:** ✅ implemented and tested · ⚠️ implemented with a gap (listed under [Known gaps](#known-gaps)) · 🚫 deliberately out of scope, deferred, or retired · 🔎 cannot be verified from the repo (external config) · 📝 specified but not yet implemented

## How to run

| Layer | Command | Needs | What it covers |
|---|---|---|---|
| Frontend (vitest, jsdom, Testing Library) | `npm run test:frontend` | `npm install` | pure logic, services, repositories, auth context, and every page rendered against fake services |
| Edge Functions (Deno) | `npm run test:functions` | [Deno](https://deno.com) 2.x on `PATH` | all 12 functions' auth gates, validation, guards and payload shaping, with `@supabase/supabase-js` swapped for a scriptable fake |
| Database | `npm run test:db` | `psql` + a local Postgres superuser | the **real migrations** applied to a throwaway DB (Supabase `auth`/`storage`/roles stubbed), then SQL assertions on constraints, triggers, RLS, RPCs, views, storage and the audit log |
| Everything | `npm test` | all of the above | |

Last full run **2026-10-28**: **1,053** frontend tests (Vitest), **417** database checks, and **479** Playwright tests passed (desktop Chrome, Pixel 7, iPhone 13; 37 device-conditional skips, 0 failed). The Edge Function (Deno) suite is maintained alongside the code but was not re-run in that pass.

---

## Member Management (§2)

| Req | Status | Implementation | Tests (edge cases covered) |
|---|---|---|---|
| MEM-001 register member | ✅ | `member.service.ts` validation, `AddMemberPage`, `members` constraints | `member.service.test.ts` (each required field, name 2–80, phone exactly 10 digits/spaces ignored, weight 1–500 & height 1–300 boundaries, email optional-but-valid, doctor-care Yes+blank/whitespace/ok, No+stale text), `AddMemberPage.test.tsx` (empty form names every missing field, today pre-filled, edited date saved, duplicate phone message, network failure keeps form, digits-only phone), `10_members.test.sql` (NOT NULL/CHECK per field, boundaries, whitespace doctor details) |
| MEM-001 phone unique | ✅ | unique index `idx_members_phone` | SQL: duplicate on create, on edit, own phone OK, reuse after the member is deleted, blocked again once reused |
| MEM-002 camera capture | ✅ | `CameraCaptureModal` | denied camera → message pointing to Upload; no `getUserMedia`; stream released on close; captured frame is a JPEG `File` fed to the same pipeline |
| MEM-003 created_by / handled_by | ✅ | `set_audit_fields()`, `handled_by_staff` | SQL: forged `created_by` ignored on insert and update, `handled_by_staff` independent and FK-checked; page tests: default = logged-in user, changeable before submit and later from member page, `null` clears |
| MEM-004 compression + both files stored | ✅ / ⚠️ | `photo-compression.ts`, `member.service.uploadPhoto` | 400px longest side (landscape/portrait/small/exact), quality ladder to <50KB, floor instead of infinite loop, no-canvas & encode failure; both original and thumbnail uploaded, compress-before-upload order, half-failed upload cleaned up, path-save failure cleans up, member kept on any photo failure. ⚠️ the failure message is only `console.warn`ed at registration (see Known gaps) |
| MEM-005 member number | ✅ | `generate_member_number()` | SQL: format `<code>-<year>-<seq>`, per-branch counters, never resets (no `year` key), continues from stored counter, client-supplied number overwritten, failed insert burns no number, inactive branch rejected; Deno: `update-member-number-sequence` skips numbers used in any year, honours increment, rejects bad input/misconfig |
| MEM-006 edit; number/created_by/branch immutable | ✅ | trigger pins `member_number` & `branch_id`; update payload omits them | SQL: forged `branch_id`/`member_number` silently pinned while other fields in the same UPDATE apply, update never bumps sequence; service: update payload has none of the three; page: no inputs for them, branch shown read-only |
| MEM-007 delete member | ✅ | `delete-member` function, `delete_member()`; `memberRepository.delete`; delete dialog on `MemberDetailPage` | SQL: refused while a subscription item names the member as member or shared member (409), missing → 404, inactive caller refused, row really gone, last values in the audit log naming the caller, photo paths returned, a checkout deleted first frees the member; Deno: photos under `<member_id>/` removed, nothing outside it, storage failure still 200 with `photos_removed: false`, 404/409 carry `MEMBER_NOT_FOUND` / `MEMBER_IN_USE`; page: confirm/cancel, guard text shown verbatim, offline message; Playwright: delete-member payload, refusal, offline |

## Member List (§3)

| Req | Status | Implementation | Tests |
|---|---|---|---|
| LIST-001 default sort, extra sorts | ✅ | `lib/member-list-filters.ts` (extracted from `MembersListPage` unchanged) | join date DESC default (ties, month boundaries), name, expiry with indefinite/none last, input not mutated, search/filters never change default order; page test through the real DOM |
| LIST-002 search | ✅ | `matchesSearch` | name / member number / phone substring, case-insensitive, spaces ignored in phone, trimmed query, empty query, no-match empty state + Clear |
| LIST-003 status pills | ✅ | `lib/status.ts` `deriveStatus` | exactly 7 days = Expiring, 8 = Active, ends today = Expiring, yesterday = Expired, NULL end = Active, no membership = Expired, month/year/leap-day boundaries, **local-date** rule; pill counts; single-select |
| LIST-004 filter panel | ✅ | `filterBeforeStatus`, `member_list_view` | gender OR within group, add-on any-of current add-ons, plan = current membership, AND across groups + pill + search, members without a plan never match a plan filter |
| LIST-* data source | ✅ | `member_current_items`, `member_list_view` | SQL: item ending today is current, expired excluded, latest `end_date` wins, indefinite outranks dated, a deleted checkout's items are gone, add-on ids only add-ons, one row per member |

## Subscriptions (§4)

| Req | Status | Implementation | Tests |
|---|---|---|---|
| SUB-001 checkout | ✅ | `RenewSubscriptionPage`, `create-subscription`, `create_subscription_with_items` | exactly-one-membership (0, 2, +add-ons) at service, page, Deno and (indirectly) DB level; defaults (today, price×qty); one RPC call carries header+all items; **atomicity** — bad second item, unknown plan, negative amount all leave no orphan header |
| SUB-002 payment mode | ✅ | header `payment_mode` check | Cash/UPI/Card only, default Cash, one value per checkout |
| SUB-003 add-ons itemised | ✅ | one row per item | separate `amount_paid` per item in UI total and DB |
| SUB-004 shared member | ⚠️ | server + DB ✅ (couple plans only, ≠ primary, never on add-ons) | Deno/SQL tests pass; **UI never offers the picker** (`shared_member_id: null` hard-coded) — see Known gaps |
| SUB-005 membership overlap warning | ⚠️ | `findItemOverlap` | inclusive date ranges, indefinite = open-ended, quantity extends range, "Save anyway" keeps payload unchanged, Cancel reverts date; ⚠️ only same-plan overlaps warn — see Known gaps |
| SUB-006 duration / indefinite | ✅ | `plans.duration_days` | NULL end_date, quantity forced to 1, chips hidden, "Never expires" |
| SUB-007 indefinite hard block | ⚠️ | RPC check | blocks repeat, blocks inside one checkout (rolled back), other members unaffected, a deleted checkout no longer blocks, 409 mapping, no separate pre-check; ⚠️ not atomic across concurrent sessions — see Known gaps |
| SUB-008 add-on overlap | ✅ | same function | same add-on warns, different add-on / membership doesn't |
| SUB-009 quantity | ✅ | `previewEndDate`, server end_date | x1/x2/x3/x6/x12 + custom (clamped 1–60 in UI), 0/negative/fractional rejected, `end = start + days×qty − 1` incl. leap years and year ends, amount = price × qty, no discount |
| SUB-010/011 | 🚫 deferred | — | SQL asserts no cancellation/refund/overlap columns exist (no scope creep) |
| SUB-012 status from multiple checkouts | ✅ | `member_list_view` | SQL (multiple items/checkouts resolve to one current membership) |

## Reporting (§6) · Auth (§7) · Audit (§8) · Admin (§9)

| Req | Status | Tests |
|---|---|---|
| REPORT-001 charts / ranges | ✅ | default 1st-of-month→today, Today/This week/Custom, start>end rejected, **one bar per calendar month** incl. empty months & year boundary, bucketed by `start_date`, add-ons separate, payment-mode totals fixed order |
| REPORT-002 transaction list | ✅ | one row per item (renewal + add-ons stay separate), exact column set, type label, payment mode from the checkout, newest first, empty state, retry |
| AUTH-001 password sign-in | ✅ | disabled until filled, generic "Wrong email or password." (no enumeration), password cleared, timeout message |
| AUTH-002/004 Google, one account | ✅ in code / 🔎 provider config | OAuth start + failure, redirect to bare origin; same profile resolution for any method. Google provider/credentials must be configured in the Supabase dashboard — cannot be checked here |
| AUTH-003 invite-only | ✅ | `AuthProvider`: no profile → "not invited" + signed out, one retry absorbs the invite-trigger race, deactivated → distinct message, **fetch failure ≠ not invited**, re-validation on tab focus, mid-session 401, expired-link error surfaced |
| AUTH-005 password reset | ✅ | generic confirmation whether or not the request errors, recovery session confined to `/reset-password`, ≥6 chars + match, expired link message |
| AUDIT-001 field-level audit | ✅ | insert = one row per column, update = one row per *changed* field sharing a `change_id`, no-op writes nothing, metadata columns excluded, a delete = one `delete` row per column with the last values, trigger on all 6 required tables (+roles, user_roles), `changed_by` = acting user, append-only & admin-only |
| ADMIN-001 admin-only screens | ✅ | `RequireAdmin` (admin / multi-role / no role / no profile), staff nav hides Settings, RLS: staff can read but not write plans/branches/roles/config |
| ADMIN-002 plans | ✅ | membership needs duration, add-on may be indefinite, price ≥ 0 (0 ok), duration ≥ 1, name unique among live rows, **edit doesn't change past items**, delete guard "used by X" |
| ADMIN-003 branches | ✅ ⚠️ | blank name/code, duplicate code, code reusable after the branch is deleted, delete guard "used by X member(s)", counter row deleted with the branch; ⚠️ a name of only non-breaking spaces passes the DB blank-check (see Known gaps) |
| ADMIN-004 users | ✅ | list/status, self-protection (UI disabled + server 403), last-admin guard on deactivate/demote, multi-role edit, invite via function (409 duplicate email, roles validated), the "at least one role" error shown on the edit form |
| ADMIN-005 audit overview | ✅ | filters (table, record, dates, user), inverted range rejected, 500-row cap flagged, **no edit/delete control anywhere**, local-day boundaries |
| MEM-008 permanent member delete | 🚫 retired | replaced by REQ-MEM-007 (a real delete behind the usage guard) and REQ-SUB-013 | `purge-member`, `purge_member()` and the "Delete permanently" dialog were removed; a Vitest test asserts no role is offered a separate permanent delete |
| ADMIN-010 `system_admin` role | 🚫 retired | the role, `protect_system_admin_role()`, the `is_system_admin` access flag and every guard on the role name were removed (migration `20261028000200`) | SQL: no such role, attribute or function exists; a holder keeps `admin`. Deno: asking `invite-user` for it is an unknown role (400) |
| ADMIN-006 delete user | 🚫 retired | users are never deleted, only deactivated | SQL: `prevent_hard_delete` refuses a `DELETE` on `profiles`, no `soft_delete_profile` / `restore_profile`; Deno: `update-user` rejects `delete` / `restore` (400), `list-users` takes no fields; Vitest + Playwright: no Delete / Restore / "Show deleted" control on Manage Users |
| SUB-013 delete a checkout | ✅ | `delete-subscription` function, `delete_subscription()`; `subscriptionRepository.delete`; Delete + dialog in Subscription History | SQL: 404 for a missing id, inactive caller refused, header and every item removed, audit rows name the caller, the member can then be deleted; Deno: payload, 404 and refusal keep their message; page: confirm/cancel, 404 refreshes, offline / refusal / generic messages; Playwright: calls `delete-subscription`, history empties |

## Non-functional (§10) and constraints (§11)

| Item | Status | Evidence |
|---|---|---|
| Member list < 1s for ~2,000 members | ✅ | DB: `member_list_view` over 2,000 members ≈ 10 ms; client filter+sort over 2,000 rows < 100 ms (tests assert the budgets) |
| Security: every write role-checked server-side | ✅ | RLS write policies and Edge Function gates verified (non-admin 403 before any table access, deactivated/never-invited callers refused, no direct client insert on `subscriptions`/`subscription_items`); the views are `security_invoker`, every privileged RPC is revoked from `anon`/`authenticated` and granted by name | SQL access matrix (every role × every table and function), regression tests; Deno auth gates |
| Auditability / guarded real deletes | ✅ | every business table has the audit columns; the audit trigger records inserts, updates and deletes; clients hold no `DELETE` grant; `prevent_hard_delete` protects `profiles` and `audit_log` (checked structurally and by attempting deletes) |
| Members have no login; single tenant; no payment gateway; branch not an access boundary | ✅ | RLS never references `branch_id`; no member auth path exists |

---

## Known gaps

Requirements the code does not yet fully meet. None is hidden behind a skipped test.

| Requirement | Gap | Where |
|---|---|---|
| REQ-SUB-004 (Must) | The checkout has no shared-member picker: the UI always sends `shared_member_id: null`, so a couple plan can never record its second member (the backend supports it). | `RenewSubscriptionPage.tsx` |
| REQ-SUB-005 | The membership overlap warning only fires for the *same plan*; the requirement says any overlapping membership item conflicts, whatever its plan. | `subscription.service.ts` `findItemOverlap` |
| REQ-SUB-007 | Two concurrent checkouts can both attach the same indefinite plan: the check inside `create_subscription_with_items` is not atomic under READ COMMITTED. Fix: a `pg_advisory_xact_lock` on (plan, member) before the check. | `20261027000800_fitfine_api_functions.sql` |
| REQ-MEM-004 | A photo that fails to upload at registration is only `console.warn`ed; staff are not told. | `AddMemberPage.tsx` |
| REQ-MEM-001 / ADMIN-002/003 | The database's blank-name check treats a value of only non-breaking spaces as non-blank (tabs, newlines and other control characters are rejected). | `20261027000200_fitfine_constraints.sql` |

### Observations not turned into tests
- Google OAuth provider setup and the project's Redirect URLs / Site URL (AUTH-002/005) are dashboard settings (README §10.3).
- Storage-bucket policies are applied in the test database, but signed-URL behaviour itself needs a real Storage service.
