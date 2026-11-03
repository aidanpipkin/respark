#!/usr/bin/env bash
# Runs the adapter tests against a throwaway local Postgres.
#
#   scripts/test.sh                 # start a temp cluster, migrate, test, stop
#   TEST_DATABASE_URL=... scripts/test.sh   # use an existing database (must be disposable: tests truncate tables)
#
# Postgres binaries are looked up in PATH, then /usr/lib/postgresql/*/bin. Postgres refuses to run
# as root, so when invoked by root the cluster is started as the "claude" user (or $PG_USER).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v pg_ctl >/dev/null 2>&1; then
  for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/opt/postgresql@*/bin; do
    [ -x "$d/pg_ctl" ] && export PATH="$d:$PATH" && break
  done
fi

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  command -v pg_ctl >/dev/null || { echo "pg_ctl not found; install PostgreSQL or set TEST_DATABASE_URL"; exit 1; }
  PORT="${PG_PORT:-54329}"
  RUN_AS=""
  if [ "$(id -u)" = "0" ]; then RUN_AS="${PG_USER:-claude}"; fi
  DATA="${PG_DATA:-$HOME/.respark-pgtest}"
  [ -n "$RUN_AS" ] && DATA="$(eval echo "~$RUN_AS")/.respark-pgtest"
  run() { if [ -n "$RUN_AS" ]; then su "$RUN_AS" -s /bin/bash -c "export PATH='$PATH'; $*"; else bash -c "$*"; fi; }
  if [ ! -f "$DATA/PG_VERSION" ]; then
    [ -n "$RUN_AS" ] && mkdir -p "$DATA" && chown "$RUN_AS" "$DATA"
    run "initdb -D '$DATA' -U postgres --auth=trust >/dev/null"
  fi
  STARTED=0
  if ! run "pg_ctl -D '$DATA' status >/dev/null 2>&1"; then
    run "pg_ctl -D '$DATA' -o '-k /tmp -p $PORT -c listen_addresses=127.0.0.1' -l '$DATA/log' start >/dev/null"
    STARTED=1
  fi
  trap '[ "$STARTED" = 1 ] && run "pg_ctl -D '"'"'$DATA'"'"' stop -m fast >/dev/null" || true' EXIT
  PSQL="psql -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
  $PSQL -c "drop database if exists respark_test" -c "create database respark_test" >/dev/null
  $PSQL -d respark_test -f "$ROOT/scripts/test/auth_stub.sql" >/dev/null
  # Every migration except the pg_cron/pg_net one (0002), which needs the Supabase extensions and Vault.
  for m in "$ROOT"/supabase/migrations/*.sql; do
    case "$(basename "$m")" in 0002_*) continue ;; esac
    $PSQL -d respark_test -f "$m" >/dev/null
  done
  export TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/respark_test"
fi

cd "$ROOT"
deno test -A --no-check=remote --config supabase/functions/deno.json supabase/functions/_shared/ supabase/functions/_tests/ "$@"
