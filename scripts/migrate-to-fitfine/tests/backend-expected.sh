#!/usr/bin/env bash
# Writes backend-expected.txt, the snapshot --validate-backend compares the target with (B.1-B.11),
# from a throwaway local database built the way supabase/tests/run.sh builds one: the
# Supabase stub plus every migration in supabase/migrations. Run it after
# changing a migration, and commit the file with the migration.
#
#   PGHOST=localhost PGPORT=54329 PGUSER=postgres tests/backend-expected.sh
#
# Needs a reachable Postgres server (superuser) and psql. Never connects to a Supabase project.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MIG_DIR=$(cd "$HERE/.." && pwd)
REPO=$(cd "$MIG_DIR/../.." && pwd)
. "$MIG_DIR/lib/common.sh"
. "$MIG_DIR/lib/backend.sh"

DB=fitfine_backend_expected
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
dropdb --if-exists "$DB" >/dev/null 2>&1
createdb "$DB"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
PGOPTIONS='--client-min-messages=warning' "${PSQL[@]}" -d "$DB" -f "$HERE/local/supabase-stub.sql" >/dev/null
for f in "$REPO"/supabase/migrations/*.sql; do
  PGOPTIONS='--client-min-messages=warning' "${PSQL[@]}" -d "$DB" -1 -f "$f" >/dev/null || { echo "migration failed: $f" >&2; exit 1; }
done

TARGET_DB_URL="postgresql://${PGUSER:-$USER}@${PGHOST:-localhost}:${PGPORT:-5432}/$DB"
MIG_RETRY_DELAY=0
backend_snapshot >"$MIG_DIR/backend-expected.txt"
echo "wrote $MIG_DIR/backend-expected.txt ($(wc -l <"$MIG_DIR/backend-expected.txt" | tr -d ' ') facts)" >&2
