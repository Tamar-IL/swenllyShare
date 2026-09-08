import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { isClientAbortError, registerErrorHandler } from '../../src/http/plugins/error-handler.js';

/**
 * Bug 8 (`docs/qa/qa-report-sender-app.md`): cancelling an in-progress request (e.g. the
 * upload dropzone mid-upload) surfaces as a plain socket reset, not an application fault
 * — it must never be logged at `error` level (that pollutes error-rate dashboards/alerts
 * with false positives on every legitimate cancel click).
 */
describe('isClientAbortError', () => {
  it('recognizes ECONNRESET/ECONNABORTED/EPIPE as a client abort', () => {
    expect(isClientAbortError(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))).toBe(
      true,
    );
    expect(isClientAbortError(Object.assign(new Error('aborted'), { code: 'ECONNABORTED' }))).toBe(
      true,
    );
    expect(isClientAbortError(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).toBe(
      true,
    );
  });

  it('does not misclassify an ordinary error, or non-error values', () => {
    expect(isClientAbortError(new Error('boom'))).toBe(false);
    expect(isClientAbortError(Object.assign(new Error('boom'), { code: 'ENOENT' }))).toBe(false);
    expect(isClientAbortError(null)).toBe(false);
    expect(isClientAbortError(undefined)).toBe(false);
  });
});

/** Reads every JSON log line written to `stream` so far. */
function readLogLines(chunks: string[]): Array<Record<string, unknown>> {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('registerErrorHandler — client aborts', () => {
  it('logs an ECONNRESET below error level as a routine client abort, not "unhandled error"', async () => {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    const app = Fastify({ logger: { level: 'info', stream } });
    registerErrorHandler(app);
    app.get('/boom', () => {
      throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom' });
    await app.close();

    expect(res.statusCode).toBe(500);
    const lines = readLogLines(chunks);
    expect(lines.some((l) => l.level === 50)).toBe(false); // never at 'error' (50)
    const abortLine = lines.find((l) => l.msg === 'client aborted the request');
    expect(abortLine).toBeDefined();
    expect(abortLine!.level).toBeLessThan(50);
  });

  it('still logs a genuine unexpected error at error level (unchanged)', async () => {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    const app = Fastify({ logger: { level: 'info', stream } });
    registerErrorHandler(app);
    app.get('/boom', () => {
      throw new Error('genuinely broken');
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/boom' });
    await app.close();

    const lines = readLogLines(chunks);
    const errorLine = lines.find((l) => l.msg === 'unhandled error');
    expect(errorLine).toBeDefined();
    expect(errorLine!.level).toBe(50);
  });
});
