# migrate-to-fitfine

The move to the `fitfine` backend. It copies the 11 app tables, with their constraints, indexes and triggers, every row, the auth users and the member photos from the old Supabase project (**source**, only ever read) into the schema `fitfine` of a new project (**target**), deploys the backend in `supabase/` (migrations and Edge Functions), and validates every step.

Requires bash (3.2 is enough), `psql` at least the servers' major version, `jq`, `curl`, `python3`, and the repo's Supabase CLI (`npm install` at the repo root). No Docker.

## Final run

On a **brand-new** Supabase project, with the app down:

```bash
cp .env.example .env.local   # git-ignored; fill in every variable (they are explained there)
./run.sh --final             # asks you to type the target project ref, then runs unattended
```

`--final` stops at the first failure. In order:

1. **Checks before any connection:** every variable is set; `SUPABASE_ACCESS_TOKEN` is a personal access token (`sbp_…`), not a project key; `TARGET_SUPABASE_URL` and `TARGET_DB_URL` name the same project, and it isn't the source; the Supabase CLI runs.
2. **Checks with a connection:** Task 0 (below), the photo buckets, and that the target has no migration history yet (a brand-new project). Nothing has been changed so far; a refusal here exits 2.
3. **Confirmation:** type the target ref. `--final --yes` skips this for an unattended run.
4. **Data:** Tasks 1–3 (below): load, then 4a + 4b.
5. **Photos:** `--photos`, then `--validate-photos`. Before the migrations on purpose: the copy creates the bucket with the source's settings, and the storage migration then sets the same ones.
6. **Backend:** `--deploy-backend`: the baseline migration is marked applied (Task 1 created those tables), the other migrations are pushed, the history is checked (D.1), then `--validate-backend` (B.1–B.12).
7. **Functions:** `--deploy-functions`: every function in `supabase/functions/` is deployed and bundled server-side; the target must hold exactly those, `ACTIVE`, with JWT verification on (D.2); each must answer a request without a session with 401 and the CORS preflight with 200 (D.3).
8. **The manual checklist** is printed: Data API → Exposed schemas = `fitfine` only, the Auth settings, users without a role (B.12), the Vercel preview and switch, revoking the old project's keys and the access token.

Each step is also a mode of its own (tables below), so a step that failed can be fixed and re-run without starting over: `--deploy-backend` pushes only the missing migrations and `--deploy-functions` redeploys the same code.

Then update the frontend: [spec/frontend/backend-api-changes.md](../../spec/frontend/backend-api-changes.md).

## The data run

```bash
./run.sh --preflight         # Task 0 only: read-only checks
./run.sh                     # the data run only (Task 0, load, 4a + 4b), unattended
```

**Take the app down for the whole run.** Nothing may sign in or write on either project: 4a compares the target with the source row by row, and a single sign-in changes `auth.users`. The script does not check this and asks no questions.

The data run, in order:

1. **Task 0, preflight.** Read-only. Checks direct connections, versions, privileges, auth column compatibility, and the table and trigger inventory.
2. **Load (Tasks 1–3).** One read-only snapshot of the source is exported. Then one target transaction drops and recreates `fitfine`, empties the target auth tables, creates the tables, loads every row, and adds foreign keys, indexes, sequences, functions and triggers. Any error rolls the whole transaction back, so the target is left as it was.
3. **4a + 4b.** Row counts, a row-by-row comparison, and definitions: columns, constraints, indexes, triggers, RLS, trigger functions and identity sequences.

Other options:

| Option | Does |
|---|---|
| `--preflight` | Task 0 only. Read-only. |
| `--load` | Task 0 and one load, with no validation |
| `--validate` | Task 0 and 4a + 4b against the current target. Read-only. |

Member photos, a one-time step after the data is loaded:

| Option | Does |
|---|---|
| `--photos` | Copies every object of the source `member-photos` bucket into the target bucket under the same name. It creates the target bucket with the source's settings if it's missing. An object already on the target with identical bytes is skipped; one with different bytes is left alone and reported. No retries: a failure is logged and the run moves on, so running it again copies only what's still missing. |
| `--validate-photos` | Read-only. Checks that both buckets hold the same names (P3.1) and identical bytes (P3.2, size and SHA-256), and that every `photo_url` / `photo_thumbnail_url` in `fitfine.members` finds its object (P3.3). Orphans are listed, never a failure. |

The backend, after the data is loaded:

| Option | Does |
|---|---|
| `--deploy-backend` | Marks the baseline migration `20261027000100` applied, pushes the rest of `supabase/migrations/` with `TARGET_DB_URL`, checks the target's history equals the repo's migrations (D.1), then runs `--validate-backend`. Re-runnable: only missing migrations are pushed. |
| `--deploy-functions` | Deploys every function in `supabase/functions/` (`--use-api`, no Docker) with `SUPABASE_ACCESS_TOKEN` to the project in `TARGET_SUPABASE_URL`, then checks D.2 (exactly those functions, `ACTIVE`, `verify_jwt` on) and D.3 (401 without a session, 200 on the CORS preflight). |
| `--validate-backend` | Read-only, target only. Checks B.1–B.12: schema and table grants, policies, check constraints, function attributes and who may execute them, no dynamic SQL, only `handle_new_auth_user` reads user metadata, the 26 triggers and the invite trigger, the views, the bucket and its policies, default privileges. Each fact must equal `backend-expected.txt` (a snapshot of a database built from the migrations; regenerate it with `tests/backend-expected.sh` after changing one), and each rule of the design is also checked on its own. B.12 lists active users who hold no role and so lose access; it is information, never a failure. |

These need the Storage variables in `.env.local`, listed in `.env.example`. The source is only read, with GET requests. The keys reach `curl` through header files in the private temp directory, never on the command line. Downloaded photos are deleted as soon as they've been used.

Exit codes: 0 ok, 1 a step or check failed, 2 refused before anything was changed.

Output: progress goes to stderr. Check results go to stdout as `ok   <id> ...` or `FAIL <id> <object> <detail>`, with ids such as `4a.2`, `4b.8`, `P3.1`, `B.5`, `D.2`. A 4a failure names the table, primary key and column, never a value.

Data on disk: the source export and the 4a comparison files hold member records and password hashes. They live only in a private temp directory (`mktemp -d`, mode 700, outside the repo), which is removed on every exit, including a failure or Ctrl-C.

## Local database for the backend tests

`tests/local-db.sh start` starts a throwaway local Postgres server (port 54329) for `npm run test:db` (`supabase/tests/run.sh`) and for `tests/backend-expected.sh`, which regenerates `backend-expected.txt` after a migration changes. Both build their database from `tests/local/supabase-stub.sql` and `supabase/migrations/`.

```bash
eval "$(tests/local-db.sh start)"
PGHOST=localhost PGPORT=54329 PGUSER=postgres tests/backend-expected.sh
tests/local-db.sh stop
```

## Last verified

- 2026-10-26, against the real source (read only) and the scratch Supabase project (PostgreSQL 17): the test suite (since removed) passed, with 32 unit tests and 32 suite assertions (the rehearsal, all 8 sabotages, rollback and the foreign-trigger refusal). Task 0 confirmed the privileges the run needs on Supabase.
- 2026-10-27, photos: `--photos` copied 126 objects with 0 failures. `--validate-photos` passed P3.1–P3.3 (126 names, 126 identical, 120 member paths found, 6 orphans). The first verification hit two transient connection resets; the re-run passed.
