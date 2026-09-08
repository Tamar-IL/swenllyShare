# Progress Log — Swenlly System 2

Three lines per chunk, newest last. Live external calls made so far: **0**.

## 2026-09-07 — Repo set up
- Team (`.claude/agents`), CLAUDE.md, PRD, research record committed.
- Discovery complete; build starts at the Design gate.

## 2026-09-08 — Design gate (PASS)
- Advisor consulted on the irreversible calls (`docs/design/advisor-consult.md`): TS/Fastify, Postgres for data+queue+locks, Mailgun Routes, Workspace SA + `drive.file`, ports & adapters with a verification ledger.
- Product-designer UX brief, visual spec, and architecture brief written (`docs/design/`); architecture-review self-gate PASS; two founder forks escalated (Google account type → AC-R4; upload ceiling 1 GB).
- `scripts/dev-db.sh` gives every engineer/CI a real local Postgres 16; SKIP LOCKED + advisory locks verified across concurrent connections.
