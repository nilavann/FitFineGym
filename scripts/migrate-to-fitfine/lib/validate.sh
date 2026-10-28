# Task 4a (data) and 4b (definitions), read-only on both sides. Each check prints "ok   <id> ..."
# or one "FAIL <id> <object> <detail>" line per problem; step_validate returns 1 on any FAIL.
# No line ever holds a row value: 4a names the table, primary key and column only.

MIG_V_FAILS=0

v_fail() { fail_line "$@"; MIG_V_FAILS=$((MIG_V_FAILS + 1)); }

# v_lines ID OUTPUT: prints OUTPUT (FAIL lines from a comparison) and counts them, or prints
# "ok ID DETAIL" when OUTPUT is empty.
v_lines() {
  local id=$1 out=$2 n
  if [ -z "$out" ]; then ok_line "$id" "${3-}"; return; fi
  printf '%s\n' "$out"
  n=$(printf '%s\n' "$out" | grep -c '^FAIL' || true)
  MIG_V_FAILS=$((MIG_V_FAILS + n))
}

# --- 4a ------------------------------------------------------------------------------------

# 4a #1 and #2 for the 13 tables. Each side is exported to the private temp dir as one line per row,
# "<primary key as JSON><TAB><row as jsonb>", ordered by the source's primary-key columns. jsonb
# text has a fixed key order, so equal rows give equal lines whatever the column order.
check_data() {
  local dir plan side fn schema script kind tbl cols pk keep drop label s t ns nt line pk_s pk_t keys
  dir=$(mktemp -d "$MIG_TMP/validate.XXXXXX")
  plan=$(psql_def source -f - <<<"$(sql_copy_plan)") || { v_fail 4a.1 - "could not read the source catalog"; return; }

  for side in source target; do
    fn=psql_source schema=public
    [ $side = source ] || fn=psql_target_ro schema=$TARGET_SCHEMA
    mkdir -p "$dir/$side"
    script=$dir/$side.sql
    : >"$script"
    while IFS="$US" read -r kind tbl cols pk keep; do
      drop=''
      if [ "$kind" = auth ]; then
        # Only the copied columns: generated and target-only auth columns are not compared.
        drop=" - array(select a.attname::text from pg_attribute a where a.attrelid = 'auth.\"$tbl\"'::regclass and a.attnum > 0 and not a.attisdropped and a.attname <> all($keep))"
        label=auth.$tbl
        printf "\\\\o '%s/%s/%s'\n" "$dir" "$side" "$label" >>"$script"
        printf "select jsonb_build_array(%s)::text || chr(9) || (to_jsonb(t)%s)::text from auth.\"%s\" t order by %s;\n" "$pk" "$drop" "$tbl" "$pk" >>"$script"
      else
        printf "\\\\o '%s/%s/%s'\n" "$dir" "$side" "$tbl" >>"$script"
        printf "select jsonb_build_array(%s)::text || chr(9) || to_jsonb(t)::text from %s.\"%s\" t order by %s;\n" "$pk" "$schema" "$tbl" "$pk" >>"$script"
      fi
    done <<<"$plan"
    printf '\\o\n' >>"$script"
    $fn -f "$script" >/dev/null 2>"$dir/$side.err" || {
      v_fail 4a.1 - "could not export the $side: $(first_error "$dir/$side.err")"
      rm -rf "$dir"; return
    }
  done

  while IFS="$US" read -r kind tbl _; do
    label=$tbl; [ "$kind" != auth ] || label=auth.$tbl
    s=$dir/source/$label t=$dir/target/$label
    ns=$(wc -l <"$s" | tr -d ' ') nt=$(wc -l <"$t" | tr -d ' ')
    if [ "$ns" = "$nt" ]; then ok_line 4a.1 "$label $ns = $nt"; else v_fail 4a.1 "$label" "source $ns rows, target $nt rows"; fi
    if cmp -s "$s" "$t"; then ok_line 4a.2 "$label"; continue; fi
    line=$(awk 'FILENAME == ARGV[1] { a[FNR] = $0; na = FNR; next }
                { nb = FNR; if (!(FNR in a) || a[FNR] != $0) { print FNR; found = 1; exit } }
                END { if (!found && na != nb) print (na < nb ? na : nb) + 1 }' "$s" "$t")
    pk_s=$(sed -n "${line}p" "$s" | cut -f1) pk_t=$(sed -n "${line}p" "$t" | cut -f1)
    if [ -z "$pk_t" ]; then v_fail 4a.2 "$label" "row $pk_s is only in the source"
    elif [ -z "$pk_s" ]; then v_fail 4a.2 "$label" "row $pk_t is only in the target"
    elif [ "$pk_s" != "$pk_t" ]; then v_fail 4a.2 "$label" "first difference: source row $pk_s, target row $pk_t (a row is missing on one side)"
    else
      sed -n "${line}p" "$s" | cut -f2- >"$dir/a.json"
      sed -n "${line}p" "$t" | cut -f2- >"$dir/b.json"
      keys=$(jq -r -n --slurpfile a "$dir/a.json" --slurpfile b "$dir/b.json" \
        '$a[0] as $x | $b[0] as $y | [($x | keys[]), ($y | keys[])] | unique | map(select($x[.] != $y[.])) | join(", ")' 2>/dev/null) || keys=''
      v_fail 4a.2 "$label" "row $pk_s differs in column(s): ${keys:-<formatting only>}"
    fi
  done <<<"$plan"
  rm -rf "$dir"
}

# --- 4b ------------------------------------------------------------------------------------

# v_compare ID FIELDS SQL: runs SQL (rows "key<US>field...") on both sides and prints one FAIL per
# key found on one side only, or per key whose fields differ, naming each differing field.
v_compare() {
  local id=$1 fields=$2 sql=$3 a b out
  a=$(mktemp) b=$(mktemp)
  if ! psql_def source -f - <<<"$sql" >"$a" 2>"$a.err"; then v_fail "$id" - "source query failed: $(first_error "$a.err")"; rm -f "$a" "$a.err" "$b"; return; fi
  if ! psql_def target -f - <<<"$sql" >"$b" 2>"$b.err"; then v_fail "$id" - "target query failed: $(first_error "$b.err")"; rm -f "$a" "$a.err" "$b" "$b.err"; return; fi
  out=$(awk -F"$US" -v id="$id" -v fields="$fields" '
    function show(v) { return v == "" ? "(none)" : v }
    BEGIN { nf = split(fields, name, " ") }
    FILENAME == ARGV[1] { src[$1] = $0; next }
    { tgt[$1] = $0 }
    END {
      for (k in src) if (!(k in tgt)) print "FAIL " id " " k " only in the source"
      for (k in tgt) if (!(k in src)) print "FAIL " id " " k " only in the target"
      for (k in src) if ((k in tgt) && src[k] != tgt[k]) {
        split(src[k], s, FS); split(tgt[k], t, FS); d = ""
        for (i = 1; i <= nf; i++) if (s[i + 1] != t[i + 1])
          d = d (d == "" ? "" : "; ") name[i] ": source " show(s[i + 1]) ", target " show(t[i + 1])
        print "FAIL " id " " k " " d
      }
    }' "$a" "$b" | sort)
  rm -f "$a" "$a.err" "$b" "$b.err"
  v_lines "$id" "$out" "${4-}"
}

# v_target_only ID SQL DETAIL: one FAIL per row SQL returns on the target.
v_target_only() {
  local id=$1 rows err
  err=$(mktemp)
  rows=$(psql_def target -f - <<<"$2" 2>"$err") || { v_fail "$id" - "target query failed: $(first_error "$err")"; rm -f "$err"; return; }
  rm -f "$err"
  [ -z "$rows" ] || v_lines "$id" "$(printf '%s\n' "$rows" | sed "s/^/FAIL $id /; s/\$/ $3/")"
}

check_definitions() {
  v_compare 4b.3 "$V_COLUMNS_FIELDS" "$(sql_v_columns)" "columns"
  v_compare 4b.4 "$V_CONSTRAINTS_FIELDS" "$(sql_v_constraints)" "constraints"
  v_target_only 4b.4 "set search_path = '';
select c.relname || '.' || con.conname from pg_constraint con join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = :'schema' and c.relname = any(:'tables'::text[]) and con.contype = 'f' and not con.convalidated;" "foreign key is not validated"
  v_compare 4b.5 "$V_INDEXES_FIELDS" "$(sql_v_indexes)" "indexes"
  v_compare 4b.6 "$V_TRIGGERS_FIELDS" "$(sql_v_triggers)" "triggers"
  v_target_only 4b.6 "set search_path = '';
select tbl || '.' || tgname from (
$(sql_triggers)
) trg where enabled <> 'O';" "trigger is not enabled"
  v_compare 4b.7 "$V_RLS_FIELDS" "$(sql_v_rls)" "row level security"
  v_compare 4b.8 "$V_FUNCTIONS_FIELDS" "$(sql_v_functions)" "trigger functions"
  v_compare 4b.9 "$V_SEQUENCES_FIELDS" "$(sql_v_sequences)" "identity sequence options"
  check_seq_next
}

# 4b #9, target only: each identity sequence hands out a value above its table's max(id).
check_seq_next() {
  local rows err key above before=$MIG_V_FAILS
  err=$(mktemp)
  rows=$(psql_def target -f - <<<"$(sql_v_seq_next)" 2>"$err") || { v_fail 4b.9 - "target query failed: $(first_error "$err")"; rm -f "$err"; return; }
  rm -f "$err"
  while IFS="$US" read -r key above; do
    [ -n "$key" ] || continue
    [ "$above" = t ] || v_fail 4b.9 "$key" "the next value of its sequence is not above max(id)"
  done <<<"$rows"
  [ "$MIG_V_FAILS" != "$before" ] || ok_line 4b.9 "identity sequence next values above max(id)"
}

# 4a then 4b. Returns 1 when any check failed.
step_validate() {
  local before=$MIG_V_FAILS
  log "validate 4a: counts and row comparison of the 13 tables"
  check_data
  log "validate 4b: definitions"
  check_definitions
  if [ "$MIG_V_FAILS" = "$before" ]; then log "validate ok: every 4a and 4b check passed"; return "$EXIT_OK"; fi
  log "validate FAILED: $((MIG_V_FAILS - before)) problem(s)"
  return "$EXIT_FAIL"
}
