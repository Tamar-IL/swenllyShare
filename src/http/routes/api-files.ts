import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { requireSessionApi } from '../plugins/auth.js';
import { requireUuidParams } from '../plugins/uuid-params.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { deliveryAddressLabel, canResendDelivery } from '../../lib/presentation.js';

/** `POST /api/files` (streamed multipart upload) and the file-status/deliveries JSON
 * endpoints (architecture.md §6, §11). */
const uuidIdJson = requireUuidParams(['id'], (reply) => {
  reply.code(404).send({ error: ErrorCode.NOT_FOUND });
});

export function registerApiFileRoutes(app: FastifyInstance, container: Container): void {
  app.post(
    '/api/files',
    { onRequest: app.csrfProtection, preHandler: requireSessionApi },
    async (request, reply) => {
      const tenantId = request.tenantId;
      if (!tenantId) return; // requireSessionApi already threw

      const part = await request.file();
      if (!part) {
        reply.code(400).send({
          error: ErrorCode.VALIDATION_ERROR,
          message: 'multipart field "file" is required',
        });
        return;
      }

      try {
        const row = await container.services.files.createStaged({
          tenantId,
          stream: part.file,
          originalName: part.filename,
          mime: part.mimetype,
        });
        reply.code(201).send({ fileId: row.id, status: row.status });
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.TOO_LARGE) {
          reply.code(413).send({
            error: ErrorCode.TOO_LARGE,
            maxBytes: container.config.MAX_UPLOAD_BYTES,
          });
          return;
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/files/:id/status',
    { preHandler: [requireSessionApi, uuidIdJson] },
    async (request, reply) => {
      if (!request.tenantId) return;
      const status = await container.services.files.getStatus(request.tenantId, request.params.id);
      if (!status) {
        reply.code(404).send({ error: ErrorCode.NOT_FOUND });
        return;
      }
      return status;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { since?: string; sinceId?: string } }>(
    '/api/files/:id/deliveries',
    { preHandler: [requireSessionApi, uuidIdJson] },
    async (request, _reply) => {
      if (!request.tenantId) return;
      const since = request.query.since ? new Date(request.query.since) : undefined;
      // Bug 1 (QA report): `sinceId` is the other half of the `(created_at, id)` keyset
      // cursor — see deliveries.ts listForFile()'s doc comment.
      const sinceId = request.query.sinceId || undefined;
      // Fix pass 11 (critic N-15): establish ownership explicitly — the listing is
      // tenant-scoped either way, but a foreign or unknown file id must be a 404, not an
      // empty 200 that reads as "this file exists and has no deliveries".
      const owned = await container.services.files.getById(request.tenantId, request.params.id);
      if (!owned) {
        _reply.code(404);
        return { error: ErrorCode.NOT_FOUND };
      }
      const { items, total } = await container.services.audit.listForFile(
        request.tenantId,
        request.params.id,
        { since, sinceId },
      );
      return {
        items: items.map((d) => ({
          id: d.id,
          address: deliveryAddressLabel(d),
          mechanism: d.mechanism,
          outcome: d.outcome,
          at: d.created_at.toISOString(),
          // Fix pass 8 (code-review.md polish-pass finding 3): a delivery that
          // transitions to `failed`/`unconfirmed` AFTER the sender already has the page
          // open (the normal case — the worker sets that outcome well after the page's
          // initial SSR) used to never get a resend button until a manual reload, since
          // this JSON payload carried neither the resendability flag nor a path for the
          // form's `action`. `island.js`'s `prependRow` renders the identical `<td>`
          // shape the SSR row does (`file-detail.eta`) whenever `resendable` is true.
          resendable: canResendDelivery(d.outcome),
          resendPath: `/files/${request.params.id}/deliveries/${d.id}/resend`,
        })),
        total,
      };
    },
  );
}
