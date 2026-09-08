import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { createTenantWithReadyFile } from '../setup/fixtures.js';
import {
  authenticationResultsHeader,
  buildSignedWebhookPayload,
  pushMessageHeader,
} from '../setup/webhook.js';
import { deliveries } from '../../src/db/repositories/deliveries.js';
import { fileAllowlist } from '../../src/db/repositories/file-allowlist.js';
import { files } from '../../src/db/repositories/files.js';
import { mapMailgunInboundPayload } from '../../src/adapters/mailgun/mapping.js';

/**
 * RED TEAM — the authentication gate (AC-R1, AC-R3).
 *
 * Threat model: the attacker controls every byte of the *message* (headers, body,
 * envelope, attachments) but not the Mailgun signature. Mailgun's inbound-route webhook
 * flattens the message's own MIME headers into the POST payload alongside the fields
 * Mailgun itself generates. `adapters/mailgun/mapping.ts` reads DMARC out of that same
 * flat namespace by *guessing* key names, with no separation between provider-asserted
 * and message-asserted fields — so the question these tests answer is: can the requester
 * assert their own authentication result?
 */
describe.skipIf(!hasTestDatabase())('RED TEAM — inbound auth gate (AC-R1/AC-R3)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  // ---------------------------------------------------------------- RT-01
  // The requester puts `X-Mailgun-Dmarc-Result: pass` in their own outgoing message.
  // Mailgun's inbound parse surfaces message headers as payload fields; `extractDmarc`
  // probes exactly that key name and accepts it. No SPF, no DKIM, no aligned domain —
  // the whole gate that makes this product shippable (research/03 §2) is satisfied by a
  // header the attacker typed.
  it('RT-01: a message-supplied `X-Mailgun-Dmarc-Result: pass` header must NOT satisfy the DMARC gate', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt01@example.com');
    // Backend-engineer fix note: `createTenantWithReadyFile` signs in through the real
    // magic-link flow, which itself sends one email via the same fake outbound adapter —
    // so an absolute `toHaveLength(0)` here was always off by one, independent of the
    // DMARC bypass this test exists to catch (every sibling assertion in this file that
    // cares about `sent` uses this same `sentBefore` delta for exactly that reason).
    // Correcting the count, not the security assertion.
    const sentBefore = container.fakes.outboundMail.sent.length;

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'attacker@no-dmarc-at-all.test',
      // Mailgun asserted nothing: no `dmarc` field at all.
    });
    // ...but the attacker's own message carried this header.
    payload['X-Mailgun-Dmarc-Result'] = 'pass';

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.status).toBe(200);

    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('quarantined');
    expect(outcome.deliveryId).toBeUndefined();
    expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);
  });

  // Same root cause, the shortest key in the candidate list. A message header literally
  // named `Dmarc:` is legal MIME and costs the attacker one line of SMTP.
  it('RT-01b: a message-supplied `Dmarc: pass` header must NOT satisfy the DMARC gate', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt01b@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'attacker@no-dmarc-at-all.test',
    });
    payload.Dmarc = 'pass';

    await container.services.requestPipeline.handleWebhook(payload);
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('quarantined');
  });

  // ---------------------------------------------------------------- RT-05
  // FULL KILL-CHAIN. Mailgun's inbound routes "post all MIME headers into the app" in
  // addition to its own synthetic parameters, so every field this pipeline treats as a
  // provider assertion — `Dmarc`, `Dmarc-Domain`, `Spf`, `Dkim` — is a header the
  // requester can simply type. Chain them with RT-04's two-`@` address and an attacker
  // with no domain, no SPF, no DKIM and no DMARC gets an allowlist-restricted file mailed
  // to a mailbox they control. This is exactly the "request-forgery-to-exfiltration"
  // primitive research/03 §2 rated Critical and that the DMARC gate exists to remove.
  it('RT-05: forged auth headers + a two-`@` From must not exfiltrate an allowlisted file', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt05@example.com');
    await files.updateSettings(container.pool, tenant.id, file.id, {
      allowlistMode: 'allowlist',
    });
    await fileAllowlist.add(container.pool, tenant.id, file.id, '@victim-corp.test');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      // Allowlist sees `victim-corp.test`; SMTP routes on the LAST `@`.
      fromAddress: 'ceo@victim-corp.test@mailbox.attacker.test',
    });
    // Headers the attacker put in their own message; Mailgun posts them as parameters.
    payload.Dmarc = 'pass';
    payload['Dmarc-Domain'] = 'victim-corp.test';
    payload.Spf = 'pass';
    payload.Dkim = 'pass';

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).not.toBe('queued');
  });

  // ---------------------------------------------------------------- RT-02
  // Gate 6's DMARC-alignment check is `if (msg.dmarcDomain && ...)`. `dmarcDomain` comes
  // from recognized fields only. If the provider reports the evaluated domain under any
  // OTHER, unrecognized name, the mapper returns null and the alignment check correctly
  // fails closed rather than silently disappearing.
  //
  // Fix pass 5, F-B update: this test used to set `payload['Authentication-Results']` as
  // a bare top-level field — exactly the un-authserv-id-validated "degraded fallback"
  // critic finding F-B deleted entirely (`docs/reviews/critic-report.md`). That field is
  // now simply never read, so the assertion below flips: the mapper genuinely cannot see
  // ANY evaluated domain (not even a wrong one) when it is only ever reported under an
  // unrecognized key name — proving the root cause even more directly than before.
  it('RT-02: DMARC alignment must fail closed when the evaluated domain cannot be read from the payload', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt02@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'ceo@victim-corp.test',
      // Deliberately not using the `dmarc` option (it auto-supplies a well-formed,
      // recognized evaluated domain) — this test wants a `pass` whose ONLY reported
      // evaluated domain lives under unrecognized key names.
    });
    payload.dmarc = 'pass';
    // The evaluated domain, reported ONLY under keys the mapper does not recognize.
    payload['Authentication-Results'] =
      'mxa.mailgun.test; dmarc=pass header.from=attacker-relay.test';
    payload['X-Mailgun-Dmarc-Evaluated-Domain'] = 'attacker-relay.test';

    // Proof of the root cause: the mapper cannot see ANY evaluated domain at all — not
    // even the attacker's own claimed one — because neither field name is recognized.
    expect(mapMailgunInboundPayload(payload).dmarcDomain).toBeNull();

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('quarantined');
    expect(rows[0]?.reason).toBe('dmarc_alignment_unknown');
  });

  // ---------------------------------------------------------------- RT-03
  // Two `From:` headers. Mailgun exposes the parsed one as `from` and the raw one as
  // `From`; the mapper prefers `From` and never cross-checks. Gate 6's "exactly one From
  // address" only counts addresses *inside one header value*, so two headers sail past it
  // and the pipeline delivers to whichever representation it happened to prefer — which
  // is not necessarily the one the provider authenticated.
  it('RT-03: a payload whose `From` and `from` representations disagree must be quarantined', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt03@example.com');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'ceo@victim-corp.test',
      dmarc: 'pass',
    });
    // `buildSignedWebhookPayload` set `From`. Mailgun's parsed field disagrees.
    payload.from = '<attacker@relay.test>';

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('quarantined');
  });

  // ---------------------------------------------------------------- RT-04
  // The pipeline never validates that the extracted From address is a single, well-formed
  // mailbox. `extractAddresses` accepts anything matching `<...>`, and `fromDomain` is
  // `split('@')[1]` — the FIRST domain-ish segment. For `victim@corp.test@attacker.test`
  // that is `corp.test`, which is what the allowlist gate is checked against, while the
  // address the reply is actually sent to routes on the LAST `@`. Allowlist bypass.
  it('RT-04: a From address with two `@` must be rejected, not allowlisted on its first domain', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt04@example.com');
    await files.updateSettings(container.pool, tenant.id, file.id, {
      allowlistMode: 'allowlist',
    });
    await fileAllowlist.add(container.pool, tenant.id, file.id, '@corp.test');

    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'victim@corp.test@attacker.test',
      dmarc: 'pass',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).not.toBe('queued');
  });

  // ---------------------------------------------------------------- blocked vectors
  // These are the attacks the gates DO stop. They stay here as regressions so a future
  // refactor of `extractDmarc` / gate 6 cannot quietly loosen them.
  it.each([
    ['bestguesspass', 'dmarc_unknown'],
    ['pass (p=none)', 'dmarc_unknown'],
    ['permerror', 'dmarc_unknown'],
    ['', 'dmarc_unknown'],
  ] as const)(
    'BLOCKED: dmarc=%j is not an exact `pass` and quarantines',
    async (dmarcValue, expectedReason) => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        `rt-dmarc-${Buffer.from(dmarcValue).toString('hex')}@example.com`,
      );
      const payload = buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'attacker@relay.test',
      });
      payload.dmarc = dmarcValue;

      const sentBefore = container.fakes.outboundMail.sent.length;
      await container.services.requestPipeline.handleWebhook(payload);
      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('quarantined');
      expect(rows[0]?.reason).toBe(expectedReason);
      expect(container.fakes.outboundMail.sent).toHaveLength(sentBefore);
    },
  );

  it.each(['pass', 'Pass', 'PASS', '  pass  ', ' PASS '])(
    'DOCUMENTED: dmarc=%j is accepted (case- and whitespace-tolerant, not a bypass)',
    async (dmarcValue) => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        `rt-ok-${Buffer.from(dmarcValue).toString('hex')}@example.com`,
      );
      const payload = buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'legit@relay.test',
      });
      // F-2 hardening: a real `pass` always carries the evaluated `header.from` domain
      // alongside it (that IS what a provider-asserted pass looks like) — a bare
      // `dmarc=pass` with no domain at all now quarantines (`dmarc_alignment_unknown`),
      // so this case, like SANITY below, supplies one via a real `Authentication-Results`
      // header (mapping.ts source (b)) rather than the guessed `dmarc` field alone. The
      // case/whitespace variance under test moves into the header's own `dmarc=` value,
      // which `parseAuthenticationResultsValue`'s regex is equally tolerant of.
      //
      // Fix pass 5, F-B: pushed into `message-headers` via `pushMessageHeader`, not set
      // as a bare top-level field — the old top-level-only "degraded fallback" this
      // relied on is deleted entirely (`docs/reviews/critic-report.md`).
      pushMessageHeader(
        payload,
        'Authentication-Results',
        authenticationResultsHeader({ dmarc: dmarcValue, headerFrom: 'relay.test' }),
      );
      const outcome = await container.services.requestPipeline.handleWebhook(payload);
      expect(outcome.deliveryId).toBeDefined();
    },
  );

  it('SANITY: an exact `pass` from the provider, with its evaluated domain, proceeds', async () => {
    // Pins the positive control for the whole file. F-2 hardening: a `pass` MUST carry an
    // evaluated `header.from` domain to be accepted at all (see DOCUMENTED cases' comment
    // above) — this is a real provider-asserted `Authentication-Results` pass, not a
    // domain-less one.
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt-ws@example.com');
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'legit@relay.test',
    });
    pushMessageHeader(
      payload,
      'Authentication-Results',
      authenticationResultsHeader({ headerFrom: 'relay.test' }),
    );
    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeDefined();
  });

  it(
    'BLOCKED (F-2 hardening): dmarc=pass with NO evaluated domain available anywhere ' +
      'in the payload is quarantined, never accepted',
    async () => {
      const container = buildTestContainer();
      const { tenant, file } = await createTenantWithReadyFile(
        container,
        'rt-align-unknown@example.com',
      );
      const payload = buildSignedWebhookPayload(container, {
        requestToken: file.request_token,
        tenantSlug: tenant.slug,
        fromAddress: 'legit@relay.test',
        // Deliberately NOT using the `dmarc` option here: `buildSignedWebhookPayload`
        // auto-supplies an aligned `Authentication-Results` header whenever `dmarc:
        // 'pass'` is passed that way (so every OTHER happy-path test in this suite gets a
        // realistic pass) — this test exists specifically to construct the domain-less
        // case that auto-fill exists to prevent everywhere else, so it sets the field by
        // hand instead, exactly like SANITY/DOCUMENTED did before F-2 hardening.
      });
      // Provider asserts pass ... but reports no evaluated domain anywhere (no
      // dmarc-domain field, no Authentication-Results header at all) — must fail closed.
      payload.dmarc = 'pass';

      const outcome = await container.services.requestPipeline.handleWebhook(payload);
      expect(outcome.deliveryId).toBeUndefined();
      const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
      expect(rows[0]?.outcome).toBe('quarantined');
      expect(rows[0]?.reason).toBe('dmarc_alignment_unknown');
    },
  );

  it('BLOCKED: display-name spoof `"victim@x" <attacker@y>` is rejected as multi-address', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt-dn@example.com');
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      dmarc: 'pass',
    });
    payload.From = '"ceo@victim-corp.test" <attacker@relay.test>';

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.outcome).toBe('quarantined');
    expect(rows[0]?.reason).toBe('from_address_invalid');
  });

  it('BLOCKED: `<victim@x>, <attacker@y>` (two addresses, one header) is rejected', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt-two@example.com');
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'ceo@victim-corp.test',
      extraFromAddresses: ['attacker@relay.test'],
      dmarc: 'pass',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.reason).toBe('from_address_invalid');
  });

  it('BLOCKED: an explicit dmarc-domain mismatch is caught when the provider does report it', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt-align@example.com');
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      fromAddress: 'ceo@victim-corp.test',
      dmarc: 'pass',
      dmarcDomain: 'attacker-relay.test',
    });

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeUndefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.reason).toBe('dmarc_domain_mismatch');
  });

  it('BLOCKED: case/whitespace variants of the From address do not evade the alignment check', async () => {
    const container = buildTestContainer();
    const { tenant, file } = await createTenantWithReadyFile(container, 'rt-case@example.com');
    const payload = buildSignedWebhookPayload(container, {
      requestToken: file.request_token,
      tenantSlug: tenant.slug,
      dmarc: 'pass',
      dmarcDomain: 'Relay.TEST',
    });
    payload.From = '  <Attacker@RELAY.test>  ';

    const outcome = await container.services.requestPipeline.handleWebhook(payload);
    expect(outcome.deliveryId).toBeDefined();
    const rows = await deliveries.listForFile(container.pool, tenant.id, file.id);
    expect(rows[0]?.requester_address).toBe('attacker@relay.test');
  });
});
