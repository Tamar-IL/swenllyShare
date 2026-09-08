# tests/redteam — adversarial regression cases

Written by the AI Red Team pass (`docs/security/red-team-report.md`). Every test here
asserts the **desired, secure** behaviour. Tests marked `it.fails(...)` are live findings:
they currently throw, which keeps the suite green while recording the exact repro. When
trust-safety fixes a finding, flip `it.fails` back to `it` — the test then guards the fix.

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/redteam --project integration`
