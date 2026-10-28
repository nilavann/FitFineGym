# Deploying the backend to the target: the migrations in supabase/migrations (constraints, grants,
# access rule, triggers, policies, views, API functions, storage) and the Edge Functions in
# supabase/functions, each followed by its checks. --deploy-backend, --deploy-functions and --final
# (README "Final run"). Sourced, never executed.
#
# Uses the repo's Supabase CLI (npx supabase, the root devDependency). No Docker: functions are
# bundled server-side (--use-api). The database is reached with TARGET_DB_URL; the Management API
# (functions only) with SUPABASE_ACCESS_TOKEN. Output lines: "ok   D.n ..." / "FAIL D.n ...".

MIG_REPO=$(cd "$MIG_DIR/../.." && pwd)
# Phase 1 creates the tables; this first migration reproduces them and is only marked applied.
MIG_BASELINE=20261027000100
MIG_D_FAILS=0

d_fail() { fail_line "$@"; MIG_D_FAILS=$((MIG_D_FAILS + 1)); }

# Never let a password or a token reach the terminal or a log.
# The password runs to the last '@' of the URL (it may contain one), so match up to it within the token.
redact_stream() { sed -E 's#(postgres(ql)?://[^:/@ ]*:)[^ ]*@#\1<redacted>@#g; s/sbp_[A-Za-z0-9_]+/<token>/g'; }

supabase_cli() {
  (cd "$MIG_REPO" && npx --no-install supabase --workdir "$MIG_REPO" "$@") 2>&1 |
    redact_stream | grep -v -e 'A new version of Supabase CLI' -e 'We recommend updating regularly'
  return "${PIPESTATUS[0]}"
}

# The functions and migrations in the repo, which is what the target must end up holding.
local_functions() {
  local d
  for d in "$MIG_REPO"/supabase/functions/*/; do
    d=${d%/}; d=${d##*/}
    case $d in _*) continue ;; esac
    [ -f "$MIG_REPO/supabase/functions/$d/index.ts" ] && printf '%s\n' "$d"
  done
}
local_migrations() {
  local f
  for f in "$MIG_REPO"/supabase/migrations/*.sql; do f=${f##*/}; printf '%s\n' "${f%%_*}"; done
}

# The target's project ref, from TARGET_SUPABASE_URL (photos.sh's api_url_ref).
target_ref() { api_url_ref "${TARGET_SUPABASE_URL-}"; }

# Checks that need no connection; they run before anything else, so a wrong token or project stops
# the run at once. $1: backend | functions | final.
preflight_deploy_static() {
  local what=$1 ref sref
  case $what in
    backend)   require_vars TARGET_DB_URL ;;
    functions) require_vars TARGET_SUPABASE_URL SUPABASE_ACCESS_TOKEN ;;
    final)     require_vars SOURCE_DB_URL TARGET_DB_URL SOURCE_SUPABASE_URL TARGET_SUPABASE_URL SUPABASE_ACCESS_TOKEN ;;
  esac

  if [ "$what" != backend ]; then
    case $SUPABASE_ACCESS_TOKEN in
      sbp_*) ;;
      eyJ*) refuse "SUPABASE_ACCESS_TOKEN is a JWT, i.e. a project API key (anon or service role), not a personal access token; create one under Dashboard -> Account -> Access Tokens (it starts with sbp_)" ;;
      *)    refuse "SUPABASE_ACCESS_TOKEN does not start with sbp_; it must be a personal access token (Dashboard -> Account -> Access Tokens)" ;;
    esac
    ref=$(target_ref) || refuse "TARGET_SUPABASE_URL is not https://<ref>.supabase.co"
    if [ -n "${TARGET_DB_URL-}" ] && [ "${MIG_TEST_ALLOW_LOCAL-}" != 1 ]; then
      [ "$(db_url_ref "$TARGET_DB_URL" 2>/dev/null)" = "$ref" ] ||
        refuse "target: TARGET_SUPABASE_URL (ref $ref) and TARGET_DB_URL name different projects"
    fi
    if [ -n "${SOURCE_SUPABASE_URL-}" ]; then
      sref=$(api_url_ref "$SOURCE_SUPABASE_URL") || refuse "SOURCE_SUPABASE_URL is not https://<ref>.supabase.co"
      [ "$sref" != "$ref" ] || refuse "the target project $ref is the source project; nothing may be deployed to the source"
    fi
    if [ -n "${SOURCE_DB_URL-}" ] && [ "$(db_url_ref "$SOURCE_DB_URL" 2>/dev/null)" = "$ref" ]; then
      refuse "the target project $ref is the source project; nothing may be deployed to the source"
    fi
  fi

  supabase_cli --version >/dev/null 2>&1 || refuse "the Supabase CLI does not run: npm install at the repo root (it is a devDependency)"
}

# The target's recorded migration versions, one per line; empty when it has no history table.
target_history() {
  # Two queries: one statement naming a missing table fails at parse time, whatever its CASE says.
  local exists
  exists=$(psql_target_ro -c "select to_regclass('supabase_migrations.schema_migrations') is not null") || return
  [ "$exists" = t ] || return 0
  psql_target_ro -c "select coalesce(string_agg(version, E'\n' order by version), '') from supabase_migrations.schema_migrations"
}

# --final only: a brand-new project has no migration history.
preflight_fresh_target() {
  local history
  history=$(target_history) || die "could not read the target's migration history"
  [ -z "$history" ] || refuse "the target already has a migration history ($(printf '%s\n' "$history" | wc -l | tr -d ' ') version(s)); --final is for a brand-new project. Use --deploy-backend / --deploy-functions on this one"
}

# Asks for the project ref to be typed back before --final changes anything (--yes skips it).
confirm_target() {
  local ref answer
  ref=$(target_ref)
  [ "${MIG_YES-}" != 1 ] || { log "confirm  --yes: deploying to $ref without asking"; return 0; }
  [ -t 0 ] || refuse "--final asks you to type the target ref; run it in a terminal, or pass --yes"
  printf '\nThe final run loads the data, copies the photos and deploys the backend to project %s\n(%s). The source is only read.\nType the target project ref to continue: ' "$ref" "$(redact_db_url "$TARGET_DB_URL")" >&2
  read -r answer
  [ "$answer" = "$ref" ] || refuse "the typed ref did not match $ref; nothing was changed"
}

# The migrations, then --validate-backend. Safe to re-run: only missing migrations are pushed.
step_deploy_backend() {
  local history want before=$MIG_D_FAILS
  log "deploy backend: supabase/migrations -> $(redact_db_url "$TARGET_DB_URL")"
  [ "$(psql_target_ro -c "select to_regclass('$TARGET_SCHEMA.members') is not null")" = t ] ||
    { d_fail D.1 "$TARGET_SCHEMA.members" "missing: load the data first (run.sh, or --load)"; return "$EXIT_FAIL"; }

  history=$(target_history) || { d_fail D.1 history "could not be read"; return "$EXIT_FAIL"; }
  if ! printf '%s\n' "$history" | grep -qx "$MIG_BASELINE"; then
    supabase_cli migration repair --status applied "$MIG_BASELINE" --db-url "$TARGET_DB_URL" >&2 ||
      { d_fail D.1 "$MIG_BASELINE" "could not be marked applied"; return "$EXIT_FAIL"; }
  fi
  supabase_cli db push --db-url "$TARGET_DB_URL" --yes >&2 ||
    { d_fail D.1 "db push" "failed; the migration that failed was rolled back, the ones before it stay"; return "$EXIT_FAIL"; }

  history=$(target_history)
  want=$(local_migrations)
  if [ "$history" = "$want" ]; then
    ok_line D.1 "migration history = supabase/migrations ($(printf '%s\n' "$want" | wc -l | tr -d ' ') versions)"
  else
    d_fail D.1 history "differs from supabase/migrations: has [$(printf '%s' "$history" | tr '\n' ' ')], want [$(printf '%s' "$want" | tr '\n' ' ')]"
  fi
  step_validate_backend || MIG_D_FAILS=$((MIG_D_FAILS + 1))
  [ "$MIG_D_FAILS" = "$before" ]
}

# Deploys every function, then checks the target holds exactly the repo's functions, active and
# with JWT verification on, and that each answers a request without a session with 401.
step_deploy_functions() {
  local ref out list fn post opt before=$MIG_D_FAILS
  ref=$(target_ref)
  export SUPABASE_ACCESS_TOKEN
  log "deploy functions: supabase/functions -> project $ref ($(local_functions | wc -l | tr -d ' ') functions, bundled server-side)"
  supabase_cli functions deploy --use-api --project-ref "$ref" >&2 ||
    { d_fail D.2 deploy "failed"; return "$EXIT_FAIL"; }

  out=$(supabase_cli functions list --project-ref "$ref" --output-format json) ||
    { d_fail D.2 list "could not be read"; return "$EXIT_FAIL"; }
  # slug<TAB>status<TAB>verify_jwt, whatever the CLI wraps the list in.
  list=$(printf '%s\n' "$out" | python3 -c '
import json, sys
text = sys.stdin.read()
data = None
for i in range(len(text)):
    if text[i] in "[{":
        try:
            data = json.loads(text[i:]); break
        except ValueError:
            continue
fns = data.get("functions", data) if isinstance(data, dict) else (data or [])
for f in fns:
    print("%s\t%s\t%s" % (f.get("slug"), f.get("status"), str(f.get("verify_jwt")).lower()))
') || { d_fail D.2 list "could not be parsed"; return "$EXIT_FAIL"; }

  for fn in $(local_functions); do
    case $(printf '%s\n' "$list" | awk -F'\t' -v s="$fn" '$1 == s { print $2 "|" $3 }') in
      'ACTIVE|true') ;;
      '')            d_fail D.2 "$fn" "not deployed" ;;
      *)             d_fail D.2 "$fn" "is $(printf '%s\n' "$list" | awk -F'\t' -v s="$fn" '$1 == s { print $2 ", verify_jwt " $3 }')" ;;
    esac
  done
  for fn in $(printf '%s\n' "$list" | cut -f1); do
    local_functions | grep -qx "$fn" || d_fail D.2 "$fn" "deployed but not in supabase/functions"
  done
  [ "$MIG_D_FAILS" != "$before" ] || ok_line D.2 "$(local_functions | wc -l | tr -d ' ') functions, all ACTIVE with verify_jwt on, none extra"

  local smoke=$MIG_D_FAILS
  for fn in $(local_functions); do
    post=$(curl -s -o /dev/null --max-time 30 -w '%{http_code}' -X POST "https://$ref.supabase.co/functions/v1/$fn" -H 'Content-Type: application/json' -d '{}')
    opt=$(curl -s -o /dev/null --max-time 30 -w '%{http_code}' -X OPTIONS "https://$ref.supabase.co/functions/v1/$fn" \
      -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: POST')
    [ "$post" = 401 ] || d_fail D.3 "$fn" "POST without a session answered $post, not 401"
    [ "$opt" = 200 ] || d_fail D.3 "$fn" "the CORS preflight answered $opt, not 200"
  done
  [ "$MIG_D_FAILS" != "$smoke" ] || ok_line D.3 "every function refuses a request without a session (401) and answers the CORS preflight (200)"
  [ "$MIG_D_FAILS" = "$before" ]
}

# What the script can't do: printed at the end of --final.
final_checklist() {
  local ref
  ref=$(target_ref)
  cat >&2 <<EOF

Done. Left to do by hand (dashboard of project $ref, then Vercel):
  1. Project Settings -> Data API -> Exposed schemas: fitfine only. Until then the app gets no data.
  2. Authentication: "Allow new users to sign up" off; Site URL and Redirect URLs for invite emails;
     the Google provider; SMTP for invite emails.
  3. Give a role to every active user listed under B.12 above (they have no access without one).
  4. Test on a Vercel preview: VITE_SUPABASE_URL=https://$ref.supabase.co and this project's anon key.
  5. At cutover: switch the production env vars, then revoke the old project's keys (or pause it).
  6. Revoke the personal access token used for this run (Dashboard -> Account -> Access Tokens).
EOF
}
