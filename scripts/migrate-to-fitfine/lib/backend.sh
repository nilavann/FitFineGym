# --validate-backend: checks the target's backend against
# its design (supabase/migrations), not against the source (the target is meant to differ). Read-only.
#
# Two layers, both by check id B.1-B.11 (the design's list, in order):
#   - the snapshot: every catalog fact the design fixes (schema, table, column and function ACLs,
#     policies, check constraints, function attributes and bodies, triggers, views, the bucket,
#     default privileges) must equal backend-expected.txt, the same snapshot taken of a database
#     built from supabase/migrations (tests/backend-expected.sh writes it);
#   - the rules: each rule of the design checked on its own, so a broken rule fails even where the
#     expected file was regenerated from a broken build.
# B.12 lists active users without a role (they lose access under the new rule); never a failure.
# Output, as for 4a/4b: "ok   B.n ..." or "FAIL B.n <object> <detail>". Definitions only, no row
# contents; B.12 names profile ids, the primary key.

MIG_BACKEND_EXPECTED=${MIG_BACKEND_EXPECTED:-$MIG_DIR/backend-expected.txt}
MIG_B_FAILS=0

b_fail() { fail_line "$@"; MIG_B_FAILS=$((MIG_B_FAILS + 1)); }

# Sorted ACL entries of an aclitem[] expression, or 'default' for NULL / empty.
b_acl() { printf "coalesce(nullif(array_to_string(array(select x::text from unnest(%s) x order by 1), ' '), ''), 'default')" "$1"; }

# One line per fact: id<US>object<US>value, whitespace runs collapsed so every value is one line.
sql_backend_snapshot() {
  cat <<SQL
set search_path = '';
select id, obj, regexp_replace(val, '\s+', ' ', 'g') from (
  select 'B.1' id, n.nspname::text obj, $(b_acl n.nspacl) val
  from pg_namespace n where n.nspname in ('fitfine', 'fitfine_private')
  union all
  select 'B.2', c.relname || ' (' || c.relkind::text || ')', $(b_acl c.relacl)
  from pg_class c where c.relnamespace in ('fitfine'::regnamespace, 'fitfine_private'::regnamespace)
    and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all
  select 'B.2', c.relname || '.' || a.attname, $(b_acl a.attacl)
  from pg_attribute a join pg_class c on c.oid = a.attrelid
  where c.relnamespace in ('fitfine'::regnamespace, 'fitfine_private'::regnamespace)
    and a.attnum > 0 and not a.attisdropped and a.attacl is not null
  union all
  select 'B.3', p.schemaname || '.' || p.tablename || '.' || p.policyname,
         p.permissive || ' ' || p.cmd || ' to ' || array_to_string(p.roles, ',')
         || ' using ' || coalesce(p.qual, '-') || ' check ' || coalesce(p.with_check, '-')
  from pg_policies p
  where p.schemaname in ('fitfine', 'fitfine_private') or (p.schemaname = 'storage' and p.tablename in ('objects', 'buckets'))
  union all
  select 'B.4', c.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
  from pg_constraint con join pg_class c on c.oid = con.conrelid
  where c.relnamespace = 'fitfine'::regnamespace and con.contype = 'c'
  union all
  select 'B.5', p.oid::regprocedure::text,
         case when p.prosecdef then 'definer' else 'invoker' end || ' ' || p.provolatile::text
         || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-')
         || ' acl=' || $(b_acl p.proacl) || ' body=' || md5(p.prosrc)
  from pg_proc p where p.pronamespace in ('fitfine'::regnamespace, 'fitfine_private'::regnamespace)
  union all
  select 'B.8', tg.tgrelid::regclass::text || '.' || tg.tgname, pg_get_triggerdef(tg.oid)
  from pg_trigger tg join pg_proc f on f.oid = tg.tgfoid
  where not tg.tgisinternal
    and (tg.tgrelid in (select oid from pg_class where relnamespace = 'fitfine'::regnamespace)
         or f.pronamespace in ('fitfine'::regnamespace, 'fitfine_private'::regnamespace))
  union all
  select 'B.9', c.relname, coalesce(array_to_string(c.reloptions, ','), '-') || ' def=' || md5(pg_get_viewdef(c.oid))
  from pg_class c where c.relnamespace = 'fitfine'::regnamespace and c.relkind = 'v'
  union all
  select 'B.10', 'bucket ' || b.id, b.public::text || ' ' || coalesce(b.file_size_limit::text, '-')
         || ' ' || coalesce(array_to_string(b.allowed_mime_types, ','), '-')
  from storage.buckets b where b.id = 'member-photos'
  union all
  select 'B.11', coalesce(n.nspname, '(all schemas)') || ' ' || d.defaclobjtype::text, $(b_acl d.defaclacl)
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  where d.defaclrole = 'postgres'::regrole and (d.defaclnamespace = 0 or n.nspname in ('fitfine', 'fitfine_private'))
) facts
order by 1, 2;
SQL
}

# The plan's rules, one row per violation: id<US>object<US>detail.
sql_backend_rules() {
  cat <<'SQL'
set search_path = '';
with
ff  as (select 'fitfine'::regnamespace as oid),
ffp as (select 'fitfine_private'::regnamespace as oid),
fns as (select p.*, n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('fitfine', 'fitfine_private'))
-- B.1: anon gets no USAGE on either schema; authenticated and service_role get it on both
select 'B.1' id, n.nspname::text obj, 'anon holds USAGE' detail
from pg_namespace n where n.nspname in ('fitfine', 'fitfine_private') and has_schema_privilege('anon', n.oid, 'USAGE')
union all
select 'B.1', n.nspname, r || ' lacks USAGE'
from pg_namespace n, unnest(array['authenticated', 'service_role']) r
where n.nspname in ('fitfine', 'fitfine_private') and not has_schema_privilege(r, n.oid, 'USAGE')
-- B.2: nobody but the owner holds DELETE, TRUNCATE, REFERENCES or TRIGGER; anon holds nothing
union all
select 'B.2', c.relname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || ' holds ' || a.privilege_type
from pg_class c, aclexplode(c.relacl) a
where c.relnamespace in ((select oid from ff), (select oid from ffp)) and a.grantee <> c.relowner
  and (a.privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') or a.grantee in (0, 'anon'::regrole::oid))
union all
select 'B.2', c.relname || '.' || at.attname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || ' holds column ' || a.privilege_type
from pg_attribute at join pg_class c on c.oid = at.attrelid, aclexplode(at.attacl) a
where c.relnamespace = (select oid from ff) and a.grantee in (0, 'anon'::regrole::oid)
-- B.3: every fitfine policy is TO authenticated and calls the helpers as (select ...)
union all
select 'B.3', p.tablename || '.' || p.policyname, 'roles are ' || array_to_string(p.roles, ',') || ', not authenticated'
from pg_policies p where (p.schemaname = 'fitfine' or (p.schemaname = 'storage' and p.policyname like 'member_photos_%'))
  and p.roles <> '{authenticated}'
union all
select 'B.3', p.tablename || '.' || p.policyname, 'calls a helper without (select ...)'
from pg_policies p where p.schemaname in ('fitfine', 'storage')
  and regexp_replace(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
        '\( SELECT fitfine_private\.is_active_(user|admin)\(\) AS is_active_(user|admin)\)', '', 'g') ~ 'is_active_(user|admin)'
-- B.4: the new constraints are all validated
union all
select 'B.4', c.relname || '.' || con.conname, 'is NOT VALID'
from pg_constraint con join pg_class c on c.oid = con.conrelid
where c.relnamespace = (select oid from ff) and con.contype = 'c' and not con.convalidated
-- B.5: search_path = '' everywhere; who may execute; SECURITY DEFINER where the design says
union all
select 'B.5', f.oid::regprocedure::text, 'search_path is not '''''
from fns f where not coalesce(f.proconfig, '{}') @> array['search_path=""']
union all
select 'B.5', f.oid::regprocedure::text, 'executable by ' || r
from fns f, unnest(array['anon', 'public']) r
where (r = 'anon' and has_function_privilege('anon', f.oid, 'EXECUTE'))
   or (r = 'public' and exists (select 1 from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a where a.grantee = 0))
union all
select 'B.5', f.oid::regprocedure::text, 'executable by authenticated'
from fns f
where has_function_privilege('authenticated', f.oid, 'EXECUTE')
  and f.oid::regprocedure::text not in ('fitfine.update_member_number_config(integer,integer,integer)',
                                        'fitfine_private.is_active_user()', 'fitfine_private.is_active_admin()')
union all
select 'B.5', f.oid::regprocedure::text, 'executable by service_role'
from fns f
where has_function_privilege('service_role', f.oid, 'EXECUTE')
  and (f.nspname = 'fitfine_private' or f.proname = 'update_member_number_config')
union all
select 'B.5', f.oid::regprocedure::text, 'not SECURITY DEFINER'
from fns f where not f.prosecdef and f.proname not in ('prevent_hard_delete', 'protect_system_admin_role')
-- B.6: no dynamic SQL
union all
select 'B.6', f.oid::regprocedure::text, 'its body contains execute'
from fns f where f.prosrc ~* '\mexecute\M'
-- B.7: only handle_new_auth_user reads the user metadata; no policy does
union all
select 'B.7', f.oid::regprocedure::text, 'reads raw_user_meta_data / user_metadata'
from fns f where f.prosrc ~* '(raw_user_meta_data|user_metadata)' and f.oid <> 'fitfine_private.handle_new_auth_user()'::regprocedure
union all
select 'B.7', p.schemaname || '.' || p.tablename || '.' || p.policyname, 'reads raw_user_meta_data / user_metadata'
from pg_policies p where coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') ~* '(raw_user_meta_data|user_metadata)'
-- B.8: the 26 triggers run fitfine_private functions; the invite trigger is AFTER INSERT only
union all
select 'B.8', tg.tgrelid::regclass::text || '.' || tg.tgname, 'runs ' || tg.tgfoid::regproc::text || ', not a fitfine_private function'
from pg_trigger tg
where not tg.tgisinternal and tg.tgrelid in (select oid from pg_class where relnamespace = (select oid from ff))
  and (select pronamespace from pg_proc where oid = tg.tgfoid) <> (select oid from ffp)
union all
select 'B.8', 'auth.users.trg_handle_new_auth_user', 'missing, or not AFTER INSERT FOR EACH ROW running fitfine_private.handle_new_auth_user()'
where not exists (
  select 1 from pg_trigger tg
  where tg.tgname = 'trg_handle_new_auth_user' and tg.tgrelid = 'auth.users'::regclass
    and pg_get_triggerdef(tg.oid) = 'CREATE TRIGGER trg_handle_new_auth_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION fitfine_private.handle_new_auth_user()')
union all
select 'B.8', 'triggers', count(*) || ' run fitfine_private functions, expected 26'
from pg_trigger tg join pg_proc f on f.oid = tg.tgfoid
where not tg.tgisinternal and f.pronamespace = (select oid from ffp)
having count(*) <> 26
-- B.9: the views follow the caller's RLS
union all
select 'B.9', c.relname, 'is not security_invoker'
from pg_class c where c.relnamespace = (select oid from ff) and c.relkind = 'v'
  and not coalesce(c.reloptions, '{}') @> array['security_invoker=true']
union all
select 'B.9', 'views', count(*) || ' views in fitfine, expected 3'
from pg_class c where c.relnamespace = (select oid from ff) and c.relkind = 'v' having count(*) <> 3
-- B.10: the bucket stays private and SVG-free; every write policy carries the path rule
union all
select 'B.10', 'bucket member-photos', 'missing' where not exists (select 1 from storage.buckets where id = 'member-photos')
union all
select 'B.10', 'bucket member-photos', 'is public' from storage.buckets where id = 'member-photos' and public
union all
select 'B.10', 'bucket member-photos', 'allows image/svg+xml' from storage.buckets where id = 'member-photos' and 'image/svg+xml' = any (allowed_mime_types)
union all
select 'B.10', 'storage.objects.' || x.policyname, 'missing'
from unnest(array['member_photos_select_active_users', 'member_photos_insert_active_users',
                  'member_photos_update_active_users', 'member_photos_delete_active_users']) x(policyname)
where not exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = x.policyname)
union all
select 'B.10', 'storage.objects.' || p.policyname, 'lacks the path rule'
from pg_policies p
where p.schemaname = 'storage' and p.tablename = 'objects' and p.cmd in ('INSERT', 'UPDATE', 'DELETE')
  and ((p.cmd in ('UPDATE', 'DELETE') and position('^[1-9][0-9]*/(original|thumbnail)-[0-9]+\.jpg$' in coalesce(p.qual, '')) = 0)
    or (p.cmd in ('INSERT', 'UPDATE') and position('^[1-9][0-9]*/(original|thumbnail)-[0-9]+\.jpg$' in coalesce(p.with_check, '')) = 0))
-- B.11: a new function is not executable by PUBLIC by default
union all
select 'B.11', 'default privileges', 'functions created by postgres are still executable by PUBLIC'
where exists (
  select 1 from aclexplode(coalesce(
    (select defaclacl from pg_default_acl where defaclrole = 'postgres'::regrole and defaclnamespace = 0 and defaclobjtype = 'f'),
    acldefault('f', 'postgres'::regrole))) a
  where a.grantee = 0)
order by 1, 2, 3;
SQL
}

# B.12: active, non-deleted profiles without a non-deleted role. Information only.
sql_backend_roleless() {
  cat <<'SQL'
set search_path = '';
select p.id from fitfine.profiles p
where p.is_active and p.deleted_at is null
  and not exists (select 1 from fitfine.user_roles ur join fitfine.roles r on r.id = ur.role_id
                  where ur.user_id = p.id and r.deleted_at is null)
order by 1;
SQL
}

# Prints the snapshot of TARGET_DB_URL as id<TAB>object<TAB>value lines (tests/backend-expected.sh).
backend_snapshot() {
  sql_backend_snapshot | psql_target_ro -f - | tr "$US" '\t'
}

# Task 0 for this mode: only the target is needed.
preflight_backend() {
  local problem
  require_vars TARGET_DB_URL
  problem=$(direct_url_problem "$TARGET_DB_URL")
  [ -z "$problem" ] || refuse "target: TARGET_DB_URL $problem"
  [ "${MIG_TEST_ALLOW_LOCAL-}" != 1 ] || warn "MIG_TEST_ALLOW_LOCAL=1: localhost connections accepted (tests only)"
  [ -f "$MIG_BACKEND_EXPECTED" ] || refuse "expected snapshot missing: $MIG_BACKEND_EXPECTED"
  preflight_connect target
}

step_validate_backend() {
  local id err actual rules roleless out before=$MIG_B_FAILS
  err=$(mktemp) actual=$(mktemp)
  log "validate backend: the target against phase-2-plan.md (snapshot $(basename "$MIG_BACKEND_EXPECTED") and rules)"

  if ! backend_snapshot >"$actual" 2>"$err"; then
    b_fail B - "snapshot query failed: $(first_error "$err")"; rm -f "$err" "$actual"; return "$EXIT_FAIL"
  fi
  if ! rules=$(sql_backend_rules | psql_target_ro -f - 2>"$err"); then
    b_fail B - "rules query failed: $(first_error "$err")"; rm -f "$err" "$actual"; return "$EXIT_FAIL"
  fi

  for id in B.1 B.2 B.3 B.4 B.5 B.6 B.7 B.8 B.9 B.10 B.11; do
    local n=$MIG_B_FAILS
    out=$(awk -F'\t' -v id="$id" '
      FILENAME == ARGV[1] { if ($1 == id) want[$2] = $3; next }
      $1 == id { have[$2] = $3 }
      END {
        for (k in want) if (!(k in have)) print "FAIL " id " " k " missing"
        for (k in have) if (!(k in want)) print "FAIL " id " " k " not in the design: " have[k]
        for (k in want) if ((k in have) && want[k] != have[k]) print "FAIL " id " " k " expected " want[k] "; found " have[k]
      }' "$MIG_BACKEND_EXPECTED" "$actual" | sort)
    if [ -n "$out" ]; then
      printf '%s\n' "$out"; MIG_B_FAILS=$((MIG_B_FAILS + $(printf '%s\n' "$out" | wc -l)))
    fi
    while IFS="$US" read -r rid obj detail; do
      [ "$rid" = "$id" ] || continue
      b_fail "$id" "$obj" "$detail"
    done <<<"$rules"
    [ "$MIG_B_FAILS" != "$n" ] || ok_line "$id" "$(b_label "$id")"
  done

  if roleless=$(sql_backend_roleless | psql_target_ro -f - 2>"$err"); then
    if [ -z "$roleless" ]; then
      ok_line B.12 "every active user holds a role"
    else
      log "B.12    $(printf '%s\n' "$roleless" | wc -l | tr -d ' ') active user(s) hold no role and lose access under the new rule:"
      printf '%s\n' "$roleless" | sed 's/^/        profile /' >&2
      ok_line B.12 "listed above: active users without a role (information, not a failure)"
    fi
  else
    b_fail B.12 - "query failed: $(first_error "$err")"
  fi
  rm -f "$err" "$actual"

  if [ "$MIG_B_FAILS" = "$before" ]; then log "validate backend ok: every check passed"; return "$EXIT_OK"; fi
  log "validate backend FAILED: $((MIG_B_FAILS - before)) problem(s)"
  return "$EXIT_FAIL"
}

b_label() {
  case $1 in
    B.1)  printf 'schemas and their USAGE grants' ;;
    B.2)  printf 'table, view and column grants; nothing beyond the design' ;;
    B.3)  printf 'policies' ;;
    B.4)  printf 'check constraints, sets A and B, validated' ;;
    B.5)  printf 'functions: schema, SECURITY DEFINER, search_path, EXECUTE' ;;
    B.6)  printf 'no dynamic SQL in any function' ;;
    B.7)  printf 'only handle_new_auth_user reads the user metadata' ;;
    B.8)  printf 'the 26 triggers on fitfine_private; invite trigger AFTER INSERT only' ;;
    B.9)  printf 'views are security_invoker' ;;
    B.10) printf 'bucket settings and the four storage policies' ;;
    B.11) printf 'default privileges' ;;
  esac
}
