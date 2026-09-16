#!/usr/bin/env bash
# One-shot bootstrap for a fresh Linux server (Ubuntu/Debian assumed for the apt hints).
# Idempotent: safe to re-run. Does NOT print or store secrets; you edit .env yourself.
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }

say "Checking tools"
if ! need node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Node 22+ is required. Install: https://nodejs.org/en/download (or: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs)"; exit 1
fi
if ! need pnpm; then
  say "Enabling pnpm via corepack"
  corepack enable && corepack prepare pnpm@10.33.0 --activate
fi
if ! need psql; then
  echo "PostgreSQL 16 client/server not found. Install: sudo apt-get install -y postgresql-16"; exit 1
fi
echo "node $(node -v) · pnpm $(pnpm -v) · $(psql --version)"

say "Installing dependencies"
pnpm install --frozen-lockfile

say "Database"
if [ -n "${DATABASE_URL:-}" ]; then
  echo "Using DATABASE_URL from the environment."
elif grep -q '^DATABASE_URL=postgres://' .env 2>/dev/null; then
  echo "Using DATABASE_URL from .env."
else
  echo "No DATABASE_URL yet. Starting the bundled local Postgres (scripts/dev-db.sh)."
  echo "For production, point DATABASE_URL at your own Postgres 16 with sslmode=require instead."
  scripts/dev-db.sh start
fi

say ".env"
if [ ! -f .env ]; then
  cp .env.example .env
  secret="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=${secret}#" .env
  echo "Created .env from .env.example with a generated SESSION_SECRET."
else
  echo ".env already exists — left untouched."
fi
grep -q '^SESSION_SECRET=.\{32,\}' .env || { echo "SESSION_SECRET in .env must be at least 32 characters."; exit 1; }

say "Migrations"
set -a; . ./.env; set +a
pnpm db:migrate

say "Build"
pnpm build

cat <<'NEXT'

Done. Next steps:
  1. Smoke test with NO credentials (fake providers):
       ADAPTERS=fake node dist/server.js        # then open http://<server>:3000
  2. Put your real keys in .env (never commit it):
       Zoho:    ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN / ZOHO_TEAM_FOLDER_ID
       Google:  GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
       Mailgun: MAILGUN_API_KEY / MAILGUN_SIGNING_KEY / MAILGUN_SENDING_DOMAIN / MAILGUN_AUTHSERV_ID
       and set PUBLIC_BASE_URL, INBOUND_DOMAIN, OUTBOUND_FROM to your real values.
  3. Run the live spikes one at a time — docs/runbooks/live-spikes.md — e.g.
       LIVE_ZOHO=1 pnpm test:integration tests/contract/file-store.test.ts
  4. Only after the spikes: ADAPTERS=real, and keep INBOUND_REQUESTS_ENABLED=false
     until Mailgun spike 3c tells you which INBOUND_AUTH_SOURCE to set.
NEXT
