import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { requireSessionApi } from '../plugins/auth.js';
import { AppError, ErrorCode } from '../../lib/errors.js';

/** `POST /api/files` (streamed multipart upload) and the file-status/deliveries JSON
 * endpoints (architecture.md §6, §11). */
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
    { preHandler: requireSessionApi },
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

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/files/:id/deliveries',
    { preHandler: requireSessionApi },
    async (request, _reply) => {
      if (!request.tenantId) return;
      const since = request.query.since ? new Date(request.query.since) : undefined;
      const { items, total } = await container.services.audit.listForFile(
        request.tenantId,
        request.params.id,
        { since },
      );
      return {
        items: items.map((d) => ({
          address: d.requester_address,
          mechanism: d.mechanism,
          outcome: d.outcome,
          at: d.created_at.toISOString(),
        })),
        total,
      };
    },
  );
}
