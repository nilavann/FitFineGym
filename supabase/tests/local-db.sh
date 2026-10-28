#!/usr/bin/env bash
# A throwaway local Postgres server (outside the repo) for the backend database tests
# (supabase/tests/run.sh, npm run test:db), which build their own database from
# supabase-stub.sql and supabase/migrations. Needs initdb / pg_ctl / psql on PATH.
#
#   eval "$(supabase/tests/local-db.sh start)"   # prints PGHOST / PGPORT / PGUSER for that server
#   supabase/tests/local-db.sh stop
set -euo pipefail
DATA=${FITFINE_LOCAL_PGDATA:-${TMPDIR:-/tmp}/fitfine-localdb}
PORT=${FITFINE_LOCAL_PGPORT:-54329}

stop() {
  if [ -f "$DATA/PG_VERSION" ]; then
    pg_ctl -D "$DATA" -m fast stop >/dev/null 2>&1 || true
    rm -rf "$DATA"
  fi
}

start() {
  stop
  initdb -D "$DATA" -U postgres -A trust -E UTF8 --no-locale >/dev/null
  pg_ctl -D "$DATA" -l "$DATA/server.log" -o "-p $PORT -c listen_addresses=localhost -c unix_socket_directories=''" -w start >/dev/null
  cat <<EOT
export PGHOST=localhost
export PGPORT=$PORT
export PGUSER=postgres
EOT
}

case ${1-} in
  start) start ;;
  stop)  stop ;;
  *)     echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
