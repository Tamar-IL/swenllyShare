# scripts/dev-db.sh

One committed script giving every engineer and CI the same real, ephemeral
PostgreSQL 16 for dev and tests. No pglite, no SQLite path — the
serialization test (`FOR UPDATE SKIP LOCKED`, `pg_advisory_xact_lock`) needs
real concurrent connections, which only a real Postgres server provides.

```
scripts/dev-db.sh start   # create + start, print connection URLs
scripts/dev-db.sh status  # is it running?
scripts/dev-db.sh stop
scripts/dev-db.sh reset   # drop the cluster and recreate it
scripts/dev-db.sh url     # print DATABASE_URL / TEST_DATABASE_URL
scripts/dev-db.sh psql    # shell on swenlly_dev
```

Cluster lives at `/var/lib/postgresql/swenlly` (`SWENLLY_PGDATA`), port
`54329` (`SWENLLY_PGPORT`), on `127.0.0.1` plus a unix socket in the cluster
dir, trust auth (dev/test only). Creates `swenlly_dev` and `swenlly_test`.

Works as root (drops to the `postgres` OS user for `initdb`/server, since
Postgres refuses root) or as a non-root owner of the data dir, including CI
runners. Missing binaries print an `apt-get install postgresql-16` hint
instead of installing anything.

## Isolating concurrent test runs (`TEST_DB_PER_RUN`)

`fileParallelism: false` (`vitest.config.ts`) only serializes test files _within_ one
`vitest`/`pnpm test` invocation — nothing stops two concurrent invocations from sharing the
one `swenlly_test` database above and truncating/migrating it out from under each other
(docs/reviews/critic-report.md N-9). If you (or CI) ever run tests concurrently — a watch
mode left open plus a manual run, a CI matrix pointed at one shared database, etc. — set:

```
TEST_DB_PER_RUN=1 pnpm test
```

before each invocation. `tests/setup/db.ts` then creates a private
`swenlly_test_<pid>_<random>` database (via a connection to this server's `postgres`
maintenance database), migrates it, and drops it again once that run finishes — two
concurrent runs always land on two different databases with no extra coordination needed,
since `process.pid` is real OS-process identity. Off by default: a plain `pnpm test` still
uses the shared `swenlly_test` database exactly as before.
