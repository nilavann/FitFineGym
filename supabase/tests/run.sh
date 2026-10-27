#!/usr/bin/env bash
# The fitfine backend tests: the access matrix and the
# behaviour tests, one *.test.sql file each. Every file runs in one transaction that ends in
# ROLLBACK, including its assertion helpers (framework.sql) and fixtures, so a run leaves nothing
# behind.
#
#   tests/run.sh
#       Local: builds a throwaway database on a reachable Postgres server (PGHOST / PGPORT /
#       PGUSER, superuser) from the Supabase stub of scripts/migrate-to-fitfine and every
#       migration in supabase/migrations/, runs every test, drops the database.
#   FITFINE_TEST_DB_URL=postgresql://... tests/run.sh
#       An existing database that already has the migrations applied: the scratch project.
#       Refused when it is the TARGET_DB_URL of scripts/migrate-to-fitfine/.env.local: rolled-back
#       inserts still consume identity values, so the tests never run on the real target.
#
# Needs psql. Bash 3.2 compatible.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORKDIR=$(cd "$HERE/.." && pwd)
REPO=$(cd "$WORKDIR/.." && pwd)
STUB=$REPO/scripts/migrate-to-fitfine/tests/local/supabase-stub.sql
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

if [ -n "${FITFINE_TEST_DB_URL-}" ]; then
  env_file=$REPO/scripts/migrate-to-fitfine/.env.local
  if [ -f "$env_file" ]; then
    target=$(sed -n 's/^TARGET_DB_URL=//p' "$env_file" | tail -1)
    if [ -n "$target" ] && [ "$target" = "$FITFINE_TEST_DB_URL" ]; then
      echo "REFUSED: FITFINE_TEST_DB_URL is the real target (TARGET_DB_URL); use the scratch project" >&2
      exit 2
    fi
  fi
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

# The validation script against the database just tested: B.1-B.11 must pass on a build of these
# migrations, which also proves backend-expected.txt is current.
echo "== run.sh --validate-backend"
if [ -n "${FITFINE_TEST_DB_URL-}" ]; then
  validate_url=$FITFINE_TEST_DB_URL
else
  validate_url="postgresql://${PGUSER:-$USER}@${PGHOST:-localhost}:${PGPORT:-5432}/$DB"
fi
validate_out=$(mktemp)
if MIG_ENV_FILE=/dev/null MIG_TEST_ALLOW_LOCAL=1 MIG_RETRY_DELAY=0 TARGET_DB_URL=$validate_url \
     "$REPO/scripts/migrate-to-fitfine/run.sh" --validate-backend 2>/dev/null >"$validate_out"; then
  grep -c '^ok' "$validate_out" | sed 's/^/ok - validate-backend: /; s/$/ checks/'
  passed=$((passed + 1))
else
  grep '^FAIL' "$validate_out" | sed 's/^/not ok - /'
  echo "!! --validate-backend failed (after changing a migration: scripts/migrate-to-fitfine/tests/backend-expected.sh)"
  fail=1
fi
rm -f "$validate_out"

if [ "$fail" = 0 ]; then echo "ALL FITFINE BACKEND TESTS PASSED ($passed)"; else echo "FITFINE BACKEND TESTS FAILED"; exit 1; fi
