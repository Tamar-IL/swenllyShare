import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { requireSessionHtml } from '../plugins/auth.js';
import { requireUuidParams } from '../plugins/uuid-params.js';
import { issueCsrfToken } from '../plugins/csrf.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { buildRequestAddress } from '../../lib/addressing.js';
import type { AllowlistMode } from '../../domain/files.js';
import type { ExpiryMode } from '../../domain/settings.js';
import {
  computeDisplayStatus,
  STATUS_META,
  OUTCOME_META,
  mechanismLabel,
  deliveryAddressLabel,
  canResendDelivery,
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
  // Fix pass 7 (critic N-2, "no way to resend"): POST /files/:id/deliveries/:id/resend.
  resent: 'הבקשה נשלחה שוב.',
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

// Fix pass 10 (critic R-5): a malformed id gets the same 404 as a foreign tenant's id.
const uuidId = requireUuidParams(['id'], renderNotFound);
const uuidIdAndDelivery = requireUuidParams(['id', 'deliveryId'], renderNotFound);

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
        container.services.files.list(request.tenantId),
        container.services.audit.countsSentByTenant(request.tenantId),
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
    { preHandler: [requireSessionHtml, uuidId] },
    async (request, reply) => {
      if (!request.tenantId) return;
      const file = await container.services.files.getById(request.tenantId, request.params.id);
      if (!file) return renderNotFound(reply);

      const now = container.ports.clock.now();
      const [tenant, allowlist, deliveriesResult, csrfToken] = await Promise.all([
        container.services.auth.getTenantById(request.tenantId),
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
          // Fix pass 5, F-C (docs/reviews/critic-report.md): the file's revoke could not
          // be enforced and is still stuck — see src/domain/health.ts's doc comment.
          hasExpiryError: Boolean(file.expiry_error),
          pillClass: STATUS_META[displayStatus].pillClass,
          statusLabel: STATUS_META[displayStatus].label,
          uploadedAtLabel: formatHebrewDate(file.created_at),
          expiryMetaLabel: expiryMetaLabel(displayStatus, file.expires_at, now),
          customMessage: file.custom_message,
          // Fix pass 7 (critic-report.md Minor): pre-select the MODE the sender actually
          // picked (migration 0006's `expiry_mode`/`expiry_days`), not a guess derived
          // from whether `expires_at` happens to be set — the old `file.expires_at ?
          // 'custom' : 'none'` meant an ordinary `days`-mode expiry (every file has one
          // by default, `DEFAULT_EXPIRY_DAYS`) always rendered as "custom date", so the
          // UX brief's default-state mock (the "30 days" radio pre-selected) was never
          // actually shown.
          expiryMode: file.expiry_mode,
          expiryDays: file.expiry_days ?? container.config.DEFAULT_EXPIRY_DAYS,
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
          id: d.id,
          address: deliveryAddressLabel(d),
          mechanismLabel: mechanismLabel(d.mechanism),
          pillClass: OUTCOME_META[d.outcome].pillClass,
          outcomeLabel: OUTCOME_META[d.outcome].label,
          atLabel: formatHebrewDateTime(d.created_at),
          // Fix pass 8 (finding 3): now the shared `canResendDelivery` helper (also used
          // by the JSON poll endpoint) instead of an inline condition duplicated in two
          // places.
          canResend: canResendDelivery(d.outcome),
        })),
      });
    },
  );

  app.post<{ Params: { id: string }; Body: SettingsBody }>(
    '/files/:id/settings',
    { preValidation: app.csrfProtection, preHandler: [requireSessionHtml, uuidId] },
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
            // Fix pass 8 (code-review.md polish-pass finding 1): distinguish "the field
            // was never submitted" (`undefined` -> `SettingsService.resolveExpiry` falls
            // back to `DEFAULT_EXPIRY_DAYS`, the intended behavior) from "the field WAS
            // submitted but is blank/garbage" (a `type="number"` input clears itself to
            // `""` on an invalid value a user typed) — the old `body.expiryDays ? ... :
            // undefined` treated both the same way, silently substituting the default
            // for a value the sender thought they'd set. `Number('')` is `0`, which
            // `resolveExpiry`'s existing `days <= 0` guard already rejects with a
            // validation error instead of a silent default.
            expiryDays: body.expiryDays !== undefined ? Number(body.expiryDays) : undefined,
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
    { preValidation: app.csrfProtection, preHandler: [requireSessionHtml, uuidId] },
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

  /**
   * Fix pass 7 (critic N-2, "no way to resend"): the "שלח שוב" button on a `failed`/
   * `unconfirmed` deliveries-table row. Tenant-scoped (`AuditService.resendDelivery`
   * looks the delivery up by `(tenantId, fileId, deliveryId)` together, so a cross-tenant
   * or cross-file id 404s the same as every other lookup in this file, AC-A3) and rate-
   * limited per file. Not a JSON action — a plain form POST + redirect, same shape as
   * `/settings` and `/delete` above, so it works with no JS.
   */
  app.post<{ Params: { id: string; deliveryId: string } }>(
    '/files/:id/deliveries/:deliveryId/resend',
    { preValidation: app.csrfProtection, preHandler: [requireSessionHtml, uuidIdAndDelivery] },
    async (request, reply) => {
      if (!request.tenantId) return;
      const result = await container.services.audit.resendDelivery(
        request.tenantId,
        request.params.id,
        request.params.deliveryId,
      );
      switch (result.status) {
        case 'ok':
          return reply.redirect(`/files/${request.params.id}?flash=resent`);
        case 'not_found':
          return renderNotFound(reply);
        case 'wrong_outcome':
          reply.code(409);
          return reply.view('error.eta', {
            title: 'שגיאה',
            message: 'ניתן לשלוח שוב רק בקשה שנכשלה או שלא אושרה.',
            resendHref: `/files/${request.params.id}`,
          });
        case 'in_flight':
          reply.code(409);
          return reply.view('error.eta', {
            title: 'שגיאה',
            message: 'כבר קיימת שליחה חוזרת בתהליך עבור כתובת זו — יש להמתין לסיומה.',
            resendHref: `/files/${request.params.id}`,
          });
        case 'rate_limited':
          reply.code(429);
          return reply.view('error.eta', {
            title: 'שגיאה',
            message: 'יותר מדי בקשות לשליחה חוזרת עבור קובץ זה — נסה/י שוב בעוד כמה דקות.',
            resendHref: `/files/${request.params.id}`,
          });
      }
    },
  );
}
