# Edge Function Structure

How an Edge Function is laid out: which file does what, what it may import, how requests are
validated and errors are reported. Read this before adding or changing a function. It describes the
`supabase/` backend. The reference implementation is the **member** entity
(`supabase/functions/_entities/member/`).

What a function must *do* (validation steps, status codes) is in [edge-functions.md](./edge-functions.md).
Why the server is the authority is in [../architecture.md](../architecture.md). This file is only the
structure.

---

## 1. Edge Function or direct write?

The default is a direct, RLS-guarded `supabase-js` write: column grants, RLS and `CHECK`
constraints already stand in front of it, and it costs one round trip. Use an Edge Function only when
the write needs one of these:

| Need | Example |
|---|---|
| A secret or privileged API (service role, `auth.admin`, Storage with the service role) | `invite-user`, `list-users`, `delete-member` (row + photo files) |
| A value the client can't be trusted to compute | `create-subscription` (`end_date`) |
| Several writes that must succeed or fail together, or one request that spans database and Storage | `create-subscription`, `create-member` (row + photo) |
| A rule RLS can't express | `update-user` ("not your own roles") |

If none apply, do not add a function. A second copy of the rules in TypeScript only drifts from the
constraints that are the real authority.

---

## 2. Layout

```
supabase/functions/
  _shared/                    infrastructure only; knows nothing about any entity
    define-function.ts        declares a function: client -> access check -> body -> handler
    http.ts                   CORS, json(), body readers, handle() (the one error handler)
    errors.ts                 HttpError + typed subclasses, rpcError(), GENERIC_ERROR
    validate.ts               request-body rules (the DTO schemas are built from these)
    auth.ts  clients.ts       requireCaller(); the two Supabase clients
  _entities/<entity>/         one folder per entity (member, subscription, plan, ...)
    dto.ts                    request schema + its type, response types, RPC result types
    mapper.ts                 database result -> response DTO, field by field
    rules.ts                  pure domain rules (no I/O)
    errors.ts                 the entity's error codes, by RPC and status
    repository.ts             all database access for the entity: RPC names and parameters
    <thing>-storage.ts        Storage access, if the entity has files (e.g. photo-storage.ts)
    service.ts                the use cases; the entity's policy lives here
  <function-name>/index.ts    declaration only; the deployed name never changes
  _tests/                     Deno tests
```

Folders starting with `_` are not deployed as functions. The deployed function names are the public
contract with the frontend, so one function per action stays (`create-member`, `delete-member`).
Only the *source* is organised by entity.

---

## 3. Layers

```
index.ts  ->  defineFunction  ->  service  ->  repository / storage  ->  RPC / Storage
             (auth, DTO)         (use case)    (data access)
```

| Layer | Does | Must not |
|---|---|---|
| `index.ts` | Names the function, its access level and its schema; passes `ctx` to a service; returns `json(...)` | Contain logic, touch a table, call an RPC |
| `defineFunction` | Creates the service client, runs `requireCaller`, reads and validates the body, calls the handler | Know any entity |
| `service` | Sequences the steps, decides what a failure of each step means (e.g. "photo failed: keep the member"), returns a response DTO | Name an RPC, build a query, know about HTTP requests |
| `repository` / `*-storage` | Calls RPCs and Storage with typed parameters, attaches the entity's error codes, checks the shape of what comes back | Apply business rules or throw HTTP-specific decisions beyond `rpcError` |
| `rules` | Pure functions: paths, limits, derived values | Do I/O |
| `mapper` | Builds the response DTO field by field | Return a database row or `to_jsonb` result |

A service takes the repository and storage as interfaces (`createXService({ repo, photos })`) and a
`xServiceFor(admin)` factory wires the real ones. That is the only place a test substitutes a fake.

The SQL functions are the last line of defense, not the TypeScript layers: every RPC re-checks the
caller's access (`access_of`) and enforces its own rules, as in
[edge-functions.md](./edge-functions.md). The service layer sequences; it never replaces them.

---

## 4. DTOs

- **Request DTO**: the schema in `dto.ts`, built from `_shared/validate.ts` rules. The type is
  `Parsed<typeof schema>`, so the validation and the type cannot drift apart.
- Unknown fields are rejected (400), so a body cannot carry `created_by`, `member_number` or any audit column.
- Text is normalised, not escaped. Values reach the database only as typed RPC parameters or `.eq` / `.in`.
- **Response DTO**: an interface in `dto.ts`, built by a mapper. Never return a database row or a
  `to_jsonb` result: a column added later, or an audit column, would reach the client unannounced.
- **RPC result types** (what a repository reads back) are declared in `dto.ts` and checked in the
  repository, not trusted with a cast.
- The DTO mirrors the wire format only. Database row types come from the generated types; do not
  hand-write an `Entity` that nothing reads.

---

## 5. Errors

One model, in `_shared/errors.ts`:

- **Expected errors** are `HttpError` or a subclass (`BadRequestError` 400, `ForbiddenError` 403,
  `NotFoundError` 404, `ConflictError` 409). Their message and status reach the client.
- **Database refusals** use SQLSTATE `PT400/403/404/409`. `rpcError(error, codes)` turns one into the
  matching typed error and attaches `codes[status]`. Any other database error is rethrown.
- **Unexpected errors** are logged in full and answered as the generic 500. No table, constraint or
  column name leaves the server.
- **`code`**: the body is `{ error, code? }`. The `message` is for a person and may change. The `code`
  is for the client to switch on and is stable (`MEMBER_IN_USE`, `PHONE_IN_USE`). Add a code only where
  the client needs to tell cases apart. A refusal with no code has none. Codes live in the entity's
  `errors.ts` and are typed as a union.
- A step that must not fail the request (a photo that could not be stored after the row was saved) is
  reported as a field of the response, not as an error, and logged.

The client must never match on `message` text.

---

## 6. Adding a function

1. **Decide** it needs a function (§1).
2. **Database**: add the RPC in a new migration, `security definer`, `set search_path = ''`, starting
   with `act_as(p_caller_id)` and an `access_of` check, raising refusals with `PT4xx`; revoke from
   everyone, grant to `service_role`. Add SQL tests. Regenerate `backend-expected.txt`.
3. **Entity files**: `dto.ts` (schema, types), `errors.ts` (codes), `rules.ts`, `repository.ts`,
   storage module if needed, `mapper.ts`, `service.ts`.
4. **`<name>/index.ts`**: `defineFunction({ name, level, schema }, handler)`; the handler calls the service.
5. **Tests**: one per layer (§7), plus the function through `functions.test.ts`, plus the shared gates
   in `gates.test.ts`.
6. **Specs**: the function's entry in [edge-functions.md](./edge-functions.md), the entity's spec, and
   the frontend repository's call and error handling.

---

## 7. Testing

- **rules, mapper, dto**: plain calls, no fakes.
- **repository**: a hand-written fake client with only the methods it calls; assert the RPC name,
  parameters, and the code attached to each refusal.
- **storage module**: a hand-written fake bucket; assert paging, cleanup and the "never throws" result.
- **service**: fakes for the repository and storage (the interfaces); assert the sequence and what each
  failure means.
- **function**: through the scripted Supabase fake in `_tests/` (`loadFunction` / `call`), for the
  wiring only: access level, body validation, status and `code`.
- `source-scan.test.ts` scans every source file: no PostgREST string filters (`.or`, `.filter`, `.like`
  and the like; use `flatMap` and `.eq` / `.in`), no queries built from templates, no dynamic code.
