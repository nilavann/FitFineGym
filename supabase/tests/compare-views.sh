#!/usr/bin/env bash
# The views' check: on the same data, each fitfine view read by an
# active staff user (security_invoker, so under that user's RLS) returns the same rows as the
# source's view (which bypasses RLS). profiles_with_roles is compared for non-deleted profiles,
# the only ones the frontend asks for. Read-only on both sides; prints row counts, never rows.
#
#   tests/compare-views.sh SOURCE_DB_URL FITFINE_DB_URL STAFF_USER_ID
#
# The two databases must hold the same data: the source and a target loaded from it by the Phase 1
# script, before anyone writes to either.
set -euo pipefail
[ $# = 3 ] || { echo "usage: $0 SOURCE_DB_URL FITFINE_DB_URL STAFF_USER_ID" >&2; exit 2; }
SRC=$1 DST=$2 STAFF=$3
case $STAFF in *[!0-9a-fA-F-]*|'') echo "STAFF_USER_ID is not a uuid" >&2; exit 2 ;; esac

ro=(psql -X -q -At -v ON_ERROR_STOP=1 -c "set default_transaction_read_only = on" -c "set timezone = 'UTC'")

# Each view's rows as text, one line each, sorted.
views=(
  "member_list_view|select v::text from %s.member_list_view v order by 1"
  "member_current_items|select v::text from %s.member_current_items v order by 1"
  "profiles_with_roles|select v::text from %s.profiles_with_roles v where v.deleted_at is null order by 1"
)

fail=0
tmp=$(mktemp -d)
trap 'rm -r "$tmp"' EXIT
for entry in "${views[@]}"; do
  name=${entry%%|*} sql=${entry#*|}
  # shellcheck disable=SC2059
  "${ro[@]}" -d "$SRC" -c "$(printf "$sql" public)" >"$tmp/src"
  # shellcheck disable=SC2059
  "${ro[@]}" -d "$DST" -c "begin" \
    -c "select set_config('request.jwt.claims', json_build_object('sub', '$STAFF', 'role', 'authenticated')::text, true)" \
    -c "set local role authenticated" -c "$(printf "$sql" fitfine)" -c "rollback" | sed '1d' >"$tmp/dst"
  if cmp -s "$tmp/src" "$tmp/dst"; then
    echo "ok   $name: $(wc -l <"$tmp/src" | tr -d ' ') rows, identical"
  else
    echo "FAIL $name: source $(wc -l <"$tmp/src" | tr -d ' ') rows, fitfine $(wc -l <"$tmp/dst" | tr -d ' ') rows, $(diff "$tmp/src" "$tmp/dst" | grep -c '^[<>]') differing"
    fail=1
  fi
done
exit $fail
