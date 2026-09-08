# tests/redteam — adversarial regression cases

Written by the AI Red Team pass (`docs/security/red-team-report.md`). Every test here
asserts the **desired, secure** behaviour. A finding not yet fixed is marked `it.fails(...)`
— it currently throws, which keeps the suite green while recording the exact repro. When a
finding is fixed, flip its `it.fails` to `it` — the test then guards the fix permanently.
As of the backend-engineer pass on 2026-09-08 (see `docs/security/red-team-report.md` §6
"Fix status"), every case in this directory has been flipped: there are no remaining
`it.fails` here. A future red-team pass adds new findings the same way.

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/redteam --project integration`
