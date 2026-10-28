# Business Logic — Web Edition

> Part of: [SPEC-WEB.md](../../SPEC-WEB.md) | App: Fit&Fine Gym Subscription Manager (Web)
> Data model: [domain-model.md](./domain-model.md) | Schema: [database.md](./database.md) | API layer: [edge-functions.md](./edge-functions.md)

These rules are the same **product** rules as the mobile app's [spec/business-logic.md](../../spec/business-logic.md) — the gym's policies don't change because the platform changed. What changes is *where the rule is enforced*: on the web, the client cannot be trusted, so every rule that matters is enforced in a Supabase Edge Function or RLS policy (server-side) rather than only in a client-side service class.

> **Cancellation/refund and overlap-warning logic are deferred** in this revision of the domain model (Plan+AddOn unified into `plans`; Subscription+SubscriptionAddOn split into `subscriptions`/`subscription_items`). Sections below that covered that ground are kept, marked **Deferred**, for traceability — see [domain-model.md §Open items](./domain-model.md#open-items-not-blocking-but-worth-resolving-before-implementation-begins) and [requirements-template.md §13](../requirements-template.md#13-open-questions).

---

## Member Status

**Resolved** — see [requirements-template.md §13](../requirements-template.md#13-open-questions) and [member-management.md §5–6](./member-management.md#5-member_list_view--resolving-the-member-status-open-question). Previously derived from a single "latest subscription" row; under the header/line-item split, a member's current items can span multiple independent `Subscription` checkouts at once, so there is no longer one obvious "latest subscription." This is the confirmed definition:

A member's current status is derived from their `category = 'membership'` item(s) in `member_current_items` (domain-model.md §Views) — the item with the latest `end_date` among them, or "no plan" if none exist. An **indefinite** membership item (`end_date IS NULL`, e.g. a lifetime membership) outranks any dated item and is always **Active** — it never falls through to "no plan"/Expired just because it has no `end_date` to compare. The old cancellation-based fallback ("skip cancelled, use next-latest non-cancelled," REQ-SUB-013) no longer applies — there is no cancellation concept in this revision (see §Subscription Cancellation & Refund below).

| Status        | Condition                                    | Badge color |
|---------------|------------------------------------------------|-------------|
| Active        | indefinite item (`end_date IS NULL`), or `end_date >= today` AND `days_remaining > 7` | Green |
| Expiring Soon | `end_date >= today` AND `days_remaining <= 7`   | Amber       |
| Expired       | `end_date < today`, or no `category = 'membership'` item exists at all | Red |

**Formula:** `days_remaining = end_date - today` (in whole days, inclusive of end_date)

**Where computed:** Client-side, from `member_list_view` (backed by `member_current_items`, see [member-management.md](./member-management.md)) — same as before, a pure read-side presentation rule with no security implication, so it does not need server-side enforcement. Use "today" as the **browser's local date**, consistent with the Timezone Rule in [domain-model.md](./domain-model.md).

---

## Subscription End Date

**Formula:** `end_date = start_date + (plan.duration_days × quantity) - 1`, or `NULL` when `plan.duration_days IS NULL` (an indefinite item, domain-model.md §3).

One formula for every `SubscriptionItem`, membership or add-on alike — there's no longer a separate add-on formula, since both categories live in the same `plans` table and both read `duration_days` off the same column.

`quantity` defaults to `1`. Example: start_date = `2026-07-01`, duration_days = `30`, quantity = `2` → covers 60 days → end_date = `2026-08-29`.

The `-1` ensures the item covers exactly `duration_days × quantity` calendar days inclusive of the start day.

**Where computed:** Server-side only, inside the `create-subscription` Edge Function (see [edge-functions.md](./edge-functions.md)), once per item in the checkout. The client never computes or sends `end_date`.

---

## Subscription Overlap Guard (REQ-SUB-005/008)

**Resolved — client-side only, lighter than the previous design.** The old two-step flow (`overlap_override`/`overlap_conflict_subscription_id` columns, server-recorded overrides) does not exist in this revision, and isn't coming back for this — `subscription_items` carries no such columns, and `create-subscription` performs no overlap check of its own (see [edge-functions.md §3](./edge-functions.md#3-subscriptions)). Instead, the checkout form itself warns before ever calling `create-subscription`:

**Rule — what counts as a conflict:**
- **Membership items** (`plan.category = 'membership'`): a new item's `[start_date, end_date]` conflicts with **any** existing non-deleted membership item for that member, regardless of `plan_id` — a member logically has one membership at a time, so a Monthly overlapping an Annual is still a conflict.
- **Add-on items** (`plan.category = 'addon'`): a new item conflicts only with an existing item referencing the **same** `plan_id` for that member — two overlapping "Zumba Class" items conflict; a Zumba Class overlapping a Personal Training add-on does not, since holding several different add-ons concurrently is the normal case (REQ-SUB-003).
- "For that member" means as either `member_id` or `shared_member_id` — the same two-role union `member_current_items` already uses.
- An existing item with `end_date IS NULL` (indefinite) is treated as open-ended for this comparison — always overlapping. In practice this rarely triggers on the *new*-item side, since REQ-SUB-007's hard block already stops an indefinite plan from being re-attached before this check would ever run.
- Two ranges `[aStart, aEnd]` and `[bStart, bEnd]` overlap when `aStart <= bEnd and bStart <= aEnd` (treating a `NULL` `end_date` as `+infinity`).

**Where computed:** Client-side only, in the checkout form, immediately before calling `create-subscription` — reads from `member_current_items` (already unions the `member_id`/`shared_member_id` roles into one `member_id` column per row, so a single query per member/shared-member covers both) plus any items already added earlier in the same in-progress checkout.

**What happens on a conflict:** the form shows a warning naming the conflicting plan and its dates, with Cancel (stay on the form) or Proceed (save anyway) — proceeding saves the checkout exactly as if no conflict existed. **Nothing is persisted about it**: no column, no audit-log entry, no trace that the warning fired or was dismissed. This is a UX safety net against accidental double-booking, not a security control — a request that bypasses the client and calls `create-subscription` directly saves with no warning and no rejection, same as any other client-side-only check in this app.

---

## Catalog Item Rules

Membership plans and add-ons now live in one unified `plans` catalog table, distinguished by `category` (domain-model.md §3). This section covers rules specific to `category = 'addon'` items; membership-item rules (couple plans, etc.) are covered under §Shared Members / Couple Plans below.

### Indefinite items — hard block, no override

If `plans.duration_days IS NULL` (e.g. "Membership Fee", `category = 'addon'`):
- Charged once, has no `end_date` (`null`), never expires.
- **Cannot be attached again** to a member who already has a `SubscriptionItem` referencing it, from any past subscription — a **hard block**, with no "attach anyway" path. REQ-SUB-007. This only needs to check for an existing row, so it applies regardless of the deferred cancellation logic below.
- Refund eligibility for these is undefined in this revision — see §Subscription Cancellation & Refund below.

### Time-boxed items

If `plans.duration_days` is set (e.g. "Zumba Class", 30 days, `category = 'addon'`):
- Has its own `start_date`/`end_date`, computed from `plans.duration_days × quantity` (§Subscription End Date above).
- Can be attached again later (e.g. a renewed term) — nothing blocks a repeat attachment for time-boxed items.
- A repeat attachment with conflicting dates triggers the client-side warn-then-allow check — see §Subscription Overlap Guard above. REQ-SUB-008.

### Add-on pricing

Itemized separately from the membership item's price, both in the UI and in storage — one `subscription_items` row per item, its own `amount_paid`. REQ-SUB-003. **Payment mode is no longer itemizable per add-on**: it now lives on the parent `Subscription` (one value per checkout), a narrower capability than the previous design, where `subscription_addons.payment_mode` was independent of the parent. See [requirements-template.md §13](../requirements-template.md#13-open-questions).

---

## Quantity & Multiplier

Applies uniformly to any `SubscriptionItem` with a duration (membership or add-on) — not applicable to indefinite items (no duration to multiply).

- **Create:** preset chips ×1/×2/×3/×6/×12 plus a custom-number field, defaulting to ×1 (REQ-SUB-009). `end_date`/`amount_paid` formulas are given in §Subscription End Date above. Straight multiplication — no bulk discount logic.
- **Reduce — Deferred.** The previous "reduce via Cancel & Refund's partial-cancellation option" path (old REQ-SUB-010/011) has no equivalent yet — there is no edit path for `quantity` at all after creation in this revision.
- **Increase** on an existing row was never supported either; extending a membership goes through a new subscription instead.

---

## Subscription Cancellation & Refund — Deferred

**Not implemented in this revision.** `subscription_items` carries no `status`, `refund_amount`, `cancellation_reason`, `cancelled_by`, or `cancelled_at` columns — there is currently no way to cancel or refund a line item at all. See [domain-model.md §Open items](./domain-model.md#open-items-not-blocking-but-worth-resolving-before-implementation-begins) and REQ-SUB-011 (*Deferred*) in requirements-template.md.

---

## Shared Members / Couple Plans

A plan's `max_members` (default `1`) bounds how many members one membership item may have — currently capped at `2` in the schema (see database.md's note on why: `subscription_items` has a single `shared_member_id` slot, not a general multi-member list). This cap is a **stopgap, not a confirmed permanent decision** — see [requirements-template.md §13 Open Questions](../requirements-template.md).

- A membership item for a `max_members = 2` plan can optionally have a **shared** member set alongside its primary `member_id`, at creation time only (REQ-SUB-004).
- **No edit path exists yet to set, replace, or clear the shared member after creation** — a narrower capability than the previous design, which had a dedicated edit action for exactly this field. Flagged in requirements-template.md §13.
- Add-on items attach to one specific member (`subscription_items.member_id`) and never set `shared_member_id` — a couple sharing a membership item can still have entirely different add-ons.
- The shared member is included in the client-side overlap check too (§Subscription Overlap Guard above) — both `member_id` and `shared_member_id` are checked, same two-role union `member_current_items` already uses.

---

## Plan Deletion Guard — a real delete behind a usage guard

The `delete-plan` Edge Function covers both `category = 'membership'` and `category = 'addon'` rows — one function, one guard, for the unified catalog (see edge-functions.md). Inside the `delete_plan` function, in one transaction with the plan row locked:
1. Count `subscription_items` where `plan_id = $1`.
2. If count > 0 → block, return an error the client shows as: "Cannot delete — used by X subscription(s)."
3. If count = 0 → `delete from plans where id = $1`. The row is gone; the audit log keeps its last values and who deleted it.

Editing a plan is still allowed via a direct RLS-guarded `supabase-js` update (admin only). Changing `price` or `duration_days` does **not** recalculate existing `subscription_items` rows.

**Defense-in-depth:** `subscription_items.plan_id` is a foreign key with `ON DELETE RESTRICT`, so even a code path that skipped the guard could not delete a plan that items still point at. That is why a plan in use can never be deleted and a historical item always finds its plan.

---

## Deletes Are Real, Guarded and Audited

Members, subscriptions (a checkout and its items), plans, branches and roles are deleted for real, never by a flag. **Users are never deleted, only deactivated** (`is_active = false`).

- **Each delete is a `delete_*` function behind a `delete-*` Edge Function.** The function locks the row, runs the usage guard, deletes, and writes the audit rows, all in one transaction. There is no `DELETE` grant or policy for clients, so a direct delete from the browser is refused (database.md).
- **Foreign keys have no cascade.** A row that something still references cannot be deleted even by a code path that skipped the guard. The one cascade is a branch's member-number counter row, which goes with the branch.
- **The audit trail records the delete.** The audit trigger now also fires on `DELETE` and writes one `audit_log` row per column with the record's last values and `operation = 'delete'`, so who removed what, and what it held, is still on record. `audit_log` itself has no delete path at all (REQ-ADMIN-005): `prevent_hard_delete()` guards it, and `profiles`.
- **There is no "deleted" state to filter.** No table has a `deleted_at` column, so no read query, view or RLS policy needs a filter for one. A uniqueness rule (a member's phone, a plan's name, a branch's code) holds across all rows.
- **A deleted number can be reissued only by hand.** `member_number` comes from a per-branch counter that never goes backwards, so automatic numbering never reuses one. But `update-member-number-sequence` checks the members that exist, so an admin who sets the counter back can be given a number a deleted member once held.
- Cancellation is currently undefined (§Subscription Cancellation & Refund above is deferred). When it returns it will be a **different concept** from delete: a cancelled item should remain a live, visible row.

---

## Member Number Generation — configurable, not hardcoded

Format `<branch.code>-<year>-<sequence>` (e.g. `MUM-2026-0001`), generated server-side by the `generate_member_number()` trigger — never client-supplied, same "always overwritten" pattern as the audit columns (REQ-MEM-005).

- The sequence resets per branch, per calendar year, tracked in `member_number_sequences` (one counter row per `branch_id` + `year`).
- The **starting value**, **increment step**, and **zero-padding width** are not hardcoded — they're read from the `configuration` key/value table (`member_number_start_sequence`, `member_number_increment`, `member_number_padding_width`; see database.md). An admin can raise the padding width later (e.g. from 4 digits to 5) without a schema migration if a branch ever approaches 9,999 members in one year.
- Generation is atomic under concurrent member creation via an `INSERT ... ON CONFLICT DO UPDATE` on the counter row (row-level lock) — two staff registering members for the same branch at the same moment cannot receive the same number.

---

## Member Phone Uniqueness (REQ-MEM-001/006)

A member's `phone` must be unique — enforced by a unique index (`idx_members_phone`, database.md), the same shape as `member_number`, `plans.name` (covers both categories in one table) and `branches.code`. A create or edit that submits a phone number already in use by another member is rejected by Postgres with a unique-violation, surfaced to staff as a validation error naming the conflict. Deleting a member (see §Member Deletion below) frees its phone number for reuse by a new member, since the row is gone.

---

## Member Deletion (REQ-MEM-007)

Staff/admin can delete a member for real — no separate "deactivate" state for members (unlike `profiles`, which has `is_active`). A member's photo files are removed from storage with the row.

- **Usage guard:** like plans and branches (§Plan Deletion Guard above), deleting a member is refused while any `SubscriptionItem` still refers to them, as `member_id` or as `shared_member_id` (409 "Cannot delete — used by X subscription/add-on record(s)"). To delete a member, delete their subscriptions first (§Subscription Deletion below).
- Frees the member's `phone` for reuse by a new member (§Member Phone Uniqueness above); the per-branch `member_number` counter only ever increments, so a number is not reissued automatically.
- A deleted member is gone from the member list, search and reports. The audit log keeps their last field values.

---

## Subscription Deletion

Staff/admin can delete a whole checkout — its items first, then its header — through the `delete-subscription` function (`delete_subscription` RPC, one transaction, row locked). It is how a mistaken checkout is undone, since items are immutable (a change is a new checkout, never an edit), and it is what frees a member to be deleted. There is no usage guard: nothing refers to a subscription. It is no longer counted in reports, and the audit log records the header and each item as deleted, by whom.

---

## Renewal Start Date Default

- If the member has a current `category = 'membership'` item (via `member_current_items`, domain-model.md §Views): default `start_date` = day after that item's `end_date`.
- Otherwise (no current membership item): default `start_date` = today (browser local date).

This is a client-side UI default only (pre-filling the form) — it doesn't itself prevent a conflict, it just makes one less likely to need the §Subscription Overlap Guard warning in the first place. The two are independent: this picks a sensible default date, the overlap guard is a separate check that runs against whatever date ends up in the field, defaulted or manually changed.

---

## Expiry Notification Threshold

Members are considered "expiring soon" if `end_date` is within **7 days** of today (inclusive). This threshold is used by:
- The "Expiring" pill filter on the Members List screen (REQ-LIST-003)
- The "Expiring This Week" section on the Reports screen

**Out of scope for now:** scheduled/pushed expiry alerts (email, web push, etc.) are explicitly not specified yet. Do not build a notification mechanism until the user asks and this file is updated with the chosen approach.

---

## User Invitation & Deactivation

- Only an `admin` (`is_active_admin()`) may invite a new user or change another user's `role` / `is_active`.
- Inviting a user is **always** done via the `invite-user` Edge Function, which uses the Supabase service role to call the Admin API. This cannot be done with a plain client insert — there is no client-side path to create an `auth.users` row, regardless of which sign-in method the invited user eventually uses.
- A deactivated user (`is_active = false`) loses access immediately on their next request, not just at their next login — see RLS policies in [database.md](./database.md). Their existing browser session becomes read/write-blocked on every table.
- An admin cannot deactivate or demote their own account, and cannot change their own `role` (prevents a gym from being left with zero active admins by accident). Enforced both in the `update-user` Edge Function and as a UI-level disabled state on the currently logged-in admin's own row.
- **Users are never deleted (REQ-ADMIN-006 is retired).** `is_active = false` is a reversible toggle — the account stays in `User Management`'s list, flagged inactive (REQ-ADMIN-004), keeps its roles, and still shows by name on everything it did (`created_by`, `handled_by_staff`, the audit log). Same self-protection rule applies: an admin cannot deactivate themselves.
- **Google OAuth sign-in is invite-only, same as password sign-in** — a Google account with no matching `profiles` row is signed out immediately after the OAuth handshake, never gets a `profiles` row auto-created, and sees "This email hasn't been invited — contact your admin." See [edge-functions.md §1](./edge-functions.md#1-authentication-req-auth-001004) for the full flow. This closes the gap [architecture.md](../architecture.md) left open by listing Google OAuth as "optional later" without saying how it interacts with the invite-only model.
- **Password reset (REQ-AUTH-005):** any user with a password-based sign-in can request a reset via Supabase Auth's built-in recovery-email flow (`resetPasswordForEmail` / `updateUser`) — no Edge Function, no custom token infrastructure. Same non-leaking error/response pattern as invite-only checks: the response never confirms whether an email is registered. A user who has so far only signed in via Google can use this same flow to set a password for the first time, since it operates on the existing `auth.users` row.

---

## Field-Level Audit Trail

Every insert/update on every business table writes one `audit_log` row per changed field (old value, new value, who, when), grouped by a shared `change_id` per save — see [database.md §Field-Level Audit Trigger](./database.md#field-level-audit-trigger-req-audit-001) for the trigger mechanics. This is purely a database-trigger concern, not a business rule staff or the client interact with directly — listed here only so it's clear this exists alongside the lighter `created_by`/`changed_by` audit columns and is not a substitute for them (both mechanisms run side by side; see database.md).
