import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { contentDispositionAttachment } from '../../lib/content-disposition.js';
import { isVideoMime } from '../../lib/presentation.js';

/**
 * The branded page (architecture.md §7, AC-U3): `/s/:slug` 404s outright when
 * `BRANDED_PAGE_ENABLED` is off (the slug is simply never advertised while off — Links
 * only emits it when the flag is on). The raw Zoho URL is never passed to the template or
 * present in any header; `/download` proxies bytes through the server instead of
 * redirecting, which is what actually keeps the Zoho URL out of the address bar (a 302
 * would put it right back in).
 */
export function registerPublicShareRoutes(app: FastifyInstance, container: Container): void {
  app.get<{ Params: { slug: string } }>('/s/:slug', async (request, reply) => {
    if (!container.config.BRANDED_PAGE_ENABLED) {
      reply.code(404);
      return reply.view('error.eta', { title: 'שגיאה', message: 'הדף לא נמצא.' });
    }

    const file = await container.services.files.resolveBySlug(request.params.slug);
    const now = container.ports.clock.now();
    const unavailable =
      !file ||
      file.status !== 'ready' ||
      (file.expires_at !== null && file.expires_at !== undefined && file.expires_at <= now);
    if (unavailable || !file) {
      return reply.view('share-expired.eta', { title: 'הקישור אינו פעיל', hideFooter: true });
    }

    const embedSrc = `https://workdrive.zohoexternal.com/embed/${file.zoho_embed_token}?toolbar=false&appearance=light`;
    return reply.view('share-page.eta', {
      title: file.display_name,
      hideFooter: true,
      displayName: file.display_name,
      embedSrc,
      // Frontend-engineer addition: picks the embed frame's aspect ratio (visual-spec.md
      // §5). `file.mime` was already loaded off the resolved row — this is presentation,
      // not a new read, so it doesn't touch the data contract's leak-safety guarantee
      // (AC-U3's own test asserts neither the raw Zoho link nor the resource id ever
      // appear in this response).
      isVideo: isVideoMime(file.mime),
      downloadHref: `/s/${file.public_slug}/download`,
    });
  });

  app.get<{ Params: { slug: string } }>('/s/:slug/download', async (request, reply) => {
    if (!container.config.BRANDED_PAGE_ENABLED) {
      reply.code(404);
      return reply.send();
    }

    const file = await container.services.files.resolveBySlug(request.params.slug);
    const now = container.ports.clock.now();
    const expired =
      !file ||
      file.status !== 'ready' ||
      (file.expires_at !== null && file.expires_at !== undefined && file.expires_at <= now);
    if (expired || !file || !file.zoho_resource_id) {
      reply.code(410);
      return reply.send();
    }

    const stream = await container.ports.fileStore.openDownload(file.zoho_resource_id);
    reply.header('Content-Type', file.mime);
    reply.header('Content-Disposition', contentDispositionAttachment(file.display_name));
    return reply.send(stream);
  });
}
