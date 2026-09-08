import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import {
  MailgunInboundAdapter,
  MailgunOutboundAdapter,
  type MailgunConfig,
} from '../../src/adapters/mailgun/real.js';
import { computeMailgunSignature } from '../../src/adapters/mailgun/fake.js';
import { AmbiguousSendError, PermanentError, TransientError } from '../../src/ports/errors.js';
import type { Clock } from '../../src/ports/clock.js';
import { pathnameIs, readMockBodyText } from './support/mock-http.js';

/**
 * Offline unit tests for the Mailgun real adapters (architecture.md §2/§9 item 4).
 * `verify`/`parse` make no network call — they're exercised directly, proving they truly
 * delegate to `adapters/mailgun/signature.ts` / `mapping.ts` rather than reimplementing
 * anything (architecture.md §4.1's "reuse the fake/mapping"). `send` is exercised against
 * `undici`'s `MockAgent`, which intercepts Node's global `fetch` the same way it
 * intercepts `undici.request` (confirmed in this adapter's own class doc). All of this
 * runs in the normal `pnpm test`; see `tests/contract/inbound-mail.test.ts` and
 * `tests/contract/outbound-mail.test.ts` for the fake-vs-real port-contract suites.
 */

function fixedClock(iso: string): Clock {
  const now = new Date(iso);
  return { now: () => now, sleep: async () => undefined };
}

const CONFIG: MailgunConfig = {
  apiBase: 'https://api.mailgun.test',
  apiKey: 'key-abc123',
  signingKey: 'test-signing-key',
  sendingDomain: 'mail.swenlly.test',
  outboundFrom: 'Swenlly <no-reply@mail.swenlly.test>',
};

describe('MailgunInboundAdapter.verify (pure — no network)', () => {
  it('accepts a signature computed the same way Mailgun documents, within the time window', async () => {
    const clock = fixedClock('2026-09-08T12:00:00Z');
    const adapter = new MailgunInboundAdapter(CONFIG, clock);
    const timestamp = String(Math.floor(new Date('2026-09-08T12:00:00Z').getTime() / 1000));
    const token = 'abc123token';
    const signature = computeMailgunSignature(CONFIG.signingKey, timestamp, token);

    await expect(adapter.verify({ timestamp, token, signature })).resolves.toBe(true);
  });

  it('rejects a signature computed with the wrong key', async () => {
    const clock = fixedClock('2026-09-08T12:00:00Z');
    const adapter = new MailgunInboundAdapter(CONFIG, clock);
    const timestamp = String(Math.floor(new Date('2026-09-08T12:00:00Z').getTime() / 1000));
    const badSignature = computeMailgunSignature('wrong-key', timestamp, 'tok');

    await expect(
      adapter.verify({ timestamp, token: 'tok', signature: badSignature }),
    ).resolves.toBe(false);
  });

  it('rejects a timestamp outside the ±5 minute window', async () => {
    const clock = fixedClock('2026-09-08T12:00:00Z');
    const adapter = new MailgunInboundAdapter(CONFIG, clock);
    const staleTimestamp = String(
      Math.floor(new Date('2026-09-08T11:00:00Z').getTime() / 1000), // 1 hour stale
    );
    const signature = computeMailgunSignature(CONFIG.signingKey, staleTimestamp, 'tok');

    await expect(
      adapter.verify({ timestamp: staleTimestamp, token: 'tok', signature }),
    ).resolves.toBe(false);
  });
});

describe('MailgunInboundAdapter.parse (pure — delegates entirely to mapping.ts)', () => {
  it('maps recipient/From/dmarc fields exactly like FakeInboundMail would', () => {
    const adapter = new MailgunInboundAdapter(CONFIG, fixedClock('2026-09-08T12:00:00Z'));
    const payload = {
      recipient: 'cust-abc123+file-xyz@share.swenlly.com',
      From: '"Some Sender" <sender@example.com>',
      subject: 'hello',
      'body-plain': 'body text',
      'Message-Id': '<msg-1@mailgun>',
      token: 'tok-1',
      dmarc: 'pass',
      // Fix pass 5, F-B (docs/reviews/critic-report.md): the anti-forgery dedup guard
      // requires `message-headers` to be present — a realistic Mailgun payload always
      // carries SOME MIME headers.
      'message-headers': JSON.stringify([['From', '"Some Sender" <sender@example.com>']]),
    };

    const parsed = adapter.parse(payload);

    expect(parsed.recipientRaw).toBe('cust-abc123+file-xyz@share.swenlly.com');
    expect(parsed.fromAddresses).toEqual(['sender@example.com']);
    expect(parsed.dmarc).toBe('pass');
    expect(parsed.providerMessageId).toBe('<msg-1@mailgun>');
  });

  it('defaults dmarc to "unknown" when no candidate field is present — never infers pass', () => {
    const adapter = new MailgunInboundAdapter(CONFIG, fixedClock('2026-09-08T12:00:00Z'));
    const parsed = adapter.parse({ recipient: 'a@b.com', From: 'x@y.com' });
    expect(parsed.dmarc).toBe('unknown');
  });
});

describe('MailgunOutboundAdapter.send — offline wire-shape tests', () => {
  let mockAgent: MockAgent;
  let restoreDispatcher: ReturnType<typeof getGlobalDispatcher>;

  beforeEach(() => {
    restoreDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(restoreDispatcher);
    await mockAgent.close();
  });

  it('POSTs a multipart form to /v3/{domain}/messages with Basic auth and from/to/subject/text fields', async () => {
    const pool = mockAgent.get('https://api.mailgun.test');
    let capturedPath = '';
    let capturedAuth = '';
    let capturedBody = '';
    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .reply(async (opts) => {
        capturedPath = opts.path;
        capturedAuth = (opts.headers as Record<string, string>).authorization;
        capturedBody = await readMockBodyText(opts.body);
        return { statusCode: 200, data: { id: '<msg-1@mailgun.test>', message: 'Queued' } };
      });

    const adapter = new MailgunOutboundAdapter(CONFIG);
    const result = await adapter.send({
      to: 'requester@example.com',
      subject: 'Your file',
      text: 'Here is the file you requested.',
    });

    expect(result.providerMessageId).toBe('<msg-1@mailgun.test>');
    expect(capturedPath).toBe('/v3/mail.swenlly.test/messages');
    const expectedAuth = `Basic ${Buffer.from('api:key-abc123').toString('base64')}`;
    expect(capturedAuth).toBe(expectedAuth);
    expect(capturedBody).toContain('name="from"');
    expect(capturedBody).toContain(CONFIG.outboundFrom);
    expect(capturedBody).toContain('name="to"');
    expect(capturedBody).toContain('requester@example.com');
    expect(capturedBody).toContain('name="subject"');
    expect(capturedBody).toContain('Your file');
    expect(capturedBody).toContain('name="text"');
    expect(capturedBody).toContain('Here is the file you requested.');
    expect(capturedBody).not.toContain('Reply-To');
  });

  it('inlines an attachment as a named multipart file part when present', async () => {
    const pool = mockAgent.get('https://api.mailgun.test');
    let capturedBody = '';
    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .reply(async (opts) => {
        capturedBody = await readMockBodyText(opts.body);
        return { statusCode: 200, data: { id: '<msg-2@mailgun.test>' } };
      });

    const adapter = new MailgunOutboundAdapter(CONFIG);
    await adapter.send({
      to: 'requester@example.com',
      subject: 'Your file',
      text: 'body',
      attachment: {
        filename: 'report.pdf',
        content: Buffer.from('%PDF-fake-bytes'),
        contentType: 'application/pdf',
      },
    });

    expect(capturedBody).toContain('name="attachment"; filename="report.pdf"');
    expect(capturedBody).toContain('Content-Type: application/pdf');
    expect(capturedBody).toContain('%PDF-fake-bytes');
  });

  it('classifies a non-2xx response as TransientError (5xx) or PermanentError (other)', async () => {
    const pool = mockAgent.get('https://api.mailgun.test');
    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .reply(500, { message: 'Server error' });
    const adapter = new MailgunOutboundAdapter(CONFIG);
    await expect(adapter.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      TransientError,
    );

    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .reply(401, { message: 'Forbidden' });
    await expect(adapter.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('throws PermanentError when a 2xx response carries no message id', async () => {
    const pool = mockAgent.get('https://api.mailgun.test');
    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .reply(200, { message: 'Queued, but no id?!' });
    const adapter = new MailgunOutboundAdapter(CONFIG);

    await expect(adapter.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('stamps a deterministic v:swenlly-delivery custom variable and Message-Id when deliveryId is given', async () => {
    const pool = mockAgent.get('https://api.mailgun.test');
    let capturedBody = '';
    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .reply(async (opts) => {
        capturedBody = await readMockBodyText(opts.body);
        return { statusCode: 200, data: { id: '<msg-3@mailgun.test>' } };
      });

    const adapter = new MailgunOutboundAdapter(CONFIG);
    await adapter.send({
      to: 'a@b.com',
      subject: 's',
      text: 't',
      deliveryId: 'delivery-abc-123',
    });

    expect(capturedBody).toContain('name="v:swenlly-delivery"');
    expect(capturedBody).toContain('delivery-abc-123');
    expect(capturedBody).toContain('name="h:Message-Id"');
    expect(capturedBody).toContain('swenlly-delivery-delivery-abc-123@mail.swenlly.test');
  });

  it('classifies a fetch failure with no completed exchange: never-connected codes are Transient, everything else is Ambiguous', async () => {
    // Node's fetch (undici) wraps a low-level connection failure as
    // `TypeError('fetch failed', { cause })`, where `cause` is the underlying system-error-
    // shaped object carrying `.code` directly (`err.cause.code`) — reproduced here the same
    // way undici itself constructs it (confirmed against a real ECONNREFUSED via MockAgent
    // during development), not a made-up shape.
    const pool = mockAgent.get('https://api.mailgun.test');
    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .replyWithError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const adapter = new MailgunOutboundAdapter(CONFIG);
    await expect(adapter.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      TransientError,
    );

    // A connection that WAS established (or a timeout/reset that could have occurred after
    // the request body was already written) cannot be proven to be a non-send.
    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await expect(adapter.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      AmbiguousSendError,
    );

    pool
      .intercept({ path: pathnameIs('/v3/mail.swenlly.test/messages'), method: 'POST' })
      .replyWithError(new Error('some other undocumented failure shape'));
    await expect(adapter.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      AmbiguousSendError,
    );
  });
});
