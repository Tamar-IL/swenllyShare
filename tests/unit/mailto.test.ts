import { describe, expect, it } from 'vitest';
import { buildMailtoUrl } from '../../src/lib/mailto.js';

describe('buildMailtoUrl', () => {
  it('builds a mailto: link with the emitted "+" address, an encoded Hebrew subject and body', () => {
    const url = buildMailtoUrl({
      slug: 'tenant01',
      token: 'a'.repeat(26),
      inboundDomain: 'share.swenlly.test',
      displayName: 'תקציב.xlsx',
    });

    expect(url.startsWith(`mailto:cust-tenant01+file-${'a'.repeat(26)}@share.swenlly.test?`)).toBe(
      true,
    );

    const [, query] = url.split('?');
    const params = new URLSearchParams(query);
    expect(params.get('subject')).toBe('בקשה לקבל קובץ: תקציב.xlsx');
    expect(params.get('body')).toBe(
      ['שלום,', 'אני מבקש/ת לקבל את הקובץ "תקציב.xlsx".', 'אנא השב/י למייל זה עם הקובץ.'].join(
        '\r\n',
      ),
    );
  });

  it('percent-encodes CRLF in the body as %0D%0A', () => {
    const url = buildMailtoUrl({
      slug: 'tenant02',
      token: 'b'.repeat(26),
      inboundDomain: 'share.swenlly.test',
      displayName: 'x.pdf',
    });
    expect(url).toContain('%0D%0A');
  });

  it('never contains a literal space (Hebrew/mixed content is fully percent-encoded)', () => {
    const url = buildMailtoUrl({
      slug: 'tenant03',
      token: 'c'.repeat(26),
      inboundDomain: 'share.swenlly.test',
      displayName: 'my report v2.pdf',
    });
    expect(url).not.toContain(' ');
  });
});
