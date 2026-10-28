# Shared helpers for run.sh and tests/backend-expected.sh: env loading, URL parsing, psql wrappers, logging, and the
# fixed table and trigger lists. Sourced, never executed. Bash 3.2 compatible (macOS /bin/bash):
# no associative arrays, no mapfile, no ${x,,}, no "${empty[@]}" under set -u.

MIG_DIR=${MIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

EXIT_OK=0
EXIT_FAIL=1
EXIT_REFUSED=2

# Field separator for multi-column query output (psql -F): never appears in names or definitions.
US=$'\x1f'

# The 11 tables copied from source public to target TARGET_SCHEMA. The list is fixed (plan:
# "Tables in scope"); only each table's definition is read from the source.
MIG_TABLES="profiles branches plans configuration roles user_roles members member_number_sequences subscriptions subscription_items audit_log"
# Tables in source public that are deliberately not copied. Empty today; Task 0 fails on any other.
MIG_EXCLUDED_TABLES=""

# The plan's "Triggers in scope" table: table|trigger|timing|events|level|function.
# Task 0 fails when the source catalog differs, so this list and the plan are updated together.
MIG_TRIGGERS='auth.users|trg_handle_new_auth_user|AFTER|INSERT|ROW|public.handle_new_auth_user
audit_log|trg_audit_log_no_hard_delete|BEFORE|DELETE|ROW|public.prevent_hard_delete
branches|trg_branches_audit|BEFORE|INSERT OR UPDATE|ROW|public.set_audit_fields
branches|trg_branches_audit_fields|AFTER|INSERT OR UPDATE|ROW|public.audit_row_changes
branches|trg_branches_no_hard_delete|BEFORE|DELETE|ROW|public.prevent_hard_delete
members|trg_members_audit|BEFORE|INSERT OR UPDATE|ROW|public.set_audit_fields
members|trg_members_audit_fields|AFTER|INSERT OR UPDATE|ROW|public.audit_row_changes
members|trg_members_generate_number|BEFORE|INSERT OR UPDATE|ROW|public.generate_member_number
members|trg_members_no_hard_delete|BEFORE|DELETE|ROW|public.prevent_hard_delete
plans|trg_plans_audit|BEFORE|INSERT OR UPDATE|ROW|public.set_audit_fields
plans|trg_plans_audit_fields|AFTER|INSERT OR UPDATE|ROW|public.audit_row_changes
plans|trg_plans_no_hard_delete|BEFORE|DELETE|ROW|public.prevent_hard_delete
profiles|trg_profiles_audit|BEFORE|INSERT OR UPDATE|ROW|public.set_audit_fields
profiles|trg_profiles_audit_fields|AFTER|INSERT OR UPDATE|ROW|public.audit_row_changes
profiles|trg_profiles_no_hard_delete|BEFORE|DELETE|ROW|public.prevent_hard_delete
roles|trg_roles_audit|BEFORE|INSERT OR UPDATE|ROW|public.set_audit_fields
roles|trg_roles_audit_fields|AFTER|INSERT OR UPDATE|ROW|public.audit_row_changes
roles|trg_roles_no_hard_delete|BEFORE|DELETE|ROW|public.prevent_hard_delete
roles|trg_roles_protect_system_admin|BEFORE|UPDATE|ROW|public.protect_system_admin_role
subscription_items|trg_subscription_items_audit|BEFORE|INSERT OR UPDATE|ROW|public.set_audit_fields
subscription_items|trg_subscription_items_audit_fields|AFTER|INSERT OR UPDATE|ROW|public.audit_row_changes
subscription_items|trg_subscription_items_no_hard_delete|BEFORE|DELETE|ROW|public.prevent_hard_delete
subscriptions|trg_subscriptions_audit|BEFORE|INSERT OR UPDATE|ROW|public.set_audit_fields
subscriptions|trg_subscriptions_audit_fields|AFTER|INSERT OR UPDATE|ROW|public.audit_row_changes
subscriptions|trg_subscriptions_no_hard_delete|BEFORE|DELETE|ROW|public.prevent_hard_delete
user_roles|trg_user_roles_audit_fields|AFTER|INSERT OR DELETE|ROW|public.audit_row_changes'

# Schemas TARGET_SCHEMA may never be: the load drops TARGET_SCHEMA with CASCADE.
MIG_RESERVED_SCHEMAS="public auth storage extensions graphql graphql_public realtime vault pgbouncer net cron supabase_functions supabase_migrations information_schema"

# Applied at the start of every session (plan 4a): the JSON text then depends only on the data.
# Task 0 verifies each value with SHOW.
MIG_SESSION_SQL="SET TimeZone = 'UTC'; SET extra_float_digits = 3; SET bytea_output = 'hex'; SET IntervalStyle = 'postgres'; SET DateStyle = 'ISO, YMD'; SET client_min_messages = warning"
MIG_SESSION_EXPECT="UTC${US}3${US}hex${US}postgres"

# Rewrites the schema prefix public. (never the bare word) in definitions read from the source.
MIG_RW_FROM='(^|[^[:alnum:]_".])public\.'

log()    { printf '%s\n' "$*" >&2; }
warn()   { printf 'WARN %s\n' "$*" >&2; }
refuse() { printf 'REFUSED %s\n' "$*" >&2; exit "$EXIT_REFUSED"; }
die()    { printf 'ERROR %s\n' "$*" >&2; exit "$EXIT_FAIL"; }

# Check result lines (stdout). Tests match on "FAIL <check-id> <object>".
fail_line() { printf 'FAIL %s %s %s\n' "$1" "$2" "${3-}"; }
ok_line()   { printf 'ok   %s %s\n' "$1" "${2-}"; }

# --- env file -------------------------------------------------------------------------------

# KEY=VALUE lines; blank lines and '#' comments ignored; surrounding quotes stripped; an unquoted
# value loses a trailing " # comment". A variable already set in the shell wins over the file.
load_env() {
  local file=$1 line key value re='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    line=${line#"${line%%[![:space:]]*}"}
    case $line in ''|'#'*) continue ;; esac
    [[ $line =~ $re ]] || continue
    key=${BASH_REMATCH[2]}
    value=${BASH_REMATCH[3]}
    case $value in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
      *)     value=${value%%[[:space:]]#*}
             while [ "${value% }" != "$value" ] || [ "${value%$'\t'}" != "$value" ]; do
               value=${value% }; value=${value%$'\t'}
             done ;;
    esac
    if eval "[ -z \"\${$key+x}\" ]"; then
      export "$key=$value"
    fi
  done <"$file"
}

# Refuses naming every missing variable at once.
require_vars() {
  local v val missing=''
  for v in "$@"; do
    eval "val=\${$v-}"
    [ -n "$val" ] || missing="$missing $v"
  done
  [ -z "$missing" ] || refuse "missing required variable(s):$missing"
}

# --- URLs -----------------------------------------------------------------------------------

# Sets DBU_USER DBU_HOST DBU_PORT DBU_DB from a postgres URL; returns 1 if it does not parse.
# The password group is greedy so an unencoded '@' in it still leaves the host intact.
parse_db_url() {
  local re='^postgres(ql)?://([^:@/]+)(:.*)?@([^:/?@]+)(:([0-9]+))?(/([^?]*))?(\?.*)?$'
  DBU_USER='' DBU_HOST='' DBU_PORT='' DBU_DB=''
  [[ $1 =~ $re ]] || return 1
  DBU_USER=${BASH_REMATCH[2]}
  DBU_HOST=${BASH_REMATCH[4]}
  DBU_PORT=${BASH_REMATCH[6]:-5432}
  DBU_DB=${BASH_REMATCH[8]:-postgres}
}

# user@host:port/db — never the password. Used in every message that names a connection.
redact_db_url() {
  parse_db_url "$1" || { printf '<unparseable URL>'; return; }
  printf '%s@%s:%s/%s' "$DBU_USER" "$DBU_HOST" "$DBU_PORT" "$DBU_DB"
}

# Why a value is not a postgres URL, without echoing it (it contains the password).
db_url_problem() {
  local u=$1 scheme_re='^postgres(ql)?://'
  case $u in *[[:space:]]*) printf 'contains whitespace'; return ;; esac
  case $u in *\"*|*\'*) printf 'contains quote characters'; return ;; esac
  [[ $u =~ $scheme_re ]] || { printf "starts with '%s' instead of postgresql://" "${u%%//*}"; return; }
  case ${u#*://} in *@*) ;; *) printf "has no '@' between user:password and host"; return ;; esac
  printf 'host, port or database part is malformed'
}

# Prints why URL is not a Supabase direct connection (db.<ref>.supabase.co:5432), or nothing when
# it is one. MIG_TEST_ALLOW_LOCAL=1 (tests only) also accepts localhost, for supabase/tests/run.sh.
direct_url_problem() {
  local direct='^db\.[a-z0-9]+\.supabase\.co$'
  parse_db_url "$1" || { printf 'is not a postgresql://user:password@host:port/db URL (%s)' "$(db_url_problem "$1")"; return; }
  if [ "${MIG_TEST_ALLOW_LOCAL-}" = 1 ]; then
    case $DBU_HOST in localhost|127.0.0.1) return ;; esac
  fi
  case $DBU_HOST in
    *.pooler.supabase.com) printf 'is the Supabase pooler (%s:%s); use the direct connection db.<ref>.supabase.co:5432' "$DBU_HOST" "$DBU_PORT"; return ;;
  esac
  [[ $DBU_HOST =~ $direct ]] || { printf 'host %s is not db.<ref>.supabase.co' "$DBU_HOST"; return; }
  [ "$DBU_PORT" = 5432 ] || printf 'port %s is not 5432' "$DBU_PORT"
}

# --- versions -------------------------------------------------------------------------------

# First "major[.minor]" in a string, e.g. "psql (PostgreSQL) 17.11 (Homebrew)" -> 17.11
version_of() {
  local re='([0-9]+)(\.([0-9]+))?'
  [[ $1 =~ $re ]] || return 1
  printf '%s.%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]:-0}"
}

# version_ge A B: true when A >= B, comparing major then minor numerically.
version_ge() {
  local a b a1 a2 b1 b2
  a=$(version_of "$1") || return 1
  b=$(version_of "$2") || return 1
  a1=${a%%.*} a2=${a#*.} b1=${b%%.*} b2=${b#*.}
  [ "$a1" -gt "$b1" ] && return 0
  [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -ge "$b2" ]
}

# --- schema names ---------------------------------------------------------------------------

valid_target_schema() {
  local s=$1 r re='^[a-z_][a-z0-9_]*$'
  [[ $s =~ $re ]] || return 1
  case $s in pg_*) return 1 ;; esac
  for r in $MIG_RESERVED_SCHEMAS; do [ "$s" = "$r" ] && return 1; done
  return 0
}

# {profiles,branches,...} for the psql variable :'tables' (used as :'tables'::text[]).
mig_tables_literal()   { printf '{%s}' "$(printf '%s' "$MIG_TABLES" | tr ' ' ,)"; }
mig_excluded_literal() { printf '{%s}' "$(printf '%s' "$MIG_EXCLUDED_TABLES" | tr ' ' ,)"; }

# --- psql -----------------------------------------------------------------------------------

# Each -c is its own transaction, so the session SETs (incl. read-only) apply to everything after.
psql_base()      { PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10} PGAPPNAME=migrate-to-fitfine psql -X -q -v ON_ERROR_STOP=1 -At -F "$US" "$@"; }
psql_source()    { psql_retry -d "$SOURCE_DB_URL" -c "$MIG_SESSION_SQL; SET default_transaction_read_only = on" "$@"; }
psql_target()    { psql_base -d "$TARGET_DB_URL" -c "$MIG_SESSION_SQL" "$@"; }
psql_target_ro() { psql_retry -d "$TARGET_DB_URL" -c "$MIG_SESSION_SQL; SET default_transaction_read_only = on" "$@"; }

# Read-only sessions only: when psql exits 2 (the connection failed or was lost; hosted Supabase
# drops one now and then) the whole session is run again, up to 3 more times after 1, 2 and 4 s
# (MIG_RETRY_DELAY scales the base, 0 in tests). Stdin (-f -) and stdout are buffered so a retry
# sees the same input and a dropped attempt leaves no partial output. Writes are never retried:
# a connection lost during COMMIT leaves the outcome unknown.
psql_retry() {
  local a stdin=0 attempt=0 rc in out err
  for a in "$@"; do [ "$a" != - ] || stdin=1; done
  in=$(mktemp) out=$(mktemp) err=$(mktemp)
  [ $stdin = 0 ] || cat >"$in"
  while :; do
    psql_base "$@" <"$in" >"$out" 2>"$err" && rc=0 || rc=$?
    [ "$rc" = 2 ] && [ $attempt -lt 3 ] || break
    attempt=$((attempt + 1))
    log "retry   read-only session after a dropped connection (attempt $((attempt + 1)) of 4): $(head -1 "$err")"
    sleep $(( ${MIG_RETRY_DELAY:-1} << (attempt - 1) ))
  done
  cat "$out"; cat "$err" >&2
  rm -f "$in" "$out" "$err"
  return "$rc"
}

# psql_def SIDE ARGS...: a read-only session on SIDE (source|target) for reading definitions, with
# the psql variables every definition query uses: :'side', :'schema' (public / TARGET_SCHEMA),
# :'tschema', :'tables', and :'rw_from' / :'rw_to', which rewrite the prefix public. to
# TARGET_SCHEMA. on the source and leave the target text as it is ("Reading definitions").
psql_def() {
  local side=$1 fn=psql_source schema=public rw_to="\\1$TARGET_SCHEMA."
  shift
  if [ "$side" = target ]; then fn=psql_target_ro schema=$TARGET_SCHEMA rw_to='\1public.'; fi
  $fn -v side="$side" -v schema="$schema" -v tschema="$TARGET_SCHEMA" -v tables="$(mig_tables_literal)" \
    -v excluded="$(mig_excluded_literal)" -v rw_from="$MIG_RW_FROM" -v rw_to="$rw_to" "$@"
}

# psql's own error for a failed session, without the "psql:<file>:<line>: " prefix.
first_error() { grep -m1 -E 'ERROR|FATAL|error' "$1" 2>/dev/null | sed 's/^psql:[^:]*:[0-9]*: //' || true; }
