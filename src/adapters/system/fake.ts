import type { Clock } from '../../ports/clock.js';

/**
 * Virtual-time `Clock` for tests: `now()` returns a controllable instant and `sleep`
 * resolves as soon as virtual time is advanced past the wake time, never a real timer.
 * This is what makes AC-U4 (expiry) and the SharingEngine's pacing testable without
 * real waits.
 *
 * Defaults to the real wall-clock time at construction, NOT a fixed fictional date. A
 * few repository queries compare an application-computed timestamp against Postgres's
 * own `now()` directly (e.g. `magic_link_tokens.expires_at > now()`) rather than going
 * through this port at all — a `FakeClock` pinned to an arbitrary fixed instant would
 * silently desync from the real database clock and make every such comparison wrong
 * (an "expires in 15 minutes" computed from a stale fake epoch can look already-expired
 * to Postgres's real `now()`). Starting from real time keeps the two clocks aligned at
 * t=0; tests that need deterministic elapsed time still get it via `advance()`/`setTo()`
 * from that real starting point.
 */
export class FakeClock implements Clock {
  private current: Date;
  private readonly waiters: Array<{ wakeAt: number; resolve: () => void }> = [];

  constructor(start: Date = new Date()) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    const wakeAt = this.current.getTime() + ms;
    await new Promise<void>((resolve) => {
      this.waiters.push({ wakeAt, resolve });
    });
  }

  /** Advances virtual time by `ms` and resolves any `sleep()` calls whose wake time has passed. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
    this.resolveDue();
  }

  /** Jumps directly to `date` (must be >= current time) and resolves due waiters. */
  setTo(date: Date): void {
    if (date.getTime() < this.current.getTime()) {
      throw new Error('FakeClock.setTo: cannot move virtual time backwards');
    }
    this.current = date;
    this.resolveDue();
  }

  private resolveDue(): void {
    const now = this.current.getTime();
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i];
      if (waiter && waiter.wakeAt <= now) {
        this.waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }
}
