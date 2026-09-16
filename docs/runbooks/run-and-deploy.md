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

## Fresh server in one command

```bash
git clone -b claude/swenlly-system-2-file-sharing-32nrdu <repo-url> swenlly-share
cd swenlly-share
scripts/setup-server.sh      # checks Node 22 / pnpm / Postgres 16, installs, creates .env
                             # with a generated SESSION_SECRET, migrates, builds, prints next steps
```

The script is idempotent and never touches an existing `.env`. Put real provider keys in
`.env` afterwards (it is gitignored) and follow `docs/runbooks/live-spikes.md`.

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
   `DATABASE_URL` must carry `sslmode=require` (or stricter) or `PG_SSL=true` must be set —
   `src/db/pool.ts` refuses to boot in production without one of the two.
3. **Migrate before start:** run `pnpm db:migrate` against the production `DATABASE_URL` as
   part of the release step, before traffic is routed to the new version. (The server also
   runs migrations on boot as a safety net — §"Local run" above — but don't rely on that
   under a rolling deploy with old and new versions briefly overlapping.)
4. **DNS for `INBOUND_DOMAIN`:** MX → Mailgun's receiving MX hosts; SPF (`v=spf1
   include:mailgun.org ~all`), DKIM (Mailgun-issued selector `TXT` record), and DMARC
   (`v=DMARC1; p=quarantine`, or stricter) all published. **Fix pass 5 correction (F-H,
   `docs/reviews/critic-report.md`): this governs OUTBOUND deliverability from
   `INBOUND_DOMAIN` (whether Swenlly's own reply mail lands in an inbox instead of spam) —
   it has NO effect on the inbound pipeline's DMARC gate, which evaluates the *requester's*
   `From` domain, not ours.** A prior version of this checklist claimed otherwise; if
   inbound requests are being silently quarantined, look at item 4a below, not here.
4a. **The inbound DMARC gate itself — the actual thing that decides whether a request
   gets through:** `INBOUND_REQUESTS_ENABLED` (kill switch, defaults `false`) and
   `MAILGUN_AUTHSERV_ID` (the RFC 8601 authserv-id our own verdict is filed under) are BOTH
   required before the inbound email-request path can work at all —
   `loadConfig` refuses to boot production with `INBOUND_REQUESTS_ENABLED=true` and no
   `MAILGUN_AUTHSERV_ID` set. **Never set `MAILGUN_AUTHSERV_ID` to (or leave it defaulting
   toward) `INBOUND_DOMAIN`** — that value is printed in every mailto link this product
   hands out, i.e. public and guessable, and was the exact hole F-B (`docs/reviews/critic-
   report.md`) found forgeable. Do not flip `INBOUND_REQUESTS_ENABLED=true` in production
   until spike 3 (`docs/runbooks/live-spikes.md`) has captured one real Mailgun inbound
   payload and confirmed the DMARC/SPF/DKIM field-name guess in
   `src/adapters/mailgun/mapping.ts` against it — flipping it on a guess reopens the exact
   forgeable-gate risk the kill switch exists to hold shut.
   **Fix pass 6 (critic F-B re-check):** the authserv-id is Mailgun's PUBLIC hostname, so
   configuring it correctly is necessary but not sufficient. You must also choose exactly
   ONE `INBOUND_AUTH_SOURCE` from what spike 3b shows Mailgun actually provides —
   `mailgun-fields` if the payload carries synthetic top-level `dmarc`/`dmarc-domain`
   fields, `authentication-results` only if spike 3c proves Mailgun stamps its own
   `Authentication-Results` on EVERY message (including one that already carries a forged
   copy). There is no fallback between the two by design. If neither signal exists on your
   plan, leave `INBOUND_REQUESTS_ENABLED=false`; the product still works for the
   filtered-internet audience via the distribution link.
5. **Mailgun Route:** `match_recipient("^cust-.*@<INBOUND_DOMAIN>$")` → forward to
   `POST https://<PUBLIC_BASE_URL>/webhooks/mailgun/inbound`. The webhook verifies Mailgun's
   HMAC signature before parsing anything (architecture §10) — `MAILGUN_SIGNING_KEY` must
   match the sending domain's actual signing key or every inbound request is rejected.
6. **Single stateful node.** No horizontal scaling until staging moves off local disk — see
   "Platform shape" above.
6a. **Memory floor (critic report Minor: "attachment delivery buffers the whole file in
   memory").** `streamToBuffer` (the attachment-delivery path) buffers a full attachment up
   to `ATTACH_LIMIT_BYTES` before sending it, and up to `WORKER_CONCURRENCY` deliveries can
   be doing that at once — so the worker's own burst ceiling is
   `ATTACH_LIMIT_BYTES × WORKER_CONCURRENCY` (defaults: 20MB × 4 = **80MB**), on top of the
   Node/Fastify process's own baseline (~100–150MB RSS idle, before this product's own
   pools/caches). Size the container to comfortably clear baseline + burst with headroom for
   GC overhead and a traffic spike that lines up several large attachments at once — **at
   least 512MB** at the defaults above, and re-derive this number (baseline + `ATTACH_LIMIT_
   BYTES × WORKER_CONCURRENCY`, times ~1.5–2x headroom) before raising either config value in
   production. This is a memory-sizing note, not a fix — the buffering itself is unchanged.
7. **Health endpoints:** `GET /healthz` (process alive) and `GET /readyz` — DB reachable,
   plus operator-visible counters that grew alongside the fix passes: `{ok, db,
   pendingJobs, sweepsHealthy, sweeps, strandedExpiries, unconfirmedDeliveries}`.
   `strandedExpiries` (fix pass 5, F-C) and `unconfirmedDeliveries` (fix pass 6, N-2) are
   operator signals, not readiness failures — `ok`/`db` alone gate the probe itself.
   Point your platform's liveness/readiness probes at `/healthz`/`/readyz` respectively;
   the `Dockerfile`'s `HEALTHCHECK` uses `/healthz`.
8. **Log redaction:** pino redacts `authorization`, `cookie`, `signature`, `token`,
   `request_token`, `public_slug`, `*_refresh_token`, `MAILGUN_*`, and request bodies on
   `/signin` and the webhook (architecture §10) — do not add ad-hoc `console.log`s that
   route around this list, and extend the redaction list first if a new secret-shaped field
   is added.
