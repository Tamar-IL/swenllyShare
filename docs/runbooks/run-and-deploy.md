# Run & Deploy Runbook

**Owner:** devops-engineer. See `docs/design/architecture.md` §1, §9, §11–§12 for the decisions behind this doc.

## Platform shape

One deployable, one Node process: HTTP and the job worker share a binary (`src/server.ts`),
the worker loop toggled by `WORKER_ENABLED` so it can be split out later **without a code
change**. Staging uploads live on local disk (`STAGING_DIR`), which is why this is a **single
stateful node** today — do not run more than one instance against the same `STAGING_DIR`.
Split the worker into its own process only when either becomes a bottleneck: a slow job
starving HTTP under load, or you've moved `STAGING_DIR` to a shared object-store adapter and
want to scale the two independently. Until then, splitting buys nothing and costs a queue
service the architecture deliberately avoided (Postgres already serves as the job queue).

## Local run

```
scripts/dev-db.sh start        # ephemeral Postgres 16 on 127.0.0.1:54329
cp .env.example .env           # fill in SESSION_SECRET; everything else has a dev default
ADAPTERS=fake pnpm dev          # tsx watch, no external credentials needed
```

`ADAPTERS=fake` fakes every external port (Drive, Zoho, Mailgun) for a full demo/dev loop
with zero live calls. `src/server.ts` runs `pnpm db:migrate`'s migrations automatically at
boot, so a fresh `swenlly_dev` database is brought up to date on first `pnpm dev` — you only
need to run `pnpm db:migrate` by hand for a one-off migration check or against a database the
app isn't about to start against.

## Tests

```
scripts/dev-db.sh start
export TEST_DATABASE_URL="$(scripts/dev-db.sh url | grep TEST_ | cut -d= -f2-)"
pnpm test              # unit + integration
pnpm test:unit         # unit only, no DB needed
pnpm test:integration  # needs TEST_DATABASE_URL (real PG — no pglite/SQLite path exists)
```

CI (`.github/workflows/ci.yml`) runs typecheck → lint → prettier check → unit → integration
(real Postgres 16, started the same way) → ledger check → build, on every push and PR.

## Production checklist

1. **Real adapters only.** `container.ts` hard-throws if `NODE_ENV=production` and any
   adapter is still `fake` — set `ADAPTERS=real` (or override per-port) and provide every
   credential below.
2. **Required env** (see `.env.example` / architecture §9 for the full list; zod validates
   at boot and fails fast on anything missing): `DATABASE_URL`, `SESSION_SECRET`,
   `COOKIE_SECURE=true`, `PUBLIC_BASE_URL`, `INBOUND_DOMAIN`, `STAGING_DIR` (writable,
   persistent), `GOOGLE_SA_JSON_PATH` + `GOOGLE_IMPERSONATE_SUBJECT` +
   `GOOGLE_SHARED_DRIVE_ID`, `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET`/`ZOHO_REFRESH_TOKEN`,
   `MAILGUN_API_KEY`/`MAILGUN_SIGNING_KEY`/`MAILGUN_SENDING_DOMAIN`/`OUTBOUND_FROM`.
3. **Migrate before start:** run `pnpm db:migrate` against the production `DATABASE_URL` as
   part of the release step, before traffic is routed to the new version. (The server also
   runs migrations on boot as a safety net — §"Local run" above — but don't rely on that
   under a rolling deploy with old and new versions briefly overlapping.)
4. **DNS for `INBOUND_DOMAIN`:** MX → Mailgun's receiving MX hosts; SPF (`v=spf1
   include:mailgun.org ~all`), DKIM (Mailgun-issued selector `TXT` record), and DMARC
   (`v=DMARC1; p=quarantine`, or stricter) all published — the inbound pipeline's DMARC gate
   (architecture §10) rejects everything if these aren't in place.
5. **Mailgun Route:** `match_recipient("^cust-.*@<INBOUND_DOMAIN>$")` → forward to
   `POST https://<PUBLIC_BASE_URL>/webhooks/mailgun/inbound`. The webhook verifies Mailgun's
   HMAC signature before parsing anything (architecture §10) — `MAILGUN_SIGNING_KEY` must
   match the sending domain's actual signing key or every inbound request is rejected.
6. **Single stateful node.** No horizontal scaling until staging moves off local disk — see
   "Platform shape" above.
7. **Health endpoints:** `GET /healthz` (process alive) and `GET /readyz` (`{ok, db,
   pendingJobs}` — DB reachable) — point your platform's liveness/readiness probes at these
   respectively; the `Dockerfile`'s `HEALTHCHECK` uses `/healthz`.
8. **Log redaction:** pino redacts `authorization`, `cookie`, `signature`, `token`,
   `request_token`, `public_slug`, `*_refresh_token`, `MAILGUN_*`, and request bodies on
   `/signin` and the webhook (architecture §10) — do not add ad-hoc `console.log`s that
   route around this list, and extend the redaction list first if a new secret-shaped field
   is added.
