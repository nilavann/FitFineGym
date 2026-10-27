# Task 0 — Preflight (plan). Read-only on both sides: it changes nothing and asks nothing. Every
# check that can stop the run is here, so a failure (exit 2) comes before Task 1 touches the target.

MIG_SRC_MAJOR='' MIG_TGT_MAJOR=''

preflight() {
  preflight_connections
  preflight_privileges
  preflight_auth_columns
  preflight_tables
  preflight_triggers
  log "preflight ok"
}

# Task 0 steps 1-3: variables, direct connections, session settings, versions. The photo modes
# (lib/photos.sh) run only this part before their own checks.
preflight_connections() {
  local side url var problem
  require_vars SOURCE_DB_URL TARGET_DB_URL
  valid_target_schema "$TARGET_SCHEMA" ||
    refuse "TARGET_SCHEMA '$TARGET_SCHEMA' is not allowed (must be a plain lowercase name, not a Supabase or system schema)"

  for side in source target; do
    if [ $side = source ]; then url=$SOURCE_DB_URL var=SOURCE_DB_URL; else url=$TARGET_DB_URL var=TARGET_DB_URL; fi
    problem=$(direct_url_problem "$url")
    [ -z "$problem" ] || refuse "$side: $var $problem"
  done
  [ "${MIG_TEST_ALLOW_LOCAL-}" != 1 ] || warn "MIG_TEST_ALLOW_LOCAL=1: localhost connections accepted (tests only)"

  preflight_connect source
  preflight_connect target
  preflight_versions
}

# Opens a session, applies the session settings with SET and reads them back (R28).
preflight_connect() {
  local side=$1 fn=psql_source url=${SOURCE_DB_URL-} out err got
  if [ "$side" = target ]; then fn=psql_target_ro url=$TARGET_DB_URL; fi
  err=$(mktemp)
  out=$($fn -c "select current_setting('server_version_num'), current_setting('TimeZone'), current_setting('extra_float_digits'), current_setting('bytea_output'), current_setting('IntervalStyle')" 2>"$err") ||
    refuse "$side database unreachable ($(redact_db_url "$url")): $(first_error "$err")"
  rm -f "$err"
  got=${out#*$US}
  [ "$got" = "$MIG_SESSION_EXPECT" ] ||
    refuse "$side session settings did not apply: got '$(printf '%s' "$got" | tr "$US" ' ')', expected '$(printf '%s' "$MIG_SESSION_EXPECT" | tr "$US" ' ')'"
  if [ "$side" = source ]; then MIG_SRC_MAJOR=$((${out%%$US*} / 10000)); else MIG_TGT_MAJOR=$((${out%%$US*} / 10000)); fi
  log "$side  $(redact_db_url "$url")  PostgreSQL $(( ${out%%$US*} / 10000 ))  session settings ok"
}

# R33: a major-version difference only warns; a psql client older than either server refuses.
preflight_versions() {
  local client high=$MIG_SRC_MAJOR
  [ "$MIG_TGT_MAJOR" -le "$high" ] || high=$MIG_TGT_MAJOR
  client=$(version_of "$(psql --version 2>/dev/null)") || refuse "psql not found on PATH"
  version_ge "$client" "$high" ||
    refuse "psql $client is older than the servers (PostgreSQL $high); install psql $high or newer"
  [ "$MIG_SRC_MAJOR" = "$MIG_TGT_MAJOR" ] ||
    warn "source is PostgreSQL $MIG_SRC_MAJOR, target $MIG_TGT_MAJOR: a 4b definition difference may be formatting only"
  log "psql    $client"
}

# What the run needs: read access on the source; on the target, creating the schema, writing and
# deleting the auth rows, referencing and triggering on auth.users, and owning TARGET_SCHEMA if
# it already exists (the load drops it).
preflight_privileges() {
  local missing
  missing=$(psql_def source -f - <<'SQL'
select concat_ws(', ',
  case when not has_table_privilege('auth.users', 'SELECT') then 'SELECT on auth.users' end,
  case when not has_table_privilege('auth.identities', 'SELECT') then 'SELECT on auth.identities' end,
  (select string_agg('SELECT on public.' || t, ', ') from unnest(:'tables'::text[]) t
   where to_regclass('public.' || quote_ident(t)) is not null and not has_table_privilege('public.' || quote_ident(t), 'SELECT')));
SQL
) || die "could not read the source privileges"
  [ -z "$missing" ] || refuse "source: the connecting role lacks $missing"
  missing=$(psql_def target -f - <<'SQL'
select concat_ws(', ',
  case when not has_database_privilege(current_database(), 'CREATE') then 'CREATE on the database' end,
  case when not has_table_privilege('auth.users', 'SELECT') then 'SELECT on auth.users' end,
  case when not has_table_privilege('auth.users', 'INSERT') then 'INSERT on auth.users' end,
  case when not has_table_privilege('auth.users', 'DELETE') then 'DELETE on auth.users' end,
  case when not has_table_privilege('auth.users', 'REFERENCES') then 'REFERENCES on auth.users' end,
  case when not has_table_privilege('auth.users', 'TRIGGER') then 'TRIGGER on auth.users' end,
  case when not has_table_privilege('auth.identities', 'SELECT') then 'SELECT on auth.identities' end,
  case when not has_table_privilege('auth.identities', 'INSERT') then 'INSERT on auth.identities' end,
  case when not has_table_privilege('auth.identities', 'DELETE') then 'DELETE on auth.identities' end,
  (select 'ownership of the existing schema ' || nspname from pg_namespace
   where nspname = :'tschema' and not pg_has_role(nspowner, 'MEMBER')));
SQL
) || die "could not read the target privileges"
  [ -z "$missing" ] || refuse "target: the connecting role lacks $missing"
  log "privileges ok"
}

# The two projects may run different Supabase Auth versions. Every non-generated source column of
# auth.users / auth.identities must be a writable target column, and every target column that is
# NOT NULL without a default must come from the source.
preflight_auth_columns() {
  local sql src tgt problems t
  sql="select c.relname, a.attname, a.attgenerated <> '', a.attnotnull, a.atthasdef or a.attidentity <> ''
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'auth' and c.relname in ('users', 'identities') and a.attnum > 0 and not a.attisdropped;"
  src=$(mktemp) tgt=$(mktemp)
  psql_source -c "$sql" >"$src" || die "could not read the source auth columns"
  psql_target_ro -c "$sql" >"$tgt" || die "could not read the target auth columns"
  problems=$(awk -F"$US" '
    FILENAME == ARGV[1] { src[$1 "." $2] = $3; next }
    { tgt[$1 "." $2] = $3; strict[$1 "." $2] = ($4 == "t" && $5 == "f" && $3 == "f") }
    END {
      for (k in src) if (src[k] == "f") {
        if (!(k in tgt)) print "auth." k " exists only in the source"
        else if (tgt[k] == "t") print "auth." k " is a generated column in the target"
      }
      for (k in tgt) if (strict[k] && !((k in src) && src[k] == "f"))
        print "auth." k " is NOT NULL without a default in the target and not in the source"
    }' "$src" "$tgt" | sort)
  for t in users identities; do
    grep -q "^$t$US" "$src" || problems="$problems${problems:+$'\n'}auth.$t not found in the source"
    grep -q "^$t$US" "$tgt" || problems="$problems${problems:+$'\n'}auth.$t not found in the target"
  done
  rm -f "$src" "$tgt"
  [ -z "$problems" ] || { printf '%s\n' "$problems" | sed 's/^/        /' >&2; refuse "the auth tables cannot be copied between these Supabase Auth versions"; }
  log "auth    columns compatible"
}

# R26: the table list is fixed. Any other table in source public stops the run for a decision,
# and so does a foreign key from one of the 11 to a table that is not copied.
preflight_tables() {
  local problems
  problems=$(psql_def source -f - <<'SQL'
select 'unexpected table public.' || c.relname || ' (not in the 11 tables and not excluded)'
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  and c.relname <> all(:'tables'::text[]) and c.relname <> all(:'excluded'::text[])
union all
select 'missing table public.' || t
from unnest(:'tables'::text[]) t
where to_regclass('public.' || quote_ident(t)) is null
union all
select 'foreign key ' || c.relname || '.' || con.conname || ' references ' || fn.nspname || '.' || fc.relname || ', which is not copied'
from pg_constraint con
join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
join pg_class fc on fc.oid = con.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
where con.contype = 'f' and n.nspname = 'public' and c.relname = any(:'tables'::text[])
  and not ((fn.nspname = 'public' and fc.relname = any(:'tables'::text[])) or (fn.nspname = 'auth' and fc.relname = 'users'))
order by 1;
SQL
) || die "could not read the source tables"
  [ -z "$problems" ] || { printf '%s\n' "$problems" | sed 's/^/        /' >&2; refuse "the source tables differ from the plan's fixed list; update the plan and MIG_TABLES / MIG_EXCLUDED_TABLES first"; }
  log "tables  the 11 tables, nothing else in public"
}

# R26: the source's triggers must be exactly the plan's "Triggers in scope" table (MIG_TRIGGERS).
preflight_triggers() {
  local catalog plan
  catalog=$(psql_def source -f - <<SQL
select concat_ws('|', tbl, tgname, timing, events, level, fn) from (
$(sql_triggers)
) trg;
SQL
) || die "could not read the source triggers"
  catalog=$(printf '%s\n' "$catalog" | sort)
  plan=$(printf '%s\n' "$MIG_TRIGGERS" | sort)
  [ "$catalog" != "$plan" ] || { log "triggers $(printf '%s\n' "$plan" | wc -l | tr -d ' ') triggers, as in the plan"; return; }
  comm -23 <(printf '%s\n' "$catalog") <(printf '%s\n' "$plan") | sed 's/^/        in the source, not in the plan: /' >&2
  comm -13 <(printf '%s\n' "$catalog") <(printf '%s\n' "$plan") | sed 's/^/        in the plan, not in the source: /' >&2
  refuse "the source triggers differ from the plan's trigger table; update the plan and MIG_TRIGGERS first"
}
