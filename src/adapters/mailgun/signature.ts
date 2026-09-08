import { timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../ports/clock.js';
import { computeMailgunSignature } from './fake.js';

/** Mailgun's own documented tolerance window for webhook signature timestamps
 * (architecture.md §4.1). */
const SIGNATURE_WINDOW_SECONDS = 5 * 60;

/**
 * Verifies a Mailgun webhook signature: `hex(hmac_sha256(signingKey, timestamp + token))`,
 * constant-time compared, with `timestamp` required to fall within
 * `SIGNATURE_WINDOW_SECONDS` of `clock.now()`.
 *
 * The HMAC computation itself is `computeMailgunSignature`, imported from
 * `adapters/mailgun/fake.ts` rather than reimplemented — `FakeInboundMail.verify` already
 * encodes this exact algorithm (its own doc comment: "verifies the HMAC exactly like
 * Mailgun does"), and architecture.md §4.1 is explicit that the real adapter should
 * "reuse whatever the fake/mapping already does — do not duplicate logic." This function
 * is the one place both the compare-and-window wrapper lives, so `MailgunInboundAdapter`
 * (which needs an injected `Clock`, unlike the fake's constructor-supplied one) doesn't
 * have to re-implement it inline.
 */
export function verifyMailgunSignature(
  signingKey: string,
  fields: { timestamp: string; token: string; signature: string },
  clock: Pick<Clock, 'now'>,
): boolean {
  const expectedHex = computeMailgunSignature(signingKey, fields.timestamp, fields.token);
  const expected = Buffer.from(expectedHex, 'hex');
  let actual: Buffer;
  try {
    actual = Buffer.from(fields.signature, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length || actual.length === 0) return false;
  if (!timingSafeEqual(actual, expected)) return false;

  const tsSeconds = Number(fields.timestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  const nowSeconds = Math.floor(clock.now().getTime() / 1000);
  return Math.abs(nowSeconds - tsSeconds) <= SIGNATURE_WINDOW_SECONDS;
}
