# Tasks 1-3 (plan): one load of the target, execution order steps 1-13.
#   1. read-only: refuse on a foreign trigger on the target auth tables (Task 1 step 1)
#   2. read-only: one source snapshot writes the target DDL and every table to the private temp dir
#   3-13. one target transaction: drop and recreate TARGET_SCHEMA, empty the auth tables, create the
#      tables, load the data, then foreign keys, indexes, sequences, functions and triggers.
# Any error rolls the whole transaction back, so the target stays exactly as it was (R23).

# Task 1 step 1. Dropping TARGET_SCHEMA removes only triggers whose function lives in it; any other
# trigger on the target auth tables would fire on every copied row. The script never drops it.
refuse_foreign_auth_triggers() {
  local found
  found=$(psql_def target -f - <<'SQL'
select format('auth.%s trigger %s -> function %s.%s', c.relname, t.tgname, pn.nspname, p.proname)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
join pg_namespace pn on pn.oid = p.pronamespace
where n.nspname = 'auth' and c.relname in ('users', 'identities') and not t.tgisinternal and pn.nspname <> :'tschema'
order by 1;
SQL
) || die "could not read the target's auth triggers"
  [ -z "$found" ] || {
    printf '%s\n' "$found" | sed 's/^/        /' >&2
    refuse "the target auth tables have triggers outside $TARGET_SCHEMA; drop them by hand first (the script never drops anything outside $TARGET_SCHEMA)"
  }
}

# step_load: one complete load.
step_load() {
  local dir plan export load kind tbl cols pk keep src tgt file n_users=0 n_ids=0 n_rows=0 n
  refuse_foreign_auth_triggers
  dir=$MIG_TMP/load
  mkdir -p "$dir/data"
  export=$dir/export.sql load=$dir/load.sql

  plan=$(psql_def source -f - <<<"$(sql_copy_plan)") || die "could not read the source columns; nothing was written"

  # Source: the DDL generators and every \copy, in one REPEATABLE READ READ ONLY snapshot.
  {
    printf "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET search_path = '';\n"
    printf "\\\\o '%s/tables.sql'\n" "$dir"
    sql_gen_tables
    printf "\\\\o '%s/post.sql'\n" "$dir"
    sql_gen_post
    printf '\\o\n'
  } >"$export"

  # Target: Task 1 steps 2-4, then Task 2, then the loads; the post-load DDL follows.
  {
    printf 'DROP SCHEMA IF EXISTS %s CASCADE;\nCREATE SCHEMA %s;\n' "$TARGET_SCHEMA" "$TARGET_SCHEMA"
    cat <<'SQL'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid IN ('auth.users'::regclass, 'auth.identities'::regclass) AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'auth.users / auth.identities still have non-internal triggers after dropping the schema';
  END IF;
END $$;
DELETE FROM auth.identities;
DELETE FROM auth.users;
SQL
    printf "\\\\i '%s/tables.sql'\n" "$dir"
  } >"$load"

  while IFS="$US" read -r kind tbl cols pk keep; do
    if [ "$kind" = auth ]; then src="auth.\"$tbl\"" tgt="auth.\"$tbl\"" file=$dir/data/auth.$tbl.copy
    else src="public.\"$tbl\"" tgt="$TARGET_SCHEMA.\"$tbl\"" file=$dir/data/$tbl.copy; fi
    printf "\\\\copy (select %s from %s) to '%s'\n" "$cols" "$src" "$file" >>"$export"
    printf "\\\\copy %s (%s) from '%s'\n" "$tgt" "$cols" "$file" >>"$load"
  done <<<"$plan"
  printf 'COMMIT;\n' >>"$export"
  printf "\\\\i '%s/post.sql'\n" "$dir" >>"$load"

  log "load: exporting the source in one read-only snapshot"
  psql_def source -f "$export" >/dev/null || die "could not export the source; nothing was written to the target"

  log "load: one target transaction (drop + recreate $TARGET_SCHEMA, auth rows, tables, data, keys, triggers)"
  # Only psql's ERROR line is shown: a DETAIL line can quote row values.
  psql_target -1 -f "$load" >/dev/null 2>"$dir/load.err" || {
    grep -E 'ERROR|FATAL' "$dir/load.err" | sed 's/^psql:[^:]*:[0-9]*: //' >&2 || true
    die "the load failed and was rolled back: the target is exactly as it was before it"
  }

  while IFS="$US" read -r kind tbl _; do
    if [ "$kind" = auth ]; then file=$dir/data/auth.$tbl.copy; else file=$dir/data/$tbl.copy; fi
    n=$(wc -l <"$file" | tr -d ' ')
    case $kind.$tbl in
      auth.users) n_users=$n ;;
      auth.identities) n_ids=$n ;;
      *) n_rows=$((n_rows + n)) ;;
    esac
  done <<<"$plan"
  rm -rf "$dir/data"
  log "load: committed $n_users auth user(s), $n_ids identity(ies), $n_rows row(s) in 11 tables"
}
