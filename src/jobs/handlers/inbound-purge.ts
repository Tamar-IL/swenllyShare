import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { inboundMessages } from '../../db/repositories/inbound-messages.js';

/** `inbound.purge` (architecture.md §10): nulls raw inbound payloads past
 * `RAW_PAYLOAD_RETENTION_DAYS` — the row and its audit fields (dmarc, outcome, reason,
 * timestamps) survive; only the potentially-sensitive raw payload is dropped. */
export async function handleInboundPurge(
  container: Container,
  _payload: Record<string, unknown>,
): Promise<JobHandlerResult> {
  await inboundMessages.purgeRawPayloadsPastRetention(container.pool);
  return { status: 'done' };
}
