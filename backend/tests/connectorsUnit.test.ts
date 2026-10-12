// W1 — pure pieces of the POS connector: signatures, backoff, HTTP
// classification (servd connector API v1), the SSRF guard, the QR renderer,
// the fiscal view and the test driver's scenario table.
import { describe, it, expect } from 'vitest'
import { signBody, verifySignature, backoffBaseMs, nextDelayMs, scrubMessage, isoPkt, karachiDay } from '../src/connectors/util.js'
import { classifyFailure, parseFiscalBody, parseChargeBody, httpCall } from '../src/connectors/drivers/http.js'
import { isPrivateAddress, parseFiscalSettings, parseTerminalSettings, reportingRequiredOf } from '../src/connectors/config.js'
import { renderQrSvg } from '../src/connectors/fiscal/qr.js'
import { legacySrbAlias, viewStatusOf, type FiscalView } from '../src/connectors/fiscal/view.js'
import { testTerminalDriver, testApproval } from '../src/connectors/drivers/test.js'
import type { ConnectorCtx, TerminalSettings } from '../src/connectors/types.js'
import { parseInboundEvent } from '../src/connectors/inbound.js'

describe('signatures', () => {
  it('round-trips, rejects tampering, wrong secrets and stale timestamps', () => {
    const now = 1_760_000_000
    const sig = signBody('s3cret', '{"a":1}', now)
    expect(sig).toMatch(/^t=1760000000,v1=[0-9a-f]{64}$/)
    expect(verifySignature(sig, 's3cret', '{"a":1}', now + 10)).toBe(true)
    expect(verifySignature(sig, 's3cret', '{"a":2}', now)).toBe(false)
    expect(verifySignature(sig, 'other', '{"a":1}', now)).toBe(false)
    expect(verifySignature(sig, 's3cret', '{"a":1}', now + 301)).toBe(false)
    expect(verifySignature('t=1,v1=zz', 's3cret', '', now)).toBe(false)
    expect(verifySignature(undefined, 's3cret', '', now)).toBe(false)
  })
})

describe('backoff', () => {
  it('5 s, 15 s, 1 m, 5 m, 15 m, 30 m, 1 h, then hourly; ±20 %; vendor retryAfter wins when longer', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 30].map(backoffBaseMs)).toEqual([5_000, 15_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000])
    expect(nextDelayMs(1, { rand: () => 0 })).toBe(4_000)
    expect(nextDelayMs(1, { rand: () => 1 })).toBe(6_000)
    expect(nextDelayMs(1, { rand: () => 0.5, retryAfterMs: 90_000 })).toBe(90_000)
    expect(nextDelayMs(1, { rand: () => 0.5, floorMs: 300_000 })).toBe(300_000)
  })
})

describe('HTTP classification (servd connector API v1)', () => {
  it('maps status codes to rejected / AUTH / not_found / transient / unknown', () => {
    expect(classifyFailure({ status: 422, body: { code: 'BAD_NTN', message: 'NTN invalid' } }, 'POST')).toMatchObject({ kind: 'rejected', code: 'BAD_NTN' })
    expect(classifyFailure({ status: 409, body: { code: 'conflict' } }, 'POST')).toMatchObject({ kind: 'rejected' })
    expect(classifyFailure({ status: 401, body: null }, 'POST')).toMatchObject({ kind: 'rejected', code: 'AUTH' })
    expect(classifyFailure({ status: 403, body: null }, 'GET')).toMatchObject({ kind: 'rejected', code: 'AUTH' })
    expect(classifyFailure({ status: 404, body: null }, 'GET')).toEqual({ kind: 'not_found' })
    expect(classifyFailure({ status: 429, body: null, retryAfterMs: 2000 }, 'POST')).toMatchObject({ kind: 'transient', retryAfterMs: 2000 })
    expect(classifyFailure({ status: 503, body: null }, 'POST')).toMatchObject({ kind: 'transient' })
    expect(classifyFailure({ status: 408, body: null }, 'POST')).toMatchObject({ kind: 'transient' })
    expect(classifyFailure({ status: 302, body: null }, 'POST')).toMatchObject({ kind: 'unknown' })
  })

  it('parses filed / processing / rejected fiscal bodies and charge states', () => {
    expect(parseFiscalBody({ status: 'filed', fiscalNumber: 'SRB-1', authority: 'SRB', qrPayload: 'q', fiscalAt: '2026-10-10T10:00:00+05:00', extraNumbers: [{ authority: 'fbr', number: 'F-1' }, { authority: 'zz', number: 'x' }] }, 201))
      .toMatchObject({ state: 'filed', result: { fiscalNumber: 'SRB-1', authority: 'srb', qrPayload: 'q', extraNumbers: [{ authority: 'fbr', number: 'F-1' }] } })
    expect(parseFiscalBody({ status: 'processing', providerRef: 'p1', retryAfterMs: 30000 }, 202)).toEqual({ state: 'processing', providerRef: 'p1', retryAfterMs: 30000 })
    expect(parseFiscalBody({ status: 'filed', authority: 'srb' }, 200)).toBeNull()
    expect(parseChargeBody({ status: 'approved', providerRef: 'p', approvalRef: 'a', amountCents: 100, last4: '4242' })).toMatchObject({ state: 'approved', last4: '4242' })
    expect(parseChargeBody({ status: 'approved', providerRef: 'p', approvalRef: 'a', amountCents: 100, last4: '4111111111111111' })).toMatchObject({ last4: undefined })
    expect(parseChargeBody({ status: 'approved', providerRef: 'p' })).toBeNull()
    expect(parseChargeBody({ status: 'awaiting_card' })).toEqual({ state: 'awaiting_card' })
  })

  it('never calls a private address (the guard sits in the socket lookup) and never plain http', async () => {
    const ctx = (baseUrl: string): ConnectorCtx => ({
      tenantId: 't', connectorId: 'c', driver: 'http', isTest: false, baseUrl, apiKey: 'k', webhookSecret: null,
      settings: parseFiscalSettings({}), signal: AbortSignal.timeout(3000), now: () => new Date(), log: () => {},
    })
    expect(await httpCall(ctx('http://example.com'), 'GET', '/health', null, 'x')).toMatchObject({ kind: 'transient', code: 'URL_NOT_ALLOWED' })
    expect(await httpCall(ctx('https://localhost:1'), 'GET', '/health', null, 'x')).toMatchObject({ kind: 'transient' })
    expect(await httpCall(ctx('https://127.0.0.1:1'), 'GET', '/health', null, 'x')).toMatchObject({ kind: 'transient' })
  })

  it('private-address detection', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '203.0.113.9', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('W1-R3: IPv6 is judged on its bytes — mapped / compatible / NAT64 / 6to4 / Teredo spellings of private IPv4 are private', () => {
    for (const ip of [
      '::ffff:7f00:1', '::ffff:127.0.0.1', '::FFFF:7F00:0001', '0:0:0:0:0:ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe',
      '::7f00:1', '::127.0.0.1', '::0.0.0.1', '0:0:0:0:0:0:0:1', '::', '0::0', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::', '2002:0a00:0001::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'fc00::1', 'ff02::1', '2001:db8::1', 'not-an-ip',
    ]) expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2a00:1450:4001:80b::200e']) expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('W1-R3: the http driver refuses an IP-literal host that is IPv6 or non-public (it never reaches the guarded lookup)', async () => {
    const ctx = (baseUrl: string): ConnectorCtx => ({
      tenantId: 't', connectorId: 'c', driver: 'http', isTest: false, baseUrl, apiKey: 'k', webhookSecret: null,
      settings: parseFiscalSettings({}), signal: AbortSignal.timeout(3000), now: () => new Date(), log: () => {},
    })
    for (const u of ['https://[::ffff:127.0.0.1]:1', 'https://[::ffff:a00:1]', 'https://[::127.0.0.1]', 'https://[64:ff9b::7f00:1]', 'https://[2606:4700::1111]', 'https://127.0.0.1:1', 'https://10.0.0.5', 'https://localhost:1']) {
      expect(await httpCall(ctx(u), 'GET', '/health', null, 'x'), u).toMatchObject({ kind: 'transient', code: 'URL_NOT_ALLOWED' })
    }
  })
})

describe('settings', () => {
  it('defaults and clamps; a bad field falls back to its default; the reporting switch defaults to required', () => {
    expect(parseFiscalSettings({})).toMatchObject({ syncTimeoutMs: 3000, syncAtTill: true, fileZeroValue: true, maxAgeHours: 72, outlets: [] })
    expect(parseFiscalSettings({ syncTimeoutMs: 99_999, fileZeroValue: false }).syncTimeoutMs).toBe(3000)
    expect(parseFiscalSettings({ syncTimeoutMs: 99_999, fileZeroValue: false }).fileZeroValue).toBe(false)
    expect(parseTerminalSettings(null)).toMatchObject({ chargeTimeoutSec: 120, pollMs: 1500, allowManualRef: true, terminals: [] })
    expect(reportingRequiredOf({})).toBe(true)
    expect(reportingRequiredOf({ fiscalReportingRequired: false })).toBe(false)
  })
})

describe('QR', () => {
  it('renders a self-contained SVG; empty input gives no QR', () => {
    const svg = renderQrSvg('https://fiscal.test.servd.pk/verify/TEST-SRB-ABC')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<path')
    expect(svg).not.toContain('fiscal.test.servd.pk')
    expect(svg).not.toMatch(/<script|href=/)
    expect(renderQrSvg('')).toBe('')
    expect(renderQrSvg(null)).toBe('')
  })
})

describe('fiscal view', () => {
  it('maps raw statuses for people; test is test; the srb alias only for a filed real SRB number', () => {
    expect(viewStatusOf({ status: 'manual_filed', isTest: false, driver: 'manual' })).toBe('filed')
    expect(viewStatusOf({ status: 'held', isTest: false, driver: null })).toBe('pending')
    expect(viewStatusOf({ status: 'manual_required', isTest: false, driver: null })).toBe('pending')
    expect(viewStatusOf({ status: 'rejected', isTest: false, driver: 'http' })).toBe('failed')
    expect(viewStatusOf({ status: 'skipped', isTest: false, driver: null })).toBe('not_required')
    expect(viewStatusOf({ status: 'filed', isTest: true, driver: 'test' })).toBe('test')
    const filed = { status: 'filed', authority: 'srb', fiscalNumber: 'SRB-9', verifyUrl: 'https://v', qrPayload: 'q' } as FiscalView
    expect(legacySrbAlias(filed)).toEqual({ srbInvoiceId: 'SRB-9', qrCodeLink: 'https://v' })
    expect(legacySrbAlias({ ...filed, status: 'test' })).toBeNull()
    expect(legacySrbAlias({ ...filed, authority: 'fbr' })).toBeNull()
    expect(legacySrbAlias(null)).toBeNull()
  })
})

describe('test card machine scenario table', () => {
  const ctx = (scenario: NonNullable<TerminalSettings['test']>['scenario'], now: Date): ConnectorCtx => ({
    tenantId: 't', connectorId: 'c', driver: 'test', isTest: true, baseUrl: null, apiKey: null, webhookSecret: null,
    settings: parseTerminalSettings({ test: { scenario } }), signal: AbortSignal.timeout(1000), now: () => now, log: () => {},
  })
  const req = (amountCents: number) => ({ chargeId: 'ch1', terminalId: 'DEV', amountCents, currency: 'PKR' as const, kind: 'charge' as const, startedAt: new Date(0), description: 'x', callbackUrl: 'https://x' })
  it('by_amount picks the scenario from the last two digits', async () => {
    const later = new Date(5_000)
    expect(await testTerminalDriver.getChargeStatus(ctx('by_amount', later), req(10_000))).toEqual({ kind: 'ok', value: testApproval('ch1', 10_000) })
    expect(await testTerminalDriver.getChargeStatus(ctx('by_amount', later), req(10_051))).toEqual({ kind: 'ok', value: { state: 'declined', reason: 'TEST_DECLINED' } })
    expect(await testTerminalDriver.getChargeStatus(ctx('by_amount', later), req(10_052))).toEqual({ kind: 'ok', value: { state: 'awaiting_card' } })
    expect((await testTerminalDriver.startCharge(ctx('by_amount', later), req(10_053))).kind).toBe('unknown')
    expect(await testTerminalDriver.startCharge(ctx('by_amount', later), req(10_056))).toMatchObject({ kind: 'transient', code: 'TERMINAL_UNREACHABLE' })
    expect(await testTerminalDriver.getChargeStatus(ctx('approve', new Date(1_000)), req(100))).toEqual({ kind: 'ok', value: { state: 'awaiting_card' } })
    expect(testApproval('ch1', 1).authCode).toMatch(/^\d{6}$/)
  })
})

describe('inbound events', () => {
  it('parses the published webhook bodies; junk is rejected', () => {
    expect(parseInboundEvent({ id: 'e1', type: 'terminal.charge.updated', data: { chargeId: 'c1', status: 'declined', message: 'no' } }))
      .toEqual({ id: 'e1', type: 'terminal.charge.updated', chargeId: 'c1', state: { state: 'declined', reason: 'no' } })
    expect(parseInboundEvent({ id: 'e2', type: 'fiscal.document.updated', data: { documentId: 'd1', status: 'rejected', code: 'X', message: 'm' } }))
      .toMatchObject({ value: { state: 'rejected', code: 'X' } })
    expect(parseInboundEvent({ id: 'e3', type: 'fiscal.document.updated', data: { documentId: 'd1', status: 'filed', fiscalNumber: 'N', authority: 'srb' } }))
      .toMatchObject({ value: { state: 'filed', result: { fiscalNumber: 'N' } } })
    expect(parseInboundEvent({ type: 'terminal.charge.updated', data: {} })).toBeNull()
    expect(parseInboundEvent({ id: 'e4', type: 'other', data: {} })).toBeNull()
  })
})

describe('misc', () => {
  it('scrubs secrets and card numbers from vendor messages; PKT formatting', () => {
    expect(scrubMessage('Authorization: Bearer abc.def.ghi failed for 4111111111111111')).not.toMatch(/abc\.def|4111111111111111/)
    expect(scrubMessage('api_key=sk_live_123 rejected')).toBe('api_key=*** rejected')
    expect(isoPkt(new Date('2026-10-10T20:00:00Z'))).toBe('2026-10-11T01:00:00+05:00')
    expect(karachiDay(new Date('2026-10-10T20:00:00Z'))).toBe('2026-10-11')
  })
})
