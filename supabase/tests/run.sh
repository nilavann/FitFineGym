#!/usr/bin/env bash
# The fitfine backend tests: the access matrix and the
# behaviour tests, one *.test.sql file each. Every file runs in one transaction that ends in
# ROLLBACK, including its assertion helpers (framework.sql) and fixtures, so a run leaves nothing
# behind.
#
#   tests/run.sh
#       Local: builds a throwaway database on a reachable Postgres server (PGHOST / PGPORT /
#       PGUSER, superuser) from supabase-stub.sql and every migration in supabase/migrations/,
#       runs every test, drops the database. local-db.sh starts a suitable server.
#   FITFINE_TEST_DB_URL=postgresql://... tests/run.sh
#       An existing database that already has the migrations applied: a scratch project only.
#       Never production: rolled-back inserts still consume identity values.
#
# Needs psql. Bash 3.2 compatible.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORKDIR=$(cd "$HERE/.." && pwd)
STUB=$HERE/supabase-stub.sql
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

if [ -n "${FITFINE_TEST_DB_URL-}" ]; then
  DB_URL=$FITFINE_TEST_DB_URL
  cleanup() { :; }
else
  DB=${FITFINE_TEST_DB:-fitfine_backend_test}
  dropdb --if-exists "$DB" >/dev/null 2>&1
  createdb "$DB"
  cleanup() { dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  DB_URL=$DB
  PGOPTIONS='--client-min-messages=warning' "${PSQL[@]}" -d "$DB" -f "$STUB" >/dev/null
  # As on Supabase: service_role bypasses RLS, the API roles don't, and all three may reach the
  # storage tables, which their RLS policies then limit.
  "${PSQL[@]}" -d "$DB" -c 'alter role service_role bypassrls' -c 'alter role authenticated nobypassrls' -c 'alter role anon nobypassrls' \
    -c 'grant usage on schema storage to anon, authenticated, service_role' \
    -c 'grant all on storage.objects, storage.buckets to anon, authenticated, service_role'
  for f in "$WORKDIR"/migrations/*.sql; do
    PGOPTIONS='--client-min-messages=warning' "${PSQL[@]}" -d "$DB" -1 -f "$f" >/dev/null \
      || { echo "!! migration failed: $(basename "$f")"; exit 1; }
  done
fi

fail=0
passed=0
cd "$HERE"
for t in *.test.sql; do
  echo "== $t"
  raw=$(mktemp)
  if ! PGOPTIONS='--client-min-messages=notice' "${PSQL[@]}" -d "$DB_URL" -At -f "$t" >"$raw" 2>&1; then
    grep -vE 'NOTICE' "$raw" | grep -v '^$' || true
    echo "!! $t aborted with a SQL error"; fail=1
  fi
  results=$(sed -E 's/^psql:[^ ]* NOTICE:  //; s/^NOTICE:  //' "$raw" | grep -E '^(ok|not ok)' || true)
  rm -f "$raw"
  [ -n "$results" ] && printf '%s\n' "$results"
  if printf '%s\n' "$results" | grep -q '^not ok'; then fail=1; fi
  passed=$((passed + $(printf '%s\n' "$results" | grep -c '^ok' || true)))
done

if [ "$fail" = 0 ]; then echo "ALL FITFINE BACKEND TESTS PASSED ($passed)"; else echo "FITFINE BACKEND TESTS FAILED"; exit 1; fi
