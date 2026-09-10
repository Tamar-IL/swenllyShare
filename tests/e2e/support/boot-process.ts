/**
 * Fix pass 8 (docs/reviews/code-review.md, "Polish pass review — 2026-09-10" finding 4):
 * a small, independently-testable extraction of `smoke.e2e.ts`'s `bootApp()` "spawn,
 * then wait for readiness" shape. Before this fix, `bootApp` spawned the child and then
 * `await`ed the readiness wait with no `try`/`catch` around it — if that wait threw (a
 * bad `DATABASE_URL`, a port collision, a genuine boot regression: exactly what a
 * readiness check exists to catch), `bootApp` propagated the rejection without ever
 * calling `child.kill()`, and its caller's `app = await bootApp(...)` assignment never
 * completed, so no `AppHandle`/pid survived the throw for `afterAll` to clean up — the
 * spawned OS process leaked for the life of the CI runner.
 *
 * Exercised directly by `tests/e2e/support/boot-process.test.ts` (a fast, non-`E2E=1`
 * unit test) rather than only through the full `tsx src/server.ts` boot path, which
 * would require the heavy e2e fixture just to prove a control-flow guarantee.
 */
export async function killChildOnFailedReadiness<T extends { kill(signal?: NodeJS.Signals): void }>(
  child: T,
  waitReady: () => Promise<void>,
): Promise<void> {
  try {
    await waitReady();
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
}
