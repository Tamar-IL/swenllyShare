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

    it('provider_message_id is also unique', async () => {
      const pool = testPool();
      await inboundMessages.insertOrDuplicate(pool, {
        providerMessageId: 'dup-provider-id',
        signatureToken: 'sig-a',
        recipientRaw: 'a@b.com',
      });

      await expect(
        inboundMessages.insertOrDuplicate(pool, {
          providerMessageId: 'dup-provider-id',
          signatureToken: 'sig-b',
          recipientRaw: 'a@b.com',
        }),
      ).rejects.toThrow();
    });
  },
);
