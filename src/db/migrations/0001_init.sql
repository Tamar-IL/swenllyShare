-- 0001_init.sql
-- Swenlly Share (System 2) — initial schema. See docs/design/architecture.md §3 for the
-- data-model brief this implements; §11 assigns column/index/constraint detail to the
-- database-engineer.
--
-- gen_random_uuid() is built into Postgres core since v13 — no extension required.

-- =====================================================================================
-- tenants
-- =====================================================================================
CREATE TABLE tenants (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Base32 slug that appears in the inbound address grammar (cust-<slug>+file-<token>@...).
  slug       text        NOT NULL,
  email      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One email = one tenant (architecture.md §3). Case-fold so "A@x.com" and "a@x.com"
-- collide at sign-in, matching the magic-link flow's lookup-by-lower(email).
CREATE UNIQUE INDEX tenants_email_unique_idx ON tenants (lower(email));

-- The inbound-address slug must be globally unique — it is how the webhook's envelope
-- parser (architecture.md §4.3) picks a tenant before the token even resolves a file.
CREATE UNIQUE INDEX tenants_slug_unique_idx ON tenants (slug);

-- =====================================================================================
-- magic_link_tokens
-- =====================================================================================
CREATE TABLE magic_link_tokens (
  -- sha256 hex digest of the 130-bit token; the plaintext is never persisted (§10).
  token_hash   text        PRIMARY KEY,
  email        text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  requested_ip inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Supports "list my outstanding links" / resend-throttle lookups by email without a
-- sequential scan; small table but this is the natural access pattern.
CREATE INDEX magic_link_tokens_email_idx ON magic_link_tokens (email);

-- =====================================================================================
-- sessions
-- =====================================================================================
CREATE TABLE sessions (
  id             text        PRIMARY KEY, -- 128-bit opaque id, Crockford base32
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  expires_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  user_agent_hash text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Tenant-owned table invariant: FK + index on tenant_id (architecture.md §3 invariant 1).
CREATE INDEX sessions_tenant_id_idx ON sessions (tenant_id);

-- Required by the brief: supports the expiry sweep / cleanup job scanning for sessions
-- past `expires_at` without a full-table scan.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- =====================================================================================
-- files
-- =====================================================================================
CREATE TABLE files (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  display_name         text        NOT NULL,
  original_name        text        NOT NULL,
  size_bytes           bigint      NOT NULL,
  mime                 text        NOT NULL,
  zoho_resource_id     text,
  zoho_link_id         text,
  zoho_public_link     text,
  zoho_embed_token     text,
  -- FK added below (ALTER TABLE) once drive_copies exists — the two tables reference
  -- each other (files.drive_active_copy_id -> drive_copies.id -> drive_copies.file_id
  -- -> files.id), so this column starts unconstrained and is wired up after both
  -- tables exist, inside the same migration transaction.
  drive_active_copy_id uuid,
  -- Opaque, 130-bit, Crockford base32, 26 chars — the ONLY way an inbound address
  -- resolves to a file (architecture.md §3 invariant 2). Must never equal public_slug
  -- for the same or any other file (invariant 3): different capability, different
  -- audience, so they are separate globally-unique columns, never derived from one
  -- another.
  request_token        text        NOT NULL,
  public_slug          text        NOT NULL,
  custom_message       text,
  expires_at           timestamptz,
  allowlist_mode       text        NOT NULL DEFAULT 'open'
                                    CHECK (allowlist_mode IN ('open', 'allowlist')),
  staging_blob_id      text,
  status               text        NOT NULL DEFAULT 'staged'
                                    CHECK (status IN ('staged', 'publishing', 'ready', 'expired', 'deleted', 'failed')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX files_tenant_id_idx ON files (tenant_id);

-- Inbound webhook resolves a file by this token alone (cross-tenant lookup #1 in §3
-- invariant 1) — must be a fast unique lookup with no tenant_id available yet.
CREATE UNIQUE INDEX files_request_token_unique_idx ON files (request_token);

-- Branded page (`GET /s/:slug`) resolves a file by this token alone (cross-tenant
-- lookup #2) — same shape, different capability (invariant 3).
CREATE UNIQUE INDEX files_public_slug_unique_idx ON files (public_slug);

-- Backs the per-tenant "/files" list view (most-recent-first) — the only tenant-scoped
-- file query that isn't a point lookup by id.
CREATE INDEX files_tenant_id_created_at_idx ON files (tenant_id, created_at DESC);

-- =====================================================================================
-- file_allowlist
-- =====================================================================================
CREATE TABLE file_allowlist (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalized from files.tenant_id so every repository statement here can filter on
  -- tenant_id directly (§3 invariant 1) without a join back to files.
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  file_id   uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  -- "user@host" or "@domain" (architecture.md §0).
  pattern   text NOT NULL
);

CREATE INDEX file_allowlist_tenant_id_idx ON file_allowlist (tenant_id);

-- The pipeline's allowlist gate (§4.8) looks up all patterns for one file; also
-- prevents accidentally inserting the same pattern for a file twice.
CREATE UNIQUE INDEX file_allowlist_file_id_pattern_unique_idx ON file_allowlist (file_id, pattern);

-- =====================================================================================
-- drive_copies
-- =====================================================================================
CREATE TABLE drive_copies (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  file_id        uuid        NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  intent_seq     integer     NOT NULL,
  drive_file_id  text,
  -- "<tenant>:<file>:<seq>", stored on the Drive file's appProperties too — recovers a
  -- crash between `files.copy` and COMMIT by lookup instead of creating a third copy
  -- (architecture.md §5).
  intent_key     text        NOT NULL,
  share_count    integer     NOT NULL DEFAULT 0,
  last_share_at  timestamptz,
  status         text        NOT NULL DEFAULT 'provisioning'
                              CHECK (status IN ('provisioning', 'active', 'retired', 'revoked')),
  retire_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX drive_copies_tenant_id_idx ON drive_copies (tenant_id);

-- The idempotency guard the advisory lock is paired with (architecture.md §5): the
-- `ON CONFLICT (tenant_id, file_id, intent_seq) DO NOTHING` provisioning insert relies
-- on exactly this constraint to make a lost/never-held lock safe.
CREATE UNIQUE INDEX drive_copies_tenant_file_seq_unique_idx
  ON drive_copies (tenant_id, file_id, intent_seq);

-- `findByIntent` recovery lookup (§5) — one intent_key should only ever map to one row.
CREATE UNIQUE INDEX drive_copies_intent_key_unique_idx ON drive_copies (intent_key);

-- SharingEngine's "active copy for (tenant,file)" read: `... WHERE tenant_id=$1 AND
-- file_id=$2 AND status='active' ORDER BY intent_seq DESC LIMIT 1`.
CREATE INDEX drive_copies_active_lookup_idx
  ON drive_copies (tenant_id, file_id, status, intent_seq DESC);

-- Now that drive_copies exists, wire up files.drive_active_copy_id.
ALTER TABLE files
  ADD CONSTRAINT files_drive_active_copy_id_fkey
  FOREIGN KEY (drive_active_copy_id) REFERENCES drive_copies (id) ON DELETE SET NULL;

CREATE INDEX files_drive_active_copy_id_idx ON files (drive_active_copy_id);

-- =====================================================================================
-- inbound_messages
-- =====================================================================================
CREATE TABLE inbound_messages (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_message_id text       NOT NULL,
  -- The replay table (architecture.md §3, §4.2): a unique-violation on insert IS the
  -- duplicate-delivery detector, not an optimization on top of one.
  signature_token     text        NOT NULL,
  recipient_raw       text        NOT NULL,
  -- Nullable: an unparseable address or unknown token never resolves to a tenant/file
  -- (pipeline gates 3-4 run before resolution can happen).
  tenant_id           uuid        REFERENCES tenants (id) ON DELETE SET NULL,
  file_id             uuid        REFERENCES files (id) ON DELETE SET NULL,
  from_address        text,
  from_domain         text,
  dmarc               text        CHECK (dmarc IN ('pass', 'fail', 'none', 'unknown')),
  spf                 text,
  dkim                text,
  quarantined         boolean     NOT NULL DEFAULT false,
  reason              text,
  raw_payload         jsonb,
  purge_after         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inbound_messages_provider_message_id_unique_idx
  ON inbound_messages (provider_message_id);

CREATE UNIQUE INDEX inbound_messages_signature_token_unique_idx
  ON inbound_messages (signature_token);

-- Nullable FK; still indexed for the (rare, admin-facing) "messages for this tenant"
-- query and for the ON DELETE SET NULL cascade to find its own rows efficiently.
CREATE INDEX inbound_messages_tenant_id_idx ON inbound_messages (tenant_id);
CREATE INDEX inbound_messages_file_id_idx ON inbound_messages (file_id);

-- Backs the `inbound.purge` job's sweep of raw payloads past retention.
CREATE INDEX inbound_messages_purge_after_idx ON inbound_messages (purge_after)
  WHERE raw_payload IS NOT NULL;

-- =====================================================================================
-- deliveries  (the audit log, AC-A2)
-- =====================================================================================
CREATE TABLE deliveries (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  file_id            uuid        NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  requester_address  text        NOT NULL,
  -- Null until `delivery.fulfill` decides attachment-vs-share; append-then-complete
  -- (architecture.md §3 invariant 4) means the row exists before that decision.
  mechanism          text        CHECK (mechanism IS NULL OR mechanism IN ('attachment', 'drive_share')),
  dmarc              text,
  drive_copy_id      uuid        REFERENCES drive_copies (id) ON DELETE SET NULL,
  outcome            text        NOT NULL
                                  CHECK (outcome IN ('queued', 'sent', 'failed', 'quarantined', 'rate_limited', 'expired', 'not_allowlisted')),
  reason             text,
  inbound_message_id uuid        REFERENCES inbound_messages (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);

-- Required by the brief: the per-file deliveries feed (`GET /api/files/:id/deliveries`)
-- and tenant scoping both read through this exact column order.
CREATE INDEX deliveries_tenant_file_created_at_idx
  ON deliveries (tenant_id, file_id, created_at DESC);

CREATE INDEX deliveries_inbound_message_id_idx ON deliveries (inbound_message_id);

-- =====================================================================================
-- rate_limit_counters
-- =====================================================================================
CREATE TABLE rate_limit_counters (
  bucket_key  text        NOT NULL,
  window_start timestamptz NOT NULL, -- truncated to the minute
  count       integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);
-- No secondary index: the PK's (bucket_key, window_start) column order already gives
-- an efficient range scan for `WHERE bucket_key = $1 AND window_start >= $2` — the
-- sliding-window SUM query — for free.

-- =====================================================================================
-- jobs
-- =====================================================================================
CREATE TABLE jobs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text        NOT NULL,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  text,
  run_after   timestamptz NOT NULL DEFAULT now(),
  attempts    integer     NOT NULL DEFAULT 0,
  status      text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'processing', 'done', 'failed', 'dead')),
  last_error  text,
  locked_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Nullable-unique: most jobs have no dedupe_key (NULLs are not equal to each other in a
-- unique index), but `delivery.fulfill` jobs dedupe on `inbound_message_id`.
CREATE UNIQUE INDEX jobs_dedupe_key_unique_idx ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- The worker loop's exact query: `WHERE run_after <= now() AND status = 'pending'
-- ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1`. Partial on status='pending' keeps
-- the index tiny regardless of how many done/dead jobs accumulate.
CREATE INDEX jobs_pending_run_after_idx ON jobs (run_after) WHERE status = 'pending';
