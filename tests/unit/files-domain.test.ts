import { describe, expect, it } from 'vitest';
import { normalizeMime } from '../../src/domain/files.js';

/**
 * Finding #4 (docs/security/appsec-review.md): `normalizeMime` is the pure function
 * `FilesService.createStaged` runs every client-supplied `Content-Type` through before it
 * is stored — no DB needed to exercise it directly.
 */
describe('normalizeMime', () => {
  it('passes through an already-clean, already-lowercase MIME type unchanged', () => {
    expect(normalizeMime('application/pdf')).toBe('application/pdf');
    expect(normalizeMime('image/png')).toBe('image/png');
  });

  it('lowercases a mixed-case MIME type', () => {
    expect(normalizeMime('Application/PDF')).toBe('application/pdf');
    expect(normalizeMime('IMAGE/JPEG')).toBe('image/jpeg');
  });

  it('strips a trailing ;charset=... (or any other) parameter', () => {
    expect(normalizeMime('text/plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeMime('text/html;charset=UTF-8;boundary=x')).toBe('text/html');
  });

  it('strips control characters before validating', () => {
    expect(normalizeMime('text/plain\r\nX-Injected: evil')).toBe('application/octet-stream');
    expect(normalizeMime('text\x00/plain')).toBe('text/plain');
  });

  it('falls back to application/octet-stream for anything that is not a clean type/subtype', () => {
    expect(normalizeMime('not-a-mime-type')).toBe('application/octet-stream');
    expect(normalizeMime('')).toBe('application/octet-stream');
    expect(normalizeMime('text/plain/extra')).toBe('application/octet-stream');
    expect(normalizeMime('text/')).toBe('application/octet-stream');
    expect(normalizeMime('/plain')).toBe('application/octet-stream');
  });

  it('a bare control-character payload with no slash also falls back', () => {
    // The exact case the finding calls out: previously this would have been written
    // straight to the `mime` column and then corrupted the `Content-Type` response
    // header on every subsequent download.
    expect(normalizeMime('\r\nSet-Cookie: evil=1')).toBe('application/octet-stream');
  });
});
