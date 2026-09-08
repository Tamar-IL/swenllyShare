import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { inboundMessages } from '../../src/db/repositories/inbound-messages.js';
import { withTransaction } from '../../src/db/pool.js';

describe.skipIf(!hasTestDatabase())(
  'inboundMessages.insertOrDuplicate (replay gate, AC-R6)',
  () => {
    beforeEach(async () => {
      await truncateAll();
    });

    it('first insert succeeds; a replay of the same signature_token is flagged, not thrown', async () => {
      const pool = testPool();
      const params = {
        providerMessageId: 'provider-msg-1',
        signatureToken: 'sig-token-1',
        recipientRaw: 'cust-abc+file-xyz@share.swenlly.com',
      };

      const first = await inboundMessages.insertOrDuplicate(pool, params);
      expect(first.duplicate).toBe(false);
      if (first.duplicate) throw new Error('unreachable');
      expect(first.row.signature_token).toBe('sig-token-1');

      const replay = await inboundMessages.insertOrDuplicate(pool, params);
      expect(replay.duplicate).toBe(true);

      const { rows } = await pool.query(
        "SELECT count(*)::int AS count FROM inbound_messages WHERE signature_token = 'sig-token-1'",
      );
      expect(rows[0].count).toBe(1);
    });

    it('a duplicate insert does not abort the caller enclosing transaction', async () => {
      const pool = testPool();
      const params = {
        providerMessageId: 'provider-msg-2',
        signatureToken: 'sig-token-2',
        recipientRaw: 'cust-abc+file-xyz@share.swenlly.com',
      };
      await inboundMessages.insertOrDuplicate(pool, params);

      // Run the replay attempt inside a transaction, then perform a further, unrelated
      // write and commit — if ON CONFLICT DO NOTHING had aborted the transaction the way
      // an unhandled unique-violation would, this second write would fail.
      const result = await withTransaction(pool, async (client) => {
        const replay = await inboundMessages.insertOrDuplicate(client, params);
        await client.query(
          "INSERT INTO inbound_messages (provider_message_id, signature_token, recipient_raw) VALUES ('provider-msg-3', 'sig-token-3', 'x@y.com')",
        );
        return replay;
      });

      expect(result.duplicate).toBe(true);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS count FROM inbound_messages WHERE signature_token = 'sig-token-3'",
      );
      expect(rows[0].count).toBe(1);
    });

    it('provider_message_id is also unique, and a collision is flagged, not thrown (F-11)', async () => {
      // F-11 fix note (docs/security/red-team-report.md, RT-22): a `provider_message_id`
      // collision used to fall through as an uncaught unique-violation exception, because
      // `insertOrDuplicate`'s `ON CONFLICT (signature_token)` named only ONE of the two
      // unique indexes as its arbiter — a different message re-injected under a fresh
      // Mailgun `signature_token` (a forwarding loop, a provider re-delivery) hit the
      // OTHER index and was never gracefully deduped. Fixed by targeting no explicit
      // conflict column (`ON CONFLICT DO NOTHING`), which catches either index — this
      // test now asserts the graceful `{duplicate: true}` the method's own doc comment
      // always promised, matching the sibling `signature_token` tests above.
      const pool = testPool();
      const first = await inboundMessages.insertOrDuplicate(pool, {
        providerMessageId: 'dup-provider-id',
        signatureToken: 'sig-a',
        recipientRaw: 'a@b.com',
      });
      expect(first.duplicate).toBe(false);

      const second = await inboundMessages.insertOrDuplicate(pool, {
        providerMessageId: 'dup-provider-id',
        signatureToken: 'sig-b',
        recipientRaw: 'a@b.com',
      });
      expect(second.duplicate).toBe(true);

      const { rows } = await pool.query(
        "SELECT count(*)::int AS count FROM inbound_messages WHERE provider_message_id = 'dup-provider-id'",
      );
      expect(rows[0].count).toBe(1);
    });
  },
);
