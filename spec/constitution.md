# Fit & Fine Constitution

The principles every spec, plan and change must satisfy. A change that breaks one is not done, however well it works. The detail behind each principle lives in the files linked from it; this page holds only what must never be traded away.

Version 1.0 · Ratified 2026-10-28

---

## Scope

Fit & Fine manages gym members, plans, branches and subscriptions for one gym business, for its staff and admins. It deliberately does **not** have:

- member logins (members never sign in);
- a payment gateway (payments are recorded, not processed);
- multi-tenancy, or branch-based access (a branch is data, not an access boundary);
- subscription cancellation or refunds (deferred by design).

Anything outside this scope needs an amendment first.

## Principles

### 1. The client is untrusted; the server decides
Anyone can call the Supabase API directly, so every security or data-integrity rule is enforced in Postgres (RLS, triggers, constraints) or an Edge Function. Client-side checks exist for instant feedback only and are never the last line of defence.
*Exception, on purpose:* the subscription overlap warning is client-side only.
→ [architecture.md](architecture.md), [backend/rules.md](backend/rules.md)

### 2. Deletes are real, guarded and recorded
Members, subscriptions (a checkout and its items), plans, branches and roles are deleted for real, never by a flag. A delete only goes through an Edge Function that checks the usage guard first (a member that subscriptions use, a plan or branch or role that something references, is refused), backed by a foreign key with no cascade. Every delete is written to the audit log with the record's last values. **Users are never deleted, only deactivated**, and the audit log itself can never be edited or deleted.
Subscription line items are immutable after creation; a change is a new checkout, and a mistaken checkout is deleted whole.

### 3. The database writes the audit trail
`created_by` and `changed_by` come from `auth.uid()` in a trigger, and so does the audit log, including who deleted a record and what it held. The client never sets them. Audit log entries cannot be edited or deleted by anyone.

### 4. Access is least privilege and invite-only
Nobody gets in without an invitation and an active role. Access is decided by RLS and the Edge Functions; route guards only improve the experience. Only `admin` carries special rights. No user can raise their own rights, and the last active admin can never be removed.
→ [README §9](../README.md#9-authentication-roles-and-permissions)

### 5. Secrets stay on the server
The frontend uses the anon key only. The service-role key lives only in Edge Functions. Neither a key nor a personal access token is ever committed.

### 6. Layers are strict
View → Service → Repository. A page never touches Supabase; a service never imports a concrete repository or a page; a repository does data access and nothing else. Anything that needs data gets it through `useServices()` or an argument, so tests can inject fakes.

### 7. Schema changes only through migrations
Every change goes through `supabase/migrations/`, never the hosted dashboard. An applied migration is never edited; a correction is a new migration. Operational constants live in the `configuration` table, not in code.

### 8. Plain CSS and one design system
No third-party UI component library. `lucide-react` is the only icon set. Colours and fonts come from the shared tokens; no hex literals elsewhere. Status is never shown by colour alone.

### 9. One breakpoint, one rendering
The app switches at 768px. Alternate renderings of the same content mount exactly one version, never two with one hidden. Touch targets are at least 44×44px and form controls are 16px on phones.
→ [CLAUDE.md](../CLAUDE.md) "Responsive rendering rules"

### 10. Done means tested
Every new or changed component, page, hook, service or helper ships a test in the same change; every user-facing flow also gets Playwright coverage on desktop and mobile. A failing test is fixed or deleted with a stated reason, never skipped. Work is not reported done without a real run of the tests and the build, and failures are reported as they appeared.

### 11. The specs are the source of truth
Behaviour is defined in `spec/`; code follows it. When behaviour changes, the spec changes in the same change. A gap found between the two is recorded and resolved, not left to drift.

## Decision rules

When principles pull against each other, the lower number wins. In practice: data safety and security (1–5) outrank architecture and style (6–9), and those outrank speed of delivery.

## Amendments

- A change to this page needs the project owner's explicit approval, a stated reason, and a new version number with date.
- Adding a principle is easy; weakening one needs a replacement control.
- Every plan and review checks work against this page. A deliberate exception is written down where it applies (as the overlap warning is above), not worked around silently.
