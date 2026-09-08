import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { files } from '../../db/repositories/files.js';
import { tenants } from '../../db/repositories/tenants.js';
import { requireSessionHtml } from '../plugins/auth.js';
import { issueCsrfToken } from '../plugins/csrf.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import type { AllowlistMode } from '../../db/repositories/files.js';
import type { ExpiryMode } from '../../domain/settings.js';

const DMARC_NOTE =
  'בקשות מגיעות רק מכתובות מאומתות (DMARC) — Gmail וכתובות רגילות עובדות; ' +
  'דומיינים מותאמים אישית עשויים להיכשל.';

const FLASH_MESSAGES: Record<string, string> = {
  saved: 'ההגדרות נשמרו.',
};

interface SettingsBody {
  displayName?: string;
  customMessage?: string;
  expiryMode?: string;
  expiryDays?: string;
  expiresAt?: string;
  allowlistMode?: string;
  allowlist?: string;
}

async function renderNotFound(reply: FastifyReply): Promise<void> {
  reply.code(404);
  await reply.view('error.eta', { message: 'הקובץ לא נמצא.' });
}

/** Tenant-scoped file pages: list, per-file detail/settings, delete
 * (architecture.md §11). Every lookup goes through the tenant-scoped repository, so a
 * wrong tenant gets a plain 404 (AC-A3), never a 403 with any distinguishing detail. */
export function registerFileRoutes(app: FastifyInstance, container: Container): void {
  app.get('/files', { preHandler: requireSessionHtml }, async (request, reply) => {
    if (!request.tenantId) return; // requireSessionHtml already redirected
    const rows = await files.list(container.pool, request.tenantId);
    return reply.view('files-list.eta', {
      files: rows.map((f) => ({
        id: f.id,
        displayName: f.display_name,
        status: f.status,
        createdAt: f.created_at.toISOString(),
      })),
    });
  });

  app.get('/files/new', { preHandler: requireSessionHtml }, async (request, reply) => {
    if (!request.tenantId) return;
    const csrfToken = await issueCsrfToken(reply);
    return reply.view('upload.eta', {
      csrfToken,
      maxUploadBytes: container.config.MAX_UPLOAD_BYTES,
    });
  });

  app.get<{ Params: { id: string }; Querystring: { flash?: string } }>(
    '/files/:id',
    { preHandler: requireSessionHtml },
    async (request, reply) => {
      if (!request.tenantId) return;
      const file = await files.findById(container.pool, request.tenantId, request.params.id);
      if (!file) return renderNotFound(reply);

      const tenant = await tenants.findById(container.pool, request.tenantId);
      const allowlist = await container.services.settings.getAllowlist(request.tenantId, file.id);
      const csrfToken = await issueCsrfToken(reply);
      const flash = request.query.flash ? FLASH_MESSAGES[request.query.flash] : undefined;

      return reply.view('file-detail.eta', {
        file: {
          id: file.id,
          displayName: file.display_name,
          status: file.status,
          customMessage: file.custom_message,
          expiryMode: file.expires_at ? 'custom' : 'none',
          expiresAtIso: file.expires_at ? file.expires_at.toISOString().slice(0, 10) : null,
          allowlistMode: file.allowlist_mode,
          allowlist,
        },
        distributionUrl: container.services.links.distributionUrl(file),
        mailtoUrl: tenant ? container.services.links.mailtoUrl(file, tenant.slug) : '',
        csrfToken,
        flash,
        dmarcNote: DMARC_NOTE,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: SettingsBody }>(
    '/files/:id/settings',
    { preValidation: app.csrfProtection, preHandler: requireSessionHtml },
    async (request: FastifyRequest<{ Params: { id: string }; Body: SettingsBody }>, reply) => {
      if (!request.tenantId) return;
      const body = request.body ?? {};
      const allowlist = (body.allowlist ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');

      try {
        await container.services.settings.updateSettings(
          request.tenantId,
          request.params.id,
          {
            displayName: body.displayName,
            customMessage: body.customMessage,
            expiryMode: body.expiryMode as ExpiryMode | undefined,
            expiryDays: body.expiryDays ? Number(body.expiryDays) : undefined,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
            allowlistMode: body.allowlistMode as AllowlistMode | undefined,
            allowlist,
          },
          container.ports.clock,
        );
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.NOT_FOUND) {
          return renderNotFound(reply);
        }
        if (err instanceof AppError && err.code === ErrorCode.VALIDATION_ERROR) {
          reply.code(200);
          return reply.view('error.eta', {
            message: err.message,
            resendHref: `/files/${request.params.id}`,
          });
        }
        throw err;
      }

      return reply.redirect(`/files/${request.params.id}?flash=saved`);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/files/:id/delete',
    { preValidation: app.csrfProtection, preHandler: requireSessionHtml },
    async (request, reply) => {
      if (!request.tenantId) return;
      await container.services.files.deleteFile(request.tenantId, request.params.id);
      return reply.redirect('/files');
    },
  );
}
