import type { FileRow } from '../db/repositories/files.js';
import { buildMailtoUrl } from '../lib/mailto.js';

export interface LinksConfig {
  BRANDED_PAGE_ENABLED: boolean;
  PUBLIC_BASE_URL: string;
  INBOUND_DOMAIN: string;
}

/**
 * Distribution-link resolution and mailto construction (architecture.md §7). The flag
 * decides AC-U2 (off → raw Zoho public link) vs AC-U3 (on → the branded `/s/:slug` page).
 */
export class LinksService {
  constructor(private readonly config: LinksConfig) {}

  /** `undefined` when the file has no distribution link yet (still publishing). */
  distributionUrl(file: Pick<FileRow, 'zoho_public_link' | 'public_slug'>): string | undefined {
    if (this.config.BRANDED_PAGE_ENABLED) {
      return `${this.config.PUBLIC_BASE_URL}/s/${file.public_slug}`;
    }
    return file.zoho_public_link ?? undefined;
  }

  mailtoUrl(file: Pick<FileRow, 'request_token' | 'display_name'>, tenantSlug: string): string {
    return buildMailtoUrl({
      slug: tenantSlug,
      token: file.request_token,
      inboundDomain: this.config.INBOUND_DOMAIN,
      displayName: file.display_name,
    });
  }
}
