#!/usr/bin/env bash
# dev-db.sh — one real, ephemeral PostgreSQL 16 cluster for local dev and CI.
#
# Why this exists (see docs/design/advisor-consult.md §2): the platform's hardest
# correctness test (AC-E2, serialized per (tenant,file)) needs real concurrent
# connections plus `FOR UPDATE SKIP LOCKED` / `pg_advisory_xact_lock`. pglite is
# single-connection and SQLite has no SKIP LOCKED — neither can prove it. So: no
# pglite, no SQLite path, ever. This script is the *only* sanctioned bootstrap.
#
# Subcommands: start | stop | status | reset | url | psql
#
# Env overrides:
#   SWENLLY_PGDATA  cluster data directory (default: /var/lib/postgresql/swenlly)
#   SWENLLY_PGPORT  TCP port               (default: 54329)
set -euo pipefail

PGBIN="/usr/lib/postgresql/16/bin"
PGDATA="${SWENLLY_PGDATA:-/var/lib/postgresql/swenlly}"
PGPORT="${SWENLLY_PGPORT:-54329}"
PGHOST="127.0.0.1"
DEV_DB="swenlly_dev"
TEST_DB="swenlly_test"
PG_OS_USER="postgres"

# ---------------------------------------------------------------------------
# The root/initdb dance
#
# `initdb` (and the server itself) refuses to run as root, on the reasonable
# grounds that a Postgres server compromised while running as root is a much
# worse day than one running as an unprivileged account. In this environment
# a `postgres` OS user already exists with a writable home. So:
#   - If we ARE root: re-exec every privileged step (initdb, pg_ctl, createdb,
#     psql, rm of the data dir) as the `postgres` user via `runuser`, and make
#     sure the data directory is owned by `postgres` before doing so.
#   - If we are NOT root: we must already own (or be able to write) PGDATA,
#     and we just run the binaries directly — no su/runuser needed. This is
#     the path a non-root engineer's laptop and most CI runners take.
# `as_pg <cmd...>` is the one place that decides which of those applies.
# ---------------------------------------------------------------------------
as_pg() {
  if [[ "$(id -u)" -eq 0 ]]; then
    runuser -u "$PG_OS_USER" -- "$@"
  else
    "$@"
  fi
}

# Make sure PGDATA's parent exists and, when we're root, is owned by postgres
# so the `postgres` user (not root) is the one that ever touches it.
ensure_pgdata_owner() {
  local parent
  parent="$(dirname "$PGDATA")"
  if [[ "$(id -u)" -eq 0 ]]; then
    mkdir -p "$parent"
    if [[ ! -e "$PGDATA" ]]; then
      install -d -o "$PG_OS_USER" -g "$PG_OS_USER" -m 0700 "$PGDATA"
    else
      chown -R "$PG_OS_USER:$PG_OS_USER" "$PGDATA"
    fi
  else
    mkdir -p "$PGDATA"
    if [[ ! -w "$PGDATA" ]]; then
      echo "error: $PGDATA is not writable by $(id -un) and we are not root to fix it." >&2
      exit 1
    fi
  fi
}

# Detect a missing Postgres 16 install and print the fix instead of trying to
# apt-get it ourselves (CI runners commonly need `apt-get install postgresql-16`,
# but silently installing packages from a dev script is its own kind of surprise).
check_binaries() {
  if [[ ! -x "$PGBIN/initdb" ]]; then
    echo "error: PostgreSQL 16 binaries not found at $PGBIN" >&2
    if command -v apt-get >/dev/null 2>&1; then
      echo "hint: sudo apt-get update && sudo apt-get install -y postgresql-16" >&2
    else
      echo "hint: install PostgreSQL 16 server binaries for your platform." >&2
    fi
    exit 1
  fi
}

is_running() {
  as_pg "$PGBIN/pg_ctl" status -D "$PGDATA" >/dev/null 2>&1
}

db_exists() {
  local db="$1"
  as_pg "$PGBIN/psql" -h "$PGDATA" -p "$PGPORT" -U postgres -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1
}

cmd_start() {
  check_binaries
  ensure_pgdata_owner

  if is_running; then
    echo "already running (pgdata=$PGDATA port=$PGPORT)"
  else
    if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
      # -A trust: no password prompts for local dev/test. This cluster only ever
      # listens on 127.0.0.1 plus a unix socket in its own data dir — never do
      # this for anything reachable from outside the box.
      as_pg "$PGBIN/initdb" -D "$PGDATA" -U postgres -A trust --no-locale -E UTF8 >/dev/null
      as_pg bash -c "cat >> '$PGDATA/postgresql.conf'" <<-EOF
			listen_addresses = '127.0.0.1'
			port = $PGPORT
			unix_socket_directories = '$PGDATA'
			EOF
    fi

    as_pg "$PGBIN/pg_ctl" start -D "$PGDATA" -w -l "$PGDATA/server.log" \
      -o "-p $PGPORT -k '$PGDATA' -c listen_addresses=127.0.0.1"
  fi

  for db in "$DEV_DB" "$TEST_DB"; do
    if ! db_exists "$db"; then
      as_pg "$PGBIN/createdb" -h "$PGDATA" -p "$PGPORT" -U postgres "$db"
    fi
  done

  cmd_url
}

cmd_stop() {
  check_binaries
  if is_running; then
    as_pg "$PGBIN/pg_ctl" stop -D "$PGDATA" -m fast -w
  else
    echo "not running"
  fi
}

cmd_status() {
  check_binaries
  if is_running; then
    as_pg "$PGBIN/pg_ctl" status -D "$PGDATA"
  else
    echo "not running (pgdata=$PGDATA port=$PGPORT)"
    return 1
  fi
}

cmd_reset() {
  check_binaries
  if is_running; then
    cmd_stop
  fi
  if [[ -e "$PGDATA" ]]; then
    as_pg rm -rf "$PGDATA"
  fi
  cmd_start
}

cmd_url() {
  echo "DATABASE_URL=postgres://postgres@${PGHOST}:${PGPORT}/${DEV_DB}"
  echo "TEST_DATABASE_URL=postgres://postgres@${PGHOST}:${PGPORT}/${TEST_DB}"
}

cmd_psql() {
  check_binaries
  as_pg "$PGBIN/psql" -h "$PGHOST" -p "$PGPORT" -U postgres -d "$DEV_DB"
}

usage() {
  echo "usage: $0 {start|stop|status|reset|url|psql}" >&2
  exit 1
}

main() {
  local sub="${1:-}"
  case "$sub" in
    start)  cmd_start ;;
    stop)   cmd_stop ;;
    status) cmd_status ;;
    reset)  cmd_reset ;;
    url)    cmd_url ;;
    psql)   cmd_psql ;;
    *)      usage ;;
  esac
}

main "$@"
