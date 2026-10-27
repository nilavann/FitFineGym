# Catalog queries (plan Task 2, Task 3 and 4b). Each function prints SQL for psql_def, which sets
# :'side', :'schema', :'tschema', :'tables', :'rw_from' and :'rw_to'. The same queries build the
# target (Task 2/3) and compare it with the source (4b), so the build and the check cannot drift.
# Every definition is read with search_path = '' so names come out schema-qualified, and only the
# prefix public. is rewritten, on the source side only ("Reading definitions").

# Live columns of the 11 tables in attnum order (dropped columns skipped). pos is the position
# among live columns: attnum keeps gaps where a column was dropped, the recreated table has none.
sql_columns() {
  cat <<'SQL'
select c.relname as tbl,
       row_number() over (partition by c.oid order by a.attnum) as pos,
       a.attname as col,
       format_type(a.atttypid, a.atttypmod) as typ,
       a.attnotnull as not_null,
       coalesce(case when a.attgenerated = '' then regexp_replace(pg_get_expr(d.adbin, d.adrelid), :'rw_from', :'rw_to', 'g') end, '') as dflt,
       a.attidentity as ident,
       coalesce(case when s.seqrelid is not null then format('START WITH %s INCREMENT BY %s MINVALUE %s MAXVALUE %s CACHE %s %s',
                s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache,
                case when s.seqcycle then 'CYCLE' else 'NO CYCLE' end) end, '') as idopts,
       coalesce(sc.relname::text, '') as seqname,
       a.attgenerated as gen,
       coalesce(case when a.attgenerated <> '' then regexp_replace(pg_get_expr(d.adbin, d.adrelid), :'rw_from', :'rw_to', 'g') end, '') as genexpr,
       coalesce(case when a.attcollation <> t.typcollation then format('%I.%I', cn.nspname, co.collname) end, '') as coll
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
join pg_type t on t.oid = a.atttypid
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
left join pg_collation co on co.oid = a.attcollation
left join pg_namespace cn on cn.oid = co.collnamespace
left join pg_depend dep on a.attidentity <> '' and dep.classid = 'pg_class'::regclass and dep.refclassid = 'pg_class'::regclass
     and dep.refobjid = c.oid and dep.refobjsubid = a.attnum and dep.deptype = 'i'
left join pg_class sc on sc.oid = dep.objid and sc.relkind = 'S'
left join pg_sequence s on s.seqrelid = sc.oid
where n.nspname = :'schema' and c.relname = any(:'tables'::text[]) and c.relkind in ('r', 'p')
SQL
}

# Non-internal triggers on the 11 tables and on auth.users / auth.identities, one row each:
# key, timing, events, level, function as stored, function rewritten, definition rewritten,
# tgenabled, plus oid and tgfoid for the queries that build on it.
sql_triggers() {
  cat <<'SQL'
select case when n.nspname = 'auth' then 'auth.' || c.relname else c.relname end as tbl,
       t.tgname,
       case when t.tgtype & 2 <> 0 then 'BEFORE' when t.tgtype & 64 <> 0 then 'INSTEAD OF' else 'AFTER' end as timing,
       concat_ws(' OR ', case when t.tgtype & 4 <> 0 then 'INSERT' end, case when t.tgtype & 16 <> 0 then 'UPDATE' end,
                 case when t.tgtype & 8 <> 0 then 'DELETE' end, case when t.tgtype & 32 <> 0 then 'TRUNCATE' end) as events,
       case when t.tgtype & 1 <> 0 then 'ROW' else 'STATEMENT' end as level,
       pn.nspname || '.' || p.proname as fn,
       regexp_replace(pn.nspname || '.' || p.proname, :'rw_from', :'rw_to', 'g') as fn_rw,
       regexp_replace(pg_get_triggerdef(t.oid), :'rw_from', :'rw_to', 'g') as def_rw,
       t.tgenabled as enabled,
       t.oid, t.tgfoid
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
join pg_namespace pn on pn.oid = p.pronamespace
where not t.tgisinternal
  and ((n.nspname = :'schema' and c.relname = any(:'tables'::text[]))
       or (n.nspname = 'auth' and c.relname in ('users', 'identities')))
SQL
}

# A function's proconfig with search_path mapped for the target: public -> TARGET_SCHEMA, other
# entries kept. On the target side the value is compared as stored. Needs p (pg_proc) in scope.
sql_mapped_config() {
  cat <<'SQL'
(select string_agg(case when cfg like 'search_path=%' and :'side' = 'source'
                        then 'search_path=' || (select string_agg(case when btrim(i) in ('public', '"public"') then quote_ident(:'tschema') else btrim(i) end, ', ' order by o)
                                                from unnest(string_to_array(substr(cfg, 13), ',')) with ordinality x(i, o))
                        else cfg end, ' ' order by cfg)
 from unnest(p.proconfig) cfg)
SQL
}

# --- build (Task 2 / Task 3), run on the source, inside the export snapshot ---------------

# CREATE TABLE for each of the 11 tables, assembled from sql_columns only, with every PK, unique,
# check and exclusion constraint under its source name, then RLS as in the source.
sql_gen_tables() {
  cat <<SQL
with cols as (
$(sql_columns)
),
SQL
  cat <<'SQL'
coldefs as (
  select tbl, string_agg(
           format('    %I %s', col, typ)
           || case when coll <> '' then ' COLLATE ' || coll else '' end
           || case when gen = 's' then ' GENERATED ALWAYS AS (' || genexpr || ') STORED' else '' end
           || case when dflt <> '' then ' DEFAULT ' || dflt else '' end
           || case ident
                when 'a' then format(' GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME %I.%I %s)', :'tschema', seqname, idopts)
                when 'd' then format(' GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME %I.%I %s)', :'tschema', seqname, idopts)
                else '' end
           || case when not_null then ' NOT NULL' else '' end,
           E',\n' order by pos) as body
  from cols group by tbl
),
cons as (
  select c.relname as tbl,
         string_agg(format('    CONSTRAINT %I %s', con.conname, regexp_replace(pg_get_constraintdef(con.oid), :'rw_from', :'rw_to', 'g')),
                    E',\n' order by con.contype <> 'p', con.conname) as body
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = :'schema' and c.relname = any(:'tables'::text[]) and con.contype in ('p', 'u', 'c', 'x')
  group by c.relname
)
select format(E'CREATE TABLE %I.%I (\n%s%s\n);', :'tschema', d.tbl, d.body, coalesce(E',\n' || k.body, ''))
       || case when c.relrowsecurity then format(E'\nALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;', :'tschema', d.tbl) else '' end
       || case when c.relforcerowsecurity then format(E'\nALTER TABLE %I.%I FORCE ROW LEVEL SECURITY;', :'tschema', d.tbl) else '' end
from coldefs d
left join cons k on k.tbl = d.tbl
join pg_namespace n on n.nspname = :'schema'
join pg_class c on c.relnamespace = n.oid and c.relname = d.tbl
order by d.tbl;
SQL
}

# After the load: foreign keys, the indexes no constraint owns, identity sequences, trigger
# functions (search_path mapped), then the triggers, in that order. None of this SQL contains a
# '$', so the unquoted heredocs only expand the $(...) calls.
sql_gen_post() {
  cat <<SQL
select format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s;', :'tschema', c.relname, con.conname,
              regexp_replace(pg_get_constraintdef(con.oid), :'rw_from', :'rw_to', 'g'))
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = :'schema' and c.relname = any(:'tables'::text[]) and con.contype = 'f'
order by c.relname, con.conname;

select regexp_replace(pg_get_indexdef(i.indexrelid), :'rw_from', :'rw_to', 'g') || ';'
from pg_index i
join pg_class c on c.oid = i.indrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_class ic on ic.oid = i.indexrelid
where n.nspname = :'schema' and c.relname = any(:'tables'::text[])
  and not exists (select 1 from pg_constraint con
                  where con.conrelid = i.indrelid and con.conindid = i.indexrelid and con.contype in ('p', 'u', 'x'))
order by c.relname, ic.relname;

select format('SELECT setval(%L, coalesce(max(%I), 1), max(%I) IS NOT NULL) FROM %I.%I;',
              format('%I.%I', :'tschema', seqname), col, col, :'tschema', tbl)
from (
$(sql_columns)
) cols
where ident <> ''
order by tbl;

select regexp_replace(pg_get_functiondef(p.oid), :'rw_from', :'rw_to', 'g') || ';'
       || case when sp.mapped is not null
               then E'\n' || format('ALTER FUNCTION %I.%I(%s) SET search_path = %s;', :'tschema', p.proname,
                                   pg_get_function_identity_arguments(p.oid), sp.mapped)
               else '' end
from pg_proc p
join pg_namespace pn on pn.oid = p.pronamespace
left join lateral (
  select string_agg(case when btrim(i) in ('public', '"public"') then quote_ident(:'tschema') else btrim(i) end, ', ' order by o) as mapped
  from unnest(p.proconfig) cfg
  cross join lateral unnest(string_to_array(substr(cfg, 13), ',')) with ordinality x(i, o)
  where cfg like 'search_path=%'
) sp on true
where pn.nspname = :'schema' and p.oid in (select tgfoid from (
$(sql_triggers)
) trg)
order by p.proname;

select def_rw || ';' from (
$(sql_triggers)
) trg
order by tbl, tgname;
SQL
}

# Copy plan for the 13 tables, read from the source: kind (auth|app), table, the non-generated
# live columns as a quoted list, the primary-key columns in conkey order, and the copied columns
# as an array of literals (4a compares only those for the auth tables).
sql_copy_plan() {
  cat <<'SQL'
select case when n.nspname = 'auth' then 'auth' else 'app' end,
       c.relname,
       (select string_agg(quote_ident(a.attname), ',' order by a.attnum) from pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''),
       (select string_agg('t.' || quote_ident(a.attname), ',' order by array_position(con.conkey, a.attnum))
        from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
        where con.conrelid = c.oid and con.contype = 'p'),
       (select 'array[' || string_agg(quote_literal(a.attname), ',' order by a.attnum) || ']::text[]' from pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where (n.nspname = 'public' and c.relname = any(:'tables'::text[]))
   or (n.nspname = 'auth' and c.relname in ('users', 'identities'))
order by n.nspname <> 'auth', c.relname <> 'users', c.relname;
SQL
}

# --- 4b: one "key<US>field<US>..." row per object ---------------------------------------------

sql_v_columns() {
  cat <<SQL
set search_path = '';
select tbl || '.' || col, pos, typ, not_null, dflt, ident, idopts, seqname, gen, genexpr, coll from (
$(sql_columns)
) cols;
SQL
}
V_COLUMNS_FIELDS="position type not_null default identity identity_options sequence generated generation_expression collation"

sql_v_constraints() {
  cat <<'SQL'
set search_path = '';
select c.relname || '.' || con.conname, con.contype,
       regexp_replace(pg_get_constraintdef(con.oid), :'rw_from', :'rw_to', 'g'), con.convalidated
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = :'schema' and c.relname = any(:'tables'::text[]) and con.contype in ('p', 'u', 'c', 'f', 'x');
SQL
}
V_CONSTRAINTS_FIELDS="type definition validated"

sql_v_indexes() {
  cat <<'SQL'
set search_path = '';
select c.relname || '.' || ic.relname, regexp_replace(pg_get_indexdef(i.indexrelid), :'rw_from', :'rw_to', 'g')
from pg_index i
join pg_class c on c.oid = i.indrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_class ic on ic.oid = i.indexrelid
where n.nspname = :'schema' and c.relname = any(:'tables'::text[]);
SQL
}
V_INDEXES_FIELDS="definition"

sql_v_triggers() {
  cat <<SQL
set search_path = '';
select tbl || '.' || tgname, timing, events, level, fn_rw, def_rw, enabled from (
$(sql_triggers)
) trg;
SQL
}
V_TRIGGERS_FIELDS="timing events level function definition enabled"

sql_v_rls() {
  cat <<'SQL'
set search_path = '';
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = :'schema' and c.relname = any(:'tables'::text[]) and c.relkind in ('r', 'p');
SQL
}
V_RLS_FIELDS="row_security force_row_security"

# The trigger functions, compared part by part (R18): the full pg_get_functiondef text differs by
# design in its SET search_path line. The body is compared by hash, after the same prefix rewrite.
sql_v_functions() {
  cat <<SQL
set search_path = '';
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       md5(regexp_replace(p.prosrc, :'rw_from', :'rw_to', 'g')), p.prosecdef, p.provolatile, l.lanname,
       regexp_replace(pg_get_function_arguments(p.oid), :'rw_from', :'rw_to', 'g'),
       regexp_replace(pg_get_function_result(p.oid), :'rw_from', :'rw_to', 'g'),
       coalesce($(sql_mapped_config), '')
from pg_proc p
join pg_namespace pn on pn.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
where pn.nspname = :'schema' and p.oid in (select tgfoid from (
$(sql_triggers)
) trg);
SQL
}
V_FUNCTIONS_FIELDS="body_hash security_definer volatility language arguments result config"

sql_v_sequences() {
  cat <<SQL
set search_path = '';
select cols.tbl || '.' || cols.col, cols.seqname, format_type(s.seqtypid, null), s.seqstart, s.seqincrement,
       s.seqmin, s.seqmax, s.seqcache, s.seqcycle
from (
$(sql_columns)
) cols
join pg_namespace sn on sn.nspname = :'schema'
join pg_class sc on sc.relnamespace = sn.oid and sc.relname = cols.seqname
join pg_sequence s on s.seqrelid = sc.oid
where cols.ident <> '';
SQL
}
V_SEQUENCES_FIELDS="sequence type start increment min max cache cycle"

# Target only: per identity column, whether the next value the sequence hands out is above the
# table's max(id). Read from the sequence's own last_value / is_called, never nextval.
sql_v_seq_next() {
  cat <<SQL
set search_path = '';
select format('select %L, (case when s.is_called then s.last_value + %s else s.last_value end) > coalesce((select max(%I) from %I.%I), 0) from %I.%I s',
              cols.tbl || '.' || cols.col, s.seqincrement, cols.col, :'schema', cols.tbl, :'schema', cols.seqname)
from (
$(sql_columns)
) cols
join pg_namespace sn on sn.nspname = :'schema'
join pg_class sc on sc.relnamespace = sn.oid and sc.relname = cols.seqname
join pg_sequence s on s.seqrelid = sc.oid
where cols.ident <> ''
\gexec
SQL
}
