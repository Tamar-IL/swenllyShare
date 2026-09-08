import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { files } from '../../db/repositories/files.js';
import { tenants } from '../../db/repositories/tenants.js';
import { deliveries } from '../../db/repositories/deliveries.js';
import { requireSessionHtml } from '../plugins/auth.js';
import { issueCsrfToken } from '../plugins/csrf.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { buildRequestAddress } from '../../lib/addressing.js';
import type { AllowlistMode } from '../../db/repositories/files.js';
import type { ExpiryMode } from '../../domain/settings.js';
import {
  computeDisplayStatus,
  STATUS_META,
  OUTCOME_META,
  mechanismLabel,
  formatHebrewDate,
  formatHebrewDateTime,
  formatByteCeiling,
  expiryMetaLabel,
  deliveryCountLabel,
  isVideoMime,
} from '../../lib/presentation.js';

const DMARC_NOTE =
  'בקשות מגיעות רק מכתובות מאומתות (DMARC) — Gmail וכתובות רגילות עובדות; ' +
  'דומיינים מותאמים אישית עשויים להיכשל.';

const FLASH_MESSAGES: Record<string, string> = {
  saved: 'ההגדרות נשמרו.',
  deleted: 'הקובץ נמחק.',
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
  await reply.view('error.eta', { title: 'שגיאה', message: 'הקובץ לא נמצא.' });
}

/** Tenant-scoped file pages: list, per-file detail/settings, delete
 * (architecture.md §11). Every lookup goes through the tenant-scoped repository, so a
 * wrong tenant gets a plain 404 (AC-A3), never a 403 with any distinguishing detail. */
export function registerFileRoutes(app: FastifyInstance, container: Container): void {
  app.get<{ Querystring: { flash?: string } }>(
    '/files',
    { preHandler: requireSessionHtml },
    async (request, reply) => {
      if (!request.tenantId) return; // requireSessionHtml already redirected
      const now = container.ports.clock.now();
      const [rows, sentCounts, csrfToken] = await Promise.all([
        files.list(container.pool, request.tenantId),
        deliveries.countsSentByTenant(container.pool, request.tenantId),
        issueCsrfToken(reply),
      ]);
      const flash = request.query.flash ? FLASH_MESSAGES[request.query.flash] : undefined;

      return reply.view('files-list.eta', {
        title: 'הקבצים שלי',
        appHeader: true,
        csrfToken,
        flash,
        files: rows.map((f) => {
          const status = computeDisplayStatus(f, now);
          return {
            id: f.id,
            displayName: f.display_name,
            isVideo: isVideoMime(f.mime),
            pillClass: STATUS_META[status].pillClass,
            statusLabel: STATUS_META[status].label,
            uploadedAtLabel: formatHebrewDate(f.created_at),
            deliveryCountLabel: deliveryCountLabel(sentCounts.get(f.id) ?? 0),
          };
        }),
      });
    },
  );

  app.get('/files/new', { preHandler: requireSessionHtml }, async (request, reply) => {
    if (!request.tenantId) return;
    const csrfToken = await issueCsrfToken(reply);
    return reply.view('upload.eta', {
      title: 'העלאת קובץ',
      appHeader: true,
      csrfToken,
      maxUploadBytes: container.config.MAX_UPLOAD_BYTES,
      maxUploadLabel: formatByteCeiling(container.config.MAX_UPLOAD_BYTES),
    });
  });

  app.get<{ Params: { id: string }; Querystring: { flash?: string } }>(
    '/files/:id',
    { preHandler: requireSessionHtml },
    async (request, reply) => {
      if (!request.tenantId) return;
      const file = await files.findById(container.pool, request.tenantId, request.params.id);
      if (!file) return renderNotFound(reply);

      const now = container.ports.clock.now();
      const [tenant, allowlist, deliveriesResult, csrfToken] = await Promise.all([
        tenants.findById(container.pool, request.tenantId),
        container.services.settings.getAllowlist(request.tenantId, file.id),
        container.services.audit.listForFile(request.tenantId, file.id),
        issueCsrfToken(reply),
      ]);
      const flash = request.query.flash ? FLASH_MESSAGES[request.query.flash] : undefined;
      const displayStatus = computeDisplayStatus(file, now);

      return reply.view('file-detail.eta', {
        title: file.display_name,
        appHeader: true,
        file: {
          id: file.id,
          displayName: file.display_name,
          // Bug 4 (QA report): a deleted file must read as inactive exactly like an
          // expired one (UX brief: deleting is "equivalent to instant expiry") — treat
          // `deleted` like `expired` in this read model so both artifact cards disable.
          isExpired: displayStatus === 'expired' || displayStatus === 'deleted',
          isPublishing: displayStatus === 'publishing',
          isFailed: displayStatus === 'failed',
          pillClass: STATUS_META[displayStatus].pillClass,
          statusLabel: STATUS_META[displayStatus].label,
          uploadedAtLabel: formatHebrewDate(file.created_at),
          expiryMetaLabel: expiryMetaLabel(displayStatus, file.expires_at, now),
          customMessage: file.custom_message,
          expiryMode: file.expires_at ? 'custom' : 'none',
          expiresAtIso: file.expires_at ? file.expires_at.toISOString().slice(0, 10) : null,
          allowlistMode: file.allowlist_mode,
          allowlist,
        },
        distributionUrl: container.services.links.distributionUrl(file),
        mailtoUrl: tenant ? container.services.links.mailtoUrl(file, tenant.slug) : '',
        // Frontend-engineer addition: the plain `cust-<slug>+file-<token>@domain` address
        // (no mailto: scheme, no encoded subject/body) for display and for the copy
        // button — matching the UX brief §1.4 mock, which shows the bare address next to
        // "העתק", not the full percent-encoded URI. The clickable artifact-card value
        // still uses the full `mailtoUrl` href so clicking it opens a pre-filled email.
        mailtoAddress: tenant
          ? buildRequestAddress(tenant.slug, file.request_token, container.config.INBOUND_DOMAIN)
          : '',
        csrfToken,
        flash,
        dmarcNote: DMARC_NOTE,
        deliverySinceIso: deliveriesResult.items[0]?.created_at.toISOString() ?? '',
        // Bug 1 (QA report): paired with deliverySinceIso as a `(created_at, id)` keyset
        // cursor — see src/db/repositories/deliveries.ts listForFile()'s doc comment.
        deliverySinceId: deliveriesResult.items[0]?.id ?? '',
        deliveries: deliveriesResult.items.map((d) => ({
          address: d.requester_address,
          mechanismLabel: mechanismLabel(d.mechanism),
          pillClass: OUTCOME_META[d.outcome].pillClass,
          outcomeLabel: OUTCOME_META[d.outcome].label,
          atLabel: formatHebrewDateTime(d.created_at),
        })),
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
            title: 'שגיאה',
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
      // Bug 2 (QA report): match the 404 contract every other tenant-scoped route in this
      // file returns for a cross-tenant/unknown id — `deleteFile` returns `undefined` for
      // exactly that case (a true no-op; nothing was touched), so the route must check it
      // instead of always redirecting as if the delete succeeded.
      const deleted = await container.services.files.deleteFile(
        request.tenantId,
        request.params.id,
      );
      if (!deleted) return renderNotFound(reply);
      return reply.redirect('/files?flash=deleted');
    },
  );
}
