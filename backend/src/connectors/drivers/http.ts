// The generic HTTP driver — "servd connector API v1" (spec §5, published in
// docs/pos-connector-api.md). A vendor implements the contract natively or
// through a thin middleware; a vendor with its own API gets its own file in
// this folder instead.
//
// Transport rules:
//   - https only, no redirects followed, responses capped at 256 KB;
//   - SSRF guard on EVERY call: the host's resolved addresses are checked in
//     the socket's own DNS lookup (no gap between check and connect);
//   - every call is bounded by ctx.signal (the caller's budget);
//   - outbound requests are signed with the webhook secret when one is set.
//
// Classification (never throws on a vendor answer):
//   2xx → ok · 409 {code:'duplicate'} + body → ok (idempotent replay)
//   400/409/422 {code,message} → rejected · 401/403 → rejected AUTH
//   404 on GET → not_found · 408/429/5xx → transient (Retry-After honoured)
//   refused / DNS / TLS / connect failure before the request was written → transient
//   abort / timeout / reset after the request was written → unknown

import https from 'node:https'
import { lookup as dnsLookup } from 'node:dns'
import type { LookupFunction } from 'node:net'
import type {
  ChargeRequest, ChargeState, ConnectorCtx, FiscalAuthority, FiscalDriver, FiscalLookupValue, FiscalPayload,
  FiscalResult, FiscalSettings, FiscalSubmitValue, Outcome, TerminalDriver, TerminalSettings,
} from '../types.js'
import { isForbiddenLiteralHost, isPrivateAddress } from '../config.js'
import { scrubMessage, signBody } from '../util.js'
import { isSandbox } from '../../lib/sandbox.js'

const MAX_BODY = 256 * 1024
const AUTHORITIES: ReadonlySet<string> = new Set(['fbr', 'srb', 'pra', 'kpra', 'bra'])

export interface HttpAnswer {
  status: number
  body: unknown
  retryAfterMs?: number
}

export type HttpCallResult =
  | { kind: 'answer'; answer: HttpAnswer }
  | { kind: 'transient'; code: string; message: string }
  | { kind: 'unknown'; code: string; message: string }

/** A lookup that refuses private / loopback / link-local results. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4)
    const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }]
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      const e = Object.assign(new Error(`SSRF guard: ${hostname} resolves to a non-public address`), { code: 'ESSRF' })
      return callback(e, '', 4)
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list)
    return callback(null, list[0]!.address, list[0]!.family)
  })
}

function parseRetryAfter(v: string | string[] | undefined): number | undefined {
  const s = Array.isArray(v) ? v[0] : v
  if (!s) return undefined
  const secs = Number(s)
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000))
  const at = Date.parse(s)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/**
 * One HTTP exchange. Exported so the classification can be tested without a
 * network. `written` tracks whether the request reached the vendor: an error
 * before that is transient (the vendor never acted), after it unknown.
 */
export function httpCall(ctx: ConnectorCtx, method: 'GET' | 'POST', path: string, body: unknown, idempotencyKey: string): Promise<HttpCallResult> {
  return new Promise((resolve) => {
    // Practice copy backstop (the registry already swaps in the test driver): never a vendor call.
    if (isSandbox()) return resolve({ kind: 'transient', code: 'SANDBOX_BLOCKED', message: 'Practice copy: the POS connector never calls a vendor' })
    if (!ctx.baseUrl) return resolve({ kind: 'transient', code: 'NOT_CONFIGURED', message: 'No base URL is set for this connector' })
    let url: URL
    try { url = new URL(`${ctx.baseUrl.replace(/\/+$/, '')}${path}`) } catch {
      return resolve({ kind: 'transient', code: 'BAD_URL', message: 'The connector base URL is invalid' })
    }
    if (url.protocol !== 'https:') return resolve({ kind: 'transient', code: 'URL_NOT_ALLOWED', message: 'Only https is allowed' })
    // An IP-literal host never reaches guardedLookup (W1-R3): judge it here.
    if (isForbiddenLiteralHost(url)) return resolve({ kind: 'transient', code: 'URL_NOT_ALLOWED', message: 'The connector URL points at a non-public address' })

    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {})
    const settings = ctx.settings as FiscalSettings | TerminalSettings
    const headerName = settings.apiKeyHeader?.trim() || 'Authorization'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Servd-Connector': ctx.connectorId,
      'User-Agent': 'servd-connector/1',
    }
    if (ctx.apiKey) headers[headerName] = headerName.toLowerCase() === 'authorization' ? `Bearer ${ctx.apiKey}` : ctx.apiKey
    if (ctx.webhookSecret) headers['X-Servd-Signature'] = signBody(ctx.webhookSecret, raw, Math.floor(ctx.now().getTime() / 1000))
    if (method !== 'GET') headers['Content-Length'] = String(Buffer.byteLength(raw))

    let written = false
    let settled = false
    const done = (r: HttpCallResult) => { if (!settled) { settled = true; resolve(r) } }

    if (ctx.signal.aborted) return done({ kind: 'transient', code: 'ABORTED', message: 'The call budget ran out before the request was sent' })

    const req = https.request(url, { method, headers, lookup: guardedLookup, signal: ctx.signal, timeout: 60_000 }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) {
          res.destroy()
          done({ kind: 'unknown', code: 'RESPONSE_TOO_LARGE', message: 'The vendor answered with more than 256 KB' })
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: unknown = null
        if (text) { try { parsed = JSON.parse(text) } catch { parsed = { message: text.slice(0, 500) } } }
        done({ kind: 'answer', answer: { status: res.statusCode ?? 0, body: parsed, retryAfterMs: parseRetryAfter(res.headers['retry-after']) } })
      })
      res.on('error', (e) => done({ kind: 'unknown', code: 'RESET_MID_RESPONSE', message: scrubMessage(e) }))
      res.on('aborted', () => done({ kind: 'unknown', code: 'RESET_MID_RESPONSE', message: 'The connection dropped mid-response' }))
    })
    req.on('finish', () => { written = true })
    req.on('timeout', () => req.destroy(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', (e: NodeJS.ErrnoException) => {
      const aborted = e.name === 'AbortError' || e.code === 'ABORT_ERR' || ctx.signal.aborted
      if (written) {
        done({ kind: 'unknown', code: aborted ? 'TIMEOUT' : (e.code ?? 'NETWORK'), message: scrubMessage(e) })
      } else {
        done({ kind: 'transient', code: aborted ? 'TIMEOUT_BEFORE_SEND' : (e.code === 'ESSRF' ? 'URL_NOT_ALLOWED' : (e.code ?? 'NETWORK')), message: scrubMessage(e) })
      }
    })
    if (raw) req.write(raw)
    req.end()
  })
}

/** Turn a non-2xx answer into a classified failure (shared by both kinds). */
export function classifyFailure(a: HttpAnswer, method: 'GET' | 'POST'):
  | { kind: 'rejected'; code: string; message: string; httpStatus: number }
  | { kind: 'transient'; code: string; message: string; retryAfterMs?: number; httpStatus: number }
  | { kind: 'not_found' }
  | { kind: 'unknown'; code: string; message: string } {
  const b = (a.body && typeof a.body === 'object' ? a.body : {}) as { code?: unknown; message?: unknown }
  const code = typeof b.code === 'string' && b.code ? b.code.slice(0, 64) : `HTTP_${a.status}`
  const message = scrubMessage(typeof b.message === 'string' ? b.message : `HTTP ${a.status}`)
  if (a.status === 401 || a.status === 403) return { kind: 'rejected', code: 'AUTH', message, httpStatus: a.status }
  if (a.status === 404 && method === 'GET') return { kind: 'not_found' }
  if (a.status === 400 || a.status === 409 || a.status === 422) return { kind: 'rejected', code, message, httpStatus: a.status }
  if (a.status === 408 || a.status === 429 || a.status >= 500) return { kind: 'transient', code, message, retryAfterMs: a.retryAfterMs, httpStatus: a.status }
  if (a.status === 404) return { kind: 'rejected', code: 'NOT_FOUND', message, httpStatus: 404 }
  // 3xx (redirects are never followed) and anything unexpected.
  return { kind: 'unknown', code: `HTTP_${a.status}`, message }
}

const isDuplicate = (a: HttpAnswer) =>
  a.status === 409 && !!a.body && typeof a.body === 'object' && (a.body as { code?: unknown }).code === 'duplicate'

// ─── Fiscal ───────────────────────────────────────────────────────────────────

function fiscalPath(ctx: ConnectorCtx, key: 'sales' | 'refunds' | 'documents' | 'health', fallback: string): string {
  return (ctx.settings as FiscalSettings).paths?.[key] ?? fallback
}

/** Parse a vendor fiscal body: filed / processing / rejected, else null. */
export function parseFiscalBody(body: unknown, status: number):
  | { state: 'filed'; result: FiscalResult }
  | { state: 'processing'; providerRef?: string; retryAfterMs?: number }
  | { state: 'rejected'; code: string; message: string }
  | null {
  if (!body || typeof body !== 'object') return status === 202 ? { state: 'processing' } : null
  const b = body as Record<string, unknown>
  const str = (k: string) => (typeof b[k] === 'string' && (b[k] as string).length > 0 ? (b[k] as string).slice(0, 1000) : undefined)
  const st = str('status')
  if (st === 'processing' || status === 202) {
    const ra = typeof b['retryAfterMs'] === 'number' ? Math.max(0, Math.min(b['retryAfterMs'] as number, 6 * 3_600_000)) : undefined
    return { state: 'processing', providerRef: str('providerRef'), retryAfterMs: ra }
  }
  if (st === 'rejected') return { state: 'rejected', code: str('code') ?? 'REJECTED', message: scrubMessage(str('message') ?? 'rejected') }
  const fiscalNumber = str('fiscalNumber')
  const authority = str('authority')?.toLowerCase()
  if ((st === 'filed' || st === undefined) && fiscalNumber && authority && AUTHORITIES.has(authority)) {
    const extras = Array.isArray(b['extraNumbers']) ? (b['extraNumbers'] as unknown[]) : []
    const extraNumbers = extras.flatMap((e) => {
      if (!e || typeof e !== 'object') return []
      const x = e as Record<string, unknown>
      const auth = typeof x['authority'] === 'string' ? x['authority'].toLowerCase() : ''
      if (!AUTHORITIES.has(auth) || typeof x['number'] !== 'string') return []
      return [{
        authority: auth as FiscalAuthority,
        number: x['number'].slice(0, 100),
        ...(typeof x['qrPayload'] === 'string' && { qrPayload: x['qrPayload'].slice(0, 1000) }),
        ...(typeof x['verifyUrl'] === 'string' && { verifyUrl: x['verifyUrl'].slice(0, 1000) }),
      }]
    }).slice(0, 5)
    const fiscalAt = str('fiscalAt')
    return {
      state: 'filed',
      result: {
        fiscalNumber: fiscalNumber.slice(0, 100),
        authority: authority as FiscalAuthority,
        fiscalAt: fiscalAt && Number.isFinite(Date.parse(fiscalAt)) ? fiscalAt : new Date().toISOString(),
        qrPayload: str('qrPayload'),
        verifyUrl: str('verifyUrl'),
        providerRef: str('providerRef'),
        ...(extraNumbers.length > 0 && { extraNumbers }),
      },
    }
  }
  return null
}

async function fiscalSubmit(ctx: ConnectorCtx, path: string, p: FiscalPayload): Promise<Outcome<FiscalSubmitValue>> {
  const r = await httpCall(ctx, 'POST', path, p, p.documentId)
  if (r.kind !== 'answer') return r
  const a = r.answer
  if ((a.status >= 200 && a.status < 300) || isDuplicate(a)) {
    const parsed = parseFiscalBody(a.body, a.status)
    if (!parsed) return { kind: 'unknown', code: 'BAD_RESPONSE', message: 'The fiscal POS answered success without a fiscal number' }
    if (parsed.state === 'rejected') return { kind: 'rejected', code: parsed.code, message: parsed.message, httpStatus: a.status }
    if (parsed.state === 'processing') return { kind: 'ok', value: { state: 'processing', providerRef: parsed.providerRef, retryAfterMs: parsed.retryAfterMs ?? a.retryAfterMs } }
    return { kind: 'ok', value: parsed }
  }
  const f = classifyFailure(a, 'POST')
  if (f.kind === 'not_found') return { kind: 'rejected', code: 'NOT_FOUND', message: 'Endpoint not found', httpStatus: 404 }
  return f
}

export const httpFiscalDriver: FiscalDriver = {
  id: 'http',
  label: 'servd connector API v1 (generic HTTP)',
  needs: { baseUrl: true, apiKey: true, webhookSecret: false },
  capabilities: () => ({ refunds: true, zeroValue: true, lookup: true }),
  submitSale: (ctx, p) => fiscalSubmit(ctx, fiscalPath(ctx, 'sales', '/fiscal/sales'), p),
  submitRefund: (ctx, p) => fiscalSubmit(ctx, fiscalPath(ctx, 'refunds', '/fiscal/refunds'), p),
  async getDocumentStatus(ctx, ref): Promise<Outcome<FiscalLookupValue>> {
    const base = fiscalPath(ctx, 'documents', '/fiscal/documents')
    const r = await httpCall(ctx, 'GET', `${base}/${encodeURIComponent(ref.documentId)}`, null, ref.documentId)
    // A lookup never changes anything at the vendor, so "unknown" is just "try again".
    if (r.kind === 'unknown') return { kind: 'transient', code: r.code, message: r.message }
    if (r.kind !== 'answer') return r
    const a = r.answer
    if (a.status >= 200 && a.status < 300) {
      const parsed = parseFiscalBody(a.body, a.status)
      if (!parsed) return { kind: 'transient', code: 'BAD_RESPONSE', message: 'The fiscal POS lookup answered without a status' }
      if (parsed.state === 'rejected') return { kind: 'rejected', code: parsed.code, message: parsed.message, httpStatus: a.status }
      if (parsed.state === 'processing') return { kind: 'ok', value: { state: 'processing', retryAfterMs: parsed.retryAfterMs } }
      return { kind: 'ok', value: parsed }
    }
    const f = classifyFailure(a, 'GET')
    if (f.kind === 'not_found') return { kind: 'ok', value: { state: 'not_found' } }
    if (f.kind === 'unknown') return { kind: 'transient', code: f.code, message: f.message }
    return f
  },
  async health(ctx) {
    const t0 = Date.now()
    const r = await httpCall(ctx, 'GET', fiscalPath(ctx, 'health', '/health'), null, `health-${t0}`)
    if (r.kind === 'unknown') return { kind: 'transient', code: r.code, message: r.message }
    if (r.kind !== 'answer') return r
    if (r.answer.status >= 200 && r.answer.status < 300) {
      const b = (r.answer.body ?? {}) as { ok?: unknown; detail?: unknown }
      if (b.ok === false) return { kind: 'transient', code: 'NOT_OK', message: scrubMessage(b.detail ?? 'vendor reports not ok') }
      return { kind: 'ok', value: { latencyMs: Date.now() - t0, detail: typeof b.detail === 'string' ? scrubMessage(b.detail, 200) : undefined } }
    }
    const f = classifyFailure(r.answer, 'GET')
    if (f.kind === 'not_found') return { kind: 'rejected', code: 'NOT_FOUND', message: 'Health endpoint not found', httpStatus: 404 }
    if (f.kind === 'unknown') return { kind: 'transient', code: f.code, message: f.message }
    return f
  },
}

// ─── Terminal ─────────────────────────────────────────────────────────────────

function terminalPath(ctx: ConnectorCtx, key: 'charges' | 'refunds' | 'health', fallback: string): string {
  return (ctx.settings as TerminalSettings).paths?.[key] ?? fallback
}

/** Parse a vendor charge body into a ChargeState (null when unreadable). */
export function parseChargeBody(body: unknown): ChargeState | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const str = (k: string) => (typeof b[k] === 'string' && (b[k] as string).length > 0 ? (b[k] as string).slice(0, 100) : undefined)
  switch (str('status')) {
    case 'pending': return { state: 'pending' }
    case 'awaiting_card': return { state: 'awaiting_card' }
    case 'declined': return { state: 'declined', reason: scrubMessage(str('message') ?? str('reason') ?? 'declined', 200) }
    case 'cancelled': return { state: 'cancelled' }
    case 'expired': return { state: 'expired' }
    case 'not_found': return { state: 'not_found' }
    case 'approved': {
      const providerRef = str('providerRef')
      const approvalRef = str('approvalRef')
      const amountCents = typeof b['amountCents'] === 'number' && Number.isInteger(b['amountCents']) ? (b['amountCents'] as number) : NaN
      if (!providerRef || !approvalRef || !Number.isFinite(amountCents)) return null
      const last4 = str('last4')
      return {
        state: 'approved', providerRef, approvalRef, amountCents,
        authCode: str('authCode'), cardBrand: str('cardBrand'),
        last4: last4 && /^\d{4}$/.test(last4) ? last4 : undefined,
      }
    }
    default: return null
  }
}

async function chargeStateCall(ctx: ConnectorCtx, method: 'GET' | 'POST', path: string, body: unknown, key: string): Promise<Outcome<ChargeState>> {
  const r = await httpCall(ctx, method, path, body, key)
  if (r.kind === 'unknown') return method === 'GET' ? { kind: 'transient', code: r.code, message: r.message } : r
  if (r.kind !== 'answer') return r
  const a = r.answer
  if (a.status >= 200 && a.status < 300) {
    const s = parseChargeBody(a.body)
    return s ? { kind: 'ok', value: s } : { kind: 'unknown', code: 'BAD_RESPONSE', message: 'The card machine API answered without a readable status' }
  }
  const f = classifyFailure(a, method)
  if (f.kind === 'not_found') return { kind: 'ok', value: { state: 'not_found' } }
  return f
}

function chargeBody(r: ChargeRequest) {
  return {
    chargeId: r.chargeId, terminalId: r.terminalId, amountCents: r.amountCents, currency: r.currency,
    kind: r.kind, description: r.description, callbackUrl: r.callbackUrl,
    ...(r.original && { original: r.original }),
  }
}

export const httpTerminalDriver: TerminalDriver = {
  id: 'http',
  label: 'servd connector API v1 (generic HTTP)',
  needs: { baseUrl: true, apiKey: true, webhookSecret: true },
  capabilities: () => ({ cancel: true, void: true, referencedRefund: true, webhooks: true }),
  async startCharge(ctx, r) {
    const res = await httpCall(ctx, 'POST', terminalPath(ctx, 'charges', '/terminal/charges'), chargeBody(r), r.chargeId)
    if (res.kind !== 'answer') return res
    const a = res.answer
    if ((a.status >= 200 && a.status < 300) || isDuplicate(a)) {
      const b = (a.body ?? {}) as { providerRef?: unknown }
      return { kind: 'ok', value: { providerRef: typeof b.providerRef === 'string' ? b.providerRef.slice(0, 100) : undefined } }
    }
    const f = classifyFailure(a, 'POST')
    if (f.kind === 'not_found') return { kind: 'rejected', code: 'NOT_FOUND', message: 'Endpoint not found', httpStatus: 404 }
    return f
  },
  getChargeStatus(ctx, r) {
    const base = terminalPath(ctx, 'charges', '/terminal/charges')
    return chargeStateCall(ctx, 'GET', `${base}/${encodeURIComponent(r.chargeId)}`, null, r.chargeId)
  },
  cancelCharge(ctx, r) {
    const base = terminalPath(ctx, 'charges', '/terminal/charges')
    return chargeStateCall(ctx, 'POST', `${base}/${encodeURIComponent(r.chargeId)}/cancel`, {}, `cancel-${r.chargeId}`)
  },
  async voidCharge(ctx, r) {
    const base = terminalPath(ctx, 'charges', '/terminal/charges')
    const res = await httpCall(ctx, 'POST', `${base}/${encodeURIComponent(r.chargeId)}/void`, { providerRef: r.providerRef }, `void-${r.chargeId}`)
    if (res.kind !== 'answer') return res
    const a = res.answer
    if (a.status >= 200 && a.status < 300) {
      const b = (a.body ?? {}) as { voided?: unknown }
      return b.voided === true ? { kind: 'ok', value: { voided: true as const } } : { kind: 'unknown', code: 'BAD_RESPONSE', message: 'Void answered without voided:true' }
    }
    const f = classifyFailure(a, 'POST')
    if (f.kind === 'not_found') return { kind: 'rejected', code: 'NOT_FOUND', message: 'Endpoint not found', httpStatus: 404 }
    return f
  },
  async refund(ctx, r) {
    const res = await httpCall(ctx, 'POST', terminalPath(ctx, 'refunds', '/terminal/refunds'), chargeBody(r), r.chargeId)
    if (res.kind !== 'answer') return res
    const a = res.answer
    if ((a.status >= 200 && a.status < 300) || isDuplicate(a)) {
      const b = (a.body ?? {}) as { providerRef?: unknown }
      return { kind: 'ok', value: { providerRef: typeof b.providerRef === 'string' ? b.providerRef.slice(0, 100) : undefined } }
    }
    const f = classifyFailure(a, 'POST')
    if (f.kind === 'not_found') return { kind: 'rejected', code: 'NOT_FOUND', message: 'Endpoint not found', httpStatus: 404 }
    return f
  },
  async health(ctx, terminalId) {
    const t0 = Date.now()
    const base = terminalPath(ctx, 'health', '/terminal/health')
    const q = terminalId ? `?terminalId=${encodeURIComponent(terminalId)}` : ''
    const r = await httpCall(ctx, 'GET', `${base}${q}`, null, `health-${t0}`)
    if (r.kind === 'unknown') return { kind: 'transient', code: r.code, message: r.message }
    if (r.kind !== 'answer') return r
    if (r.answer.status >= 200 && r.answer.status < 300) {
      const b = (r.answer.body ?? {}) as { online?: unknown }
      return { kind: 'ok', value: { online: b.online !== false, latencyMs: Date.now() - t0 } }
    }
    const f = classifyFailure(r.answer, 'GET')
    if (f.kind === 'not_found') return { kind: 'rejected', code: 'NOT_FOUND', message: 'Health endpoint not found', httpStatus: 404 }
    if (f.kind === 'unknown') return { kind: 'transient', code: f.code, message: f.message }
    return f
  },
}
