// SRB direct — servd files its own sales tax invoices with the Sindh Revenue
// Board (owner, 2026-10-30: "servd files sales tax invoices DIRECTLY with SRB
// from its own till"; SRB only, FBR is not used; Keenu is no longer the
// fiscal POS). This REVERSES the 2026-10-10 rule "never add a direct authority
// client" for SRB only — and it lives INSIDE the connector framework: one
// driver here, one line in registry.ts FISCAL_DRIVERS, the ONE outbox
// (fiscal/outbox.ts) decides when and how often it is called. Never a second
// filer, queue or table.
//
// SRB "POS Invoice Payload Specification" v1:
//   POST https://pos.srb.gos.pk/ePOSGateway/v1/SalesInvoiceService.api
//   - one flat JSON invoice (no items array); figures from
//     fiscal/payload.ts toSrbInvoiceFields (the ported mapping);
//   - credentials IN the body: pos_user (settings.srb.posUser) and pos_pass
//     (the connector's API key, sealed with lib/secretBox.ts);
//   - transType "Live" only when settings.srb.live is on, else "Test"; a
//     setup dry run (payload.test) is ALWAYS "Test";
//   - success = resCode "00" with srbInvoiceId; QRCodeLink must be printed as
//     a QR on the receipt → FiscalResult.qrPayload AND verifyUrl (the receipt
//     draws qrPayload ?? verifyUrl, legacySrbAlias reads verifyUrl ?? qrPayload).
//   - a sales return is the same call with invoiceType 2.
//
// Transport: drivers/http.ts httpCall against the FIXED SRB host — https
// only, the guarded DNS lookup, 256 KB cap, ctx.signal, the practice-copy
// backstop (the registry already swaps in the test driver there). No API-key
// header and no signature are sent (ctx.apiKey / webhookSecret are blanked for
// the call): the password travels in the body only, and is redacted from
// every message this driver returns. Never logged.
//
// Classification:
//   error before the request was written → transient (SRB never acted)
//   timeout / reset after it was written → unknown
//   401 / 403 → rejected AUTH (the outbox backs off and alerts)
//   408 / 429 / 5xx → transient · other 4xx → rejected
//   2xx resCode "00" + srbInvoiceId → filed
//   2xx resCode ≠ "00" → rejected SRB_<resCode> (scrubbed message)
//   2xx without a readable answer → unknown BAD_RESPONSE
//
// No lookup (SRB has no "get invoice" API): capabilities().lookup = false.
// When an earlier submit's outcome is UNKNOWN the outbox resends the FROZEN
// payload — the same deterministic invoiceId (SRB-<last 12 of the order id>,
// SRBRET-<order>-<document> for a return). SRB keeps invoiceId unique per
// POS, so the replay is either filed once or refused as a duplicate (then the
// document is 'rejected' with an alert: check the SRB portal and record the
// filing by hand with SRB's number). That is the safest replay available
// without a lookup; it never builds a second invoiceId for the same document.

import type { ConnectorCtx, FiscalDriver, FiscalPayload, FiscalSettings, FiscalSubmitValue, Outcome } from '../types.js'
import { toSrbInvoiceFields } from '../fiscal/payload.js'
import { scrubMessage } from '../util.js'
import { classifyFailure, httpCall, type HttpCallResult } from './http.js'

export const SRB_BASE_URL = 'https://pos.srb.gos.pk'
export const SRB_INVOICE_PATH = '/ePOSGateway/v1/SalesInvoiceService.api'

/** One POST to SRB. Swappable in tests only (setSrbTransport). */
export type SrbTransport = (ctx: ConnectorCtx, body: Record<string, unknown>, idempotencyKey: string) => Promise<HttpCallResult>

const defaultTransport: SrbTransport = (ctx, body, key) =>
  httpCall({ ...ctx, baseUrl: SRB_BASE_URL, apiKey: null, webhookSecret: null }, 'POST', SRB_INVOICE_PATH, body, key)

let transport: SrbTransport = defaultTransport

/** Tests only: replace the SRB call (null restores the real one). */
export function setSrbTransport(fn: SrbTransport | null): void {
  transport = fn ?? defaultTransport
}

function srbSettings(ctx: ConnectorCtx): { posUser: string; live: boolean } | null {
  const s = (ctx.settings as FiscalSettings).srb
  return s && s.posUser.trim() ? { posUser: s.posUser.trim(), live: s.live === true } : null
}

/** Remove the password (and anything credential-shaped) from a message. */
function clean(msg: unknown, pass: string | null, max = 500): string {
  let s = typeof msg === 'string' ? msg : (msg instanceof Error ? msg.message : JSON.stringify(msg ?? ''))
  if (pass) s = s.split(pass).join('***')
  return scrubMessage(s, max)
}

const na = (v: string | null | undefined) => (v && v.trim() ? v.trim() : 'N/A')

/** The SRB request body for a document (credentials included — never logged or returned). */
export function srbRequestBody(p: FiscalPayload, creds: { posUser: string; posPass: string; live: boolean }): Record<string, unknown> {
  const f = toSrbInvoiceFields(p)
  return {
    ...f,
    consumerMobile: na(p.buyer?.phone),
    consumerEmail: 'N/A',
    address: na(p.buyer?.address),
    extraInf: 'N/A',
    // A setup dry run is never a live invoice, whatever the switch says.
    transType: creds.live && !p.test ? 'Live' : 'Test',
    pos_user: creds.posUser,
    pos_pass: creds.posPass,
  }
}

async function submit(ctx: ConnectorCtx, p: FiscalPayload): Promise<Outcome<FiscalSubmitValue>> {
  const s = srbSettings(ctx)
  if (!s || !ctx.apiKey) {
    return { kind: 'transient', code: 'NOT_CONFIGURED', message: 'Enter the SRB POS user and password on the POS connector page' }
  }
  const reg = p.registrations.find((r) => r.authority === 'srb')
  if (!reg) return { kind: 'rejected', code: 'NOT_REGISTERED', message: 'This brand has no SRB POS id — set it on the POS connector page' }
  if (!/^\d{1,18}$/.test(reg.posId.trim())) return { kind: 'rejected', code: 'BAD_POS_ID', message: 'The SRB POS id must be a number' }

  const body = srbRequestBody(p, { posUser: s.posUser, posPass: ctx.apiKey, live: s.live })
  let r: HttpCallResult
  try {
    r = await transport(ctx, body, String(body['invoiceId']))
  } catch (err) {
    // A transport that throws gives no sign of whether SRB got it.
    return { kind: 'unknown', code: 'NETWORK', message: clean(err, ctx.apiKey) }
  }
  if (r.kind !== 'answer') return { ...r, message: clean(r.message, ctx.apiKey) }
  const a = r.answer
  if (a.status >= 200 && a.status < 300) {
    const b = (a.body && typeof a.body === 'object' ? a.body : null) as Record<string, unknown> | null
    const resCode = b && (typeof b['resCode'] === 'string' || typeof b['resCode'] === 'number') ? String(b['resCode']).trim() : ''
    if (!b || !resCode) return { kind: 'unknown', code: 'BAD_RESPONSE', message: 'SRB answered without a result code' }
    if (resCode !== '00') {
      const msg = b['message'] ?? b['Message'] ?? b['error'] ?? `resCode ${resCode}`
      return { kind: 'rejected', code: `SRB_${resCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'ERR'}`, message: clean(msg, ctx.apiKey), httpStatus: a.status }
    }
    const id = typeof b['srbInvoiceId'] === 'string' || typeof b['srbInvoiceId'] === 'number' ? String(b['srbInvoiceId']).trim() : ''
    if (!id) return { kind: 'unknown', code: 'BAD_RESPONSE', message: 'SRB answered success without an invoice number' }
    const qr = typeof b['QRCodeLink'] === 'string' && b['QRCodeLink'].trim() ? b['QRCodeLink'].trim().slice(0, 1000) : undefined
    return {
      kind: 'ok',
      value: {
        state: 'filed',
        result: {
          fiscalNumber: id.slice(0, 100),
          authority: 'srb',
          fiscalAt: ctx.now().toISOString(),
          ...(qr && { qrPayload: qr, verifyUrl: qr }),
        },
      },
    }
  }
  const f = classifyFailure(a, 'POST')
  if (f.kind === 'not_found') return { kind: 'rejected', code: 'NOT_FOUND', message: 'SRB endpoint not found', httpStatus: a.status }
  return { ...f, message: clean(f.message, ctx.apiKey) }
}

export const srbFiscalDriver: FiscalDriver = {
  id: 'srb',
  label: 'SRB direct (servd files itself)',
  needs: { baseUrl: false, apiKey: true, webhookSecret: false },
  capabilities: () => ({ refunds: true, zeroValue: false, lookup: false, billPush: false }),
  submitSale: (ctx, p) => submit(ctx, p),
  submitRefund: (ctx, p) => submit(ctx, p), // invoiceType 2 comes from toSrbInvoiceFields (p.kind 'refund')
  async getDocumentStatus() {
    // capabilities().lookup is false, so the outbox never asks; answer "try later" if anything does.
    return { kind: 'transient', code: 'LOOKUP_UNSUPPORTED', message: 'SRB has no invoice lookup — check the SRB portal' }
  },
  async health(ctx) {
    // SRB has no ping endpoint: "configured" is all servd can say without filing.
    // "Test connection" with the dry run files a Test invoice (transType Test).
    const s = srbSettings(ctx)
    if (!s || !ctx.apiKey) return { kind: 'transient', code: 'NOT_CONFIGURED', message: 'Enter the SRB POS user and password' }
    return { kind: 'ok', value: { latencyMs: 0, detail: `SRB credentials set (${s.live ? 'Live' : 'Test'} mode); run the dry run to file a Test invoice` } }
  },
}
