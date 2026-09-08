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
