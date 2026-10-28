# Implementation Rules — Web Edition

> Part of: [SPEC-WEB.md](../../SPEC-WEB.md) | App: Fit&Fine Gym Subscription Manager (Web)

These rules apply to every file in `web/` and `supabase/`. They take priority over convenience or habit. Read alongside [rules.md's mobile counterpart](../../spec/rules.md) — this file supersedes it for anything under `web/`.

---

## Data & Backend

1. **Supabase is the only backend.** No custom Node/Express server, no other database. All data access goes through `supabase-js` or Supabase Edge Functions.
2. Security-relevant rules (`end_date` computation, quantity multipliers, indefinite-item hard-block, plan/branch/role/member delete guards, shared-member handling, audit fields, user invitation) are enforced **server-side** — RLS policies and/or Edge Functions — never trusted from client-side validation alone. See [edge-functions.md](./edge-functions.md) for the full function list and [business-logic.md](./business-logic.md) for the rules themselves. Overlap-warning checks and cancellation/refund are deferred in the current schema revision — see [domain-model.md §Open items](./domain-model.md#open-items-not-blocking-but-worth-resolving-before-implementation-begins) — so there is nothing to enforce for them yet.
3. The Supabase **service role key** never appears in `web/` source, `.env` files committed to git, or any Vercel frontend environment variable. It exists only as an Edge Function secret.
4. All Supabase queries go through the typed `supabase-js` client — never construct raw SQL strings from user input, on the client or in an Edge Function.

## Routing

5. **React Router** only. No file-based routing conventions borrowed from `expo-router` — routes are declared explicitly (see [navigation.md](../frontend/navigation.md)).
6. Every screen that reads data re-fetches on route entry — e.g. a `useEffect` that runs when the route's params change, or a router data loader. Returning to a screen (browser back/forward, or re-navigating to the same route with different params) must never show stale data from a previous visit.

## Dates & Timezone

7. `end_date` computation: `start_date + (plan.duration_days × quantity) - 1` for any `SubscriptionItem` (membership or add-on alike — one formula now, since both categories share the same table and the same `plan.duration_days` column), or `NULL` when `plan.duration_days IS NULL` (indefinite item) — always computed **server-side** in the relevant Edge Function (see [edge-functions.md](./edge-functions.md)) — never trust a client-supplied `end_date`. `quantity` defaults to `1`.
8. Calendar dates (`start_date`, `end_date`) are Postgres `date` columns, serialized as `YYYY-MM-DD` over the wire.
9. Datetime stamps (`created_at`, `changed_at`, `cancelled_at`) are Postgres `timestamptz`, always UTC internally.
10. For display, convert UTC datetimes to the browser's local timezone (`Intl.DateTimeFormat` or equivalent). Calendar dates display as-is, no conversion.
11. A shared `web/src/lib/datetime.ts` helper must expose:
    - `todayDate(): string` — today's date as `YYYY-MM-DD` in the browser's local time
    - `addDays(date: string, days: number): string` — date arithmetic for UI previews of `end_date` (the authoritative value still comes from the server)
    - `toLocalDisplay(utc: string): string` — UTC datetime → local human-readable string
    - `formatDate(date: string): string` — `YYYY-MM-DD` → human-readable, e.g. `27 Jun 2026`

## UI & Styling

12. No third-party **UI component libraries** (no MUI, Chakra, Ant Design, shadcn/ui, Tailwind UI, Bootstrap). Plain CSS (CSS Modules or plain `.css` with the shared token file) + React only — this mirrors the mobile app's "React Native core components only" constraint, adapted for the web.
13. A lightweight **icon set** is permitted (e.g. `lucide-react`) — this is not a UI component library, it's the web equivalent of the mobile app's `@expo/vector-icons`. Pick one and use it consistently everywhere.
14. All colors imported from `web/src/styles/tokens.css` (CSS custom properties) or `web/src/constants/colors.ts` (TS). Never hardcode hex values in components.
15. Follow component color rules in [colors.md §Component Color Rules](../frontend/colors.md#component-color-rules).
16. **Responsive by default**: every screen must be usable at both mobile widths (`~360px`+) and desktop widths. Use relative units and CSS Grid/Flexbox — no fixed-pixel layouts that break below/above a specific viewport. See [app-shell.md §3](../frontend/app-shell.md#3-responsive-layout-shell-websrccomponentsappshelltsx) for the shared breakpoint (`768px`).

## TypeScript

17. TypeScript strict mode throughout. No `any` types.
18. Types for all DB row shapes defined in `web/src/types/index.ts` — match field names exactly to column names in [domain-model.md](./domain-model.md), with no `deleted_at`/`deleted_by` (no table has them).

## Audit Fields & Deletes

19. The client **never** sets `created_at`, `created_by`, `changed_at`, or `changed_by` — these are always omitted from insert/update payloads. Postgres triggers set the audit columns from `auth.uid()`. See [database.md §Audit Field Triggers](./database.md#audit-field-triggers).
20. **Deletes go through a `delete-*` Edge Function, never a direct `DELETE` from the client.** Members, subscriptions (a checkout and its items), plans, branches and roles are deleted for real, by a SECURITY DEFINER `delete_*` function that locks the row, runs the usage guard (a member that subscription items use, a plan or branch or role that something references, is refused) and deletes, in one transaction, attributed to the caller. Clients hold no `DELETE` grant, and foreign keys without cascade are the backstop. A PR that adds a `.delete()` call on a business table from the browser, or a `DELETE FROM` that skips the guard, is rejected in review. **Users are never deleted, only deactivated (`is_active = false`)**; `prevent_hard_delete()` refuses a `DELETE` on `profiles` and `audit_log`. Do not add a delete path that skips the guard or the audit trigger.
21. **There is no soft-delete flag to filter.** No table has `deleted_at` or `deleted_by`, so no query, view or policy filters on one, and a uniqueness rule (a phone, a plan name, a branch code) covers every row. A deleted record survives only as `delete` rows in `audit_log`, which keep its last values. See [edge-functions.md §9](./edge-functions.md#9-validation-summary-table).

## Architecture

22. **Always read [architecture.md](../architecture.md) before writing any service, repository, or Edge Function.** Every file must be placed in the correct layer (View / Service / Repository / Edge Function) and must not violate the layer boundary rules.
23. Screens/components access data and logic only through `useServices()` or `useAuth()` — never import `supabase-js` or call `supabase.functions.invoke` directly in a component.
24. Services depend only on repository interfaces — never on concrete repository implementations.
25. Business rules that are security-relevant (see rule 2) are always enforced server-side; the client-side service layer may duplicate the check for instant UX feedback, but must never be the only enforcement point.

## Supabase-Specific

26. Every table must have RLS **enabled**, even if a policy hasn't been written yet for every case — an RLS-enabled table with no matching policy defaults to deny, which is the safe failure mode. This includes every table (`profiles`, `branches`, `plans`, `configuration`, `member_number_sequences`, `audit_log`, `members`, `subscriptions`, `subscription_items`).
27. New Edge Functions must validate the caller's identity/role from the request JWT before doing anything privileged — never assume a request reached the function legitimately just because it hit the endpoint. See [edge-functions.md](./edge-functions.md) for the full function list (subscription+items creation, indefinite-item hard-block, catalog soft-delete guards, user management, reporting).
28. Schema changes only via `supabase/migrations/` files (Supabase CLI), never hand-edited directly in the hosted dashboard for anything meant to persist across environments.
29. Sign-in supports both **email/password and Google OAuth**, mapping to the same `auth.users`/`profiles` row (Supabase Auth identity linking). Google sign-in is **invite-only, same as password sign-in** — a successful OAuth handshake alone never grants app access; the app must check for a matching `profiles` row immediately after and sign the session back out if none exists. See [edge-functions.md §1](./edge-functions.md#1-authentication-req-auth-001004).
30. Operational constants that would otherwise be hardcoded (e.g. member-number starting sequence, increment, and zero-padding width) belong in the `configuration` key/value table, not in application code or a migration's literal values — see [database.md §Configuration Table](./database.md#configuration-table). Only add a new table row for a genuinely reusable setting; don't use `configuration` as a dumping ground for one-off flags that belong on a real column.
