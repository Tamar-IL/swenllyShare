import { setTimeout as sleepMs } from 'node:timers/promises';
import type { Clock } from '../../ports/clock.js';
import type { TokenGen } from '../../ports/token-gen.js';
import { opaqueTokenExact } from '../../lib/base32.js';

/** Wall-clock `Clock` — the only place `Date.now()`/real `setTimeout` are used for domain time. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  async sleep(ms: number): Promise<void> {
    await sleepMs(ms);
  }
}

/** `TokenGen` backed by `crypto.randomBytes` via `lib/base32.ts` (architecture.md §2). */
export class CryptoTokenGen implements TokenGen {
  opaque(bits: number): string {
    return opaqueTokenExact(bits);
  }
}
