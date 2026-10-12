// The built-in TEST driver (spec §4). No network, no baseUrl, no key, and NO
// result state: every answer is a pure function of the inputs and ctx.now(),
// so it is deterministic and behaves the same across processes (the till, the
// worker and the sweeper all see the same "vendor").
//
// A document it files carries isTest=true and prints "TEST — NOT A FISCAL
// INVOICE". It exists so a company can rehearse the whole flow (setup page,
// till, card machine, receipts, refunds) before a vendor is chosen.

import type {
  ChargeRequest, ChargeState, ConnectorCtx, FiscalAuthority, FiscalDriver, FiscalLookupValue,
  FiscalPayload, FiscalResult, FiscalSettings, FiscalSubmitValue, Outcome, TerminalDriver, TerminalSettings,
} from '../types.js'
import { prisma } from '../../lib/prisma.js'
import { sha256Hex, sleep } from '../util.js'

/** Per-process call counter — for tests only. */
export const testDriverCalls = {
  submitSale: 0, submitRefund: 0, getDocumentStatus: 0, fiscalHealth: 0,
  startCharge: 0, getChargeStatus: 0, cancelCharge: 0, voidCharge: 0, refund: 0, terminalHealth: 0,
}
export function resetTestDriverCalls(): void {
  for (const k of Object.keys(testDriverCalls) as Array<keyof typeof testDriverCalls>) testDriverCalls[k] = 0
}

const ok = <T>(value: T): Outcome<T> => ({ kind: 'ok', value })

// ─── Fiscal ───────────────────────────────────────────────────────────────────

type FiscalScenario = NonNullable<FiscalSettings['test']>['scenario']

function fiscalScenario(ctx: ConnectorCtx): FiscalScenario {
  return (ctx.settings as FiscalSettings).test?.scenario ?? 'ok'
}

/** The deterministic fiscal result for a document (same number on every call). */
export function testFiscalResult(ctx: ConnectorCtx, p: Pick<FiscalPayload, 'documentId' | 'kind' | 'registrations' | 'issuedAt'>): FiscalResult {
  const authority: FiscalAuthority = p.registrations[0]?.authority ?? 'srb'
  const hash = sha256Hex(`${ctx.tenantId}:${p.documentId}`).slice(0, 10).toUpperCase()
  const number = `TEST-${authority.toUpperCase()}-${p.kind === 'refund' ? 'CN-' : ''}${hash}`
  const link = `https://fiscal.test.servd.pk/verify/${number}`
  return { fiscalNumber: number, authority, fiscalAt: p.issuedAt, qrPayload: link, verifyUrl: link, providerRef: `P-${p.documentId}` }
}

function payloadFields(raw: unknown): Pick<FiscalPayload, 'kind' | 'registrations' | 'issuedAt'> | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<FiscalPayload>
  if (typeof o.issuedAt !== 'string' || !Array.isArray(o.registrations)) return null
  return { kind: o.kind === 'refund' ? 'refund' : 'sale', registrations: o.registrations, issuedAt: o.issuedAt }
}

async function submit(ctx: ConnectorCtx, p: FiscalPayload): Promise<Outcome<FiscalSubmitValue>> {
  switch (fiscalScenario(ctx)) {
    case 'down': return { kind: 'transient', code: 'TEST_DOWN', message: 'Test fiscal POS is down (scenario down)' }
    case 'reject': return { kind: 'rejected', code: 'TEST_REJECT', message: 'Test fiscal POS rejected the document (scenario reject)', httpStatus: 422 }
    case 'auth': return { kind: 'rejected', code: 'AUTH', message: 'Test fiscal POS refused the API key (scenario auth)', httpStatus: 401 }
    case 'processing_then_ok': return ok({ state: 'processing', providerRef: `P-${p.documentId}` })
    case 'unknown_then_filed': return { kind: 'unknown', code: 'TEST_UNKNOWN', message: 'Connection dropped after the document was sent (scenario unknown_then_filed)' }
    case 'slow':
      try {
        await sleep(6000, ctx.signal)
      } catch {
        return { kind: 'unknown', code: 'TIMEOUT', message: 'Test fiscal POS did not answer in time (scenario slow)' }
      }
      return ok({ state: 'filed', result: testFiscalResult(ctx, p) })
    case 'ok':
    default:
      return ok({ state: 'filed', result: testFiscalResult(ctx, p) })
  }
}

export const testFiscalDriver: FiscalDriver = {
  id: 'test',
  label: 'Test (built in — files TEST numbers, never a real invoice)',
  needs: { baseUrl: false, apiKey: false, webhookSecret: false },
  capabilities: () => ({ refunds: true, zeroValue: true, lookup: true }),
  async submitSale(ctx, p) {
    testDriverCalls.submitSale++
    return submit(ctx, p)
  },
  async submitRefund(ctx, p) {
    testDriverCalls.submitRefund++
    return submit(ctx, p)
  },
  async getDocumentStatus(ctx, ref): Promise<Outcome<FiscalLookupValue>> {
    testDriverCalls.getDocumentStatus++
    const s = fiscalScenario(ctx)
    if (s === 'down') return { kind: 'transient', code: 'TEST_DOWN', message: 'Test fiscal POS is down (scenario down)' }
    if (s === 'auth') return { kind: 'rejected', code: 'AUTH', message: 'Test fiscal POS refused the API key (scenario auth)', httpStatus: 401 }
    if (s === 'reject') return ok({ state: 'not_found' })
    // The vendor is idempotent: a lookup returns the number a submit would.
    // A stateless driver needs the document's authority and time to rebuild
    // that number, so it reads servd's own frozen payload (the outbox row of
    // this company) — never any stored vendor result.
    const doc = await prisma.fiscalDocument.findFirst({
      where: { id: ref.documentId, tenantId: ctx.tenantId },
      select: { payload: true },
    })
    const p = doc ? payloadFields(doc.payload) : null
    if (!p) return ok({ state: 'not_found' })
    return ok({ state: 'filed', result: testFiscalResult(ctx, { ...p, documentId: ref.documentId }) })
  },
  async health(ctx) {
    testDriverCalls.fiscalHealth++
    if (fiscalScenario(ctx) === 'down') return { kind: 'transient', code: 'TEST_DOWN', message: 'Test fiscal POS is down (scenario down)' }
    if (fiscalScenario(ctx) === 'auth') return { kind: 'rejected', code: 'AUTH', message: 'Test fiscal POS refused the API key (scenario auth)', httpStatus: 401 }
    return ok({ latencyMs: 1, detail: `test driver (scenario ${fiscalScenario(ctx)})` })
  },
}

// ─── Terminal ─────────────────────────────────────────────────────────────────

type TerminalScenario = NonNullable<TerminalSettings['test']>['scenario']
type Effective = Exclude<TerminalScenario, 'by_amount'>

const APPROVE_AFTER_MS = 1500

function terminalScenario(ctx: ConnectorCtx, amountCents?: number): Effective {
  const s = (ctx.settings as TerminalSettings).test?.scenario ?? 'approve'
  if (s !== 'by_amount') return s
  const last2 = Math.abs(amountCents ?? 0) % 100
  if (last2 <= 49) return 'approve'
  switch (last2) {
    case 51: return 'decline'
    case 52: return 'never'
    case 53: return 'unknown_start'
    case 54: return 'late_approve'
    case 55: return 'void_fails'
    case 56: return 'offline'
    default: return 'approve'
  }
}

export function testApproval(chargeId: string, amountCents: number): Extract<ChargeState, { state: 'approved' }> {
  const h = sha256Hex(chargeId)
  return {
    state: 'approved',
    providerRef: `T-${chargeId}`,
    approvalRef: `TST${h.slice(0, 8).toUpperCase()}`,
    authCode: String(parseInt(h.slice(8, 16), 16) % 1_000_000).padStart(6, '0'),
    cardBrand: 'TESTCARD',
    last4: '4242',
    amountCents,
  }
}

function elapsedMs(ctx: ConnectorCtx, r: ChargeRequest): number {
  return ctx.now().getTime() - new Date(r.startedAt).getTime()
}

function statusOf(ctx: ConnectorCtx, r: ChargeRequest): ChargeState {
  if (r.kind === 'refund') return testApproval(r.chargeId, r.amountCents)
  const s = terminalScenario(ctx, r.amountCents)
  const done = elapsedMs(ctx, r) >= APPROVE_AFTER_MS
  switch (s) {
    case 'never': return { state: 'awaiting_card' }
    case 'decline': return done ? { state: 'declined', reason: 'TEST_DECLINED' } : { state: 'awaiting_card' }
    case 'offline': return { state: 'not_found' }
    default: return done ? testApproval(r.chargeId, r.amountCents) : { state: 'awaiting_card' }
  }
}

export const testTerminalDriver: TerminalDriver = {
  id: 'test',
  label: 'Test card machine (built in — no money moves)',
  needs: { baseUrl: false, apiKey: false, webhookSecret: false },
  capabilities: () => ({ cancel: true, void: true, referencedRefund: true, webhooks: true }),
  async startCharge(ctx, r) {
    testDriverCalls.startCharge++
    const s = terminalScenario(ctx, r.amountCents)
    if (s === 'offline') return { kind: 'transient', code: 'TERMINAL_UNREACHABLE', message: 'Test card machine is offline (scenario offline)' }
    if (s === 'unknown_start') return { kind: 'unknown', code: 'TEST_UNKNOWN', message: 'No answer after the charge was sent (scenario unknown_start)' }
    return ok({ providerRef: `T-${r.chargeId}` })
  },
  async getChargeStatus(ctx, r) {
    testDriverCalls.getChargeStatus++
    if (terminalScenario(ctx, r.amountCents) === 'offline' && r.kind === 'charge') {
      return { kind: 'transient', code: 'TERMINAL_UNREACHABLE', message: 'Test card machine is offline (scenario offline)' }
    }
    return ok(statusOf(ctx, r))
  },
  async cancelCharge(ctx, r) {
    testDriverCalls.cancelCharge++
    const s = terminalScenario(ctx, r.amountCents)
    if (s === 'offline') return { kind: 'transient', code: 'TERMINAL_UNREACHABLE', message: 'Test card machine is offline (scenario offline)' }
    if (s === 'never') return ok({ state: 'expired' })
    if (s === 'late_approve') return ok(testApproval(r.chargeId, r.amountCents))
    if (s === 'decline') return ok(elapsedMs(ctx, r) >= APPROVE_AFTER_MS ? { state: 'declined', reason: 'TEST_DECLINED' } : { state: 'cancelled' })
    return ok(elapsedMs(ctx, r) < APPROVE_AFTER_MS ? { state: 'cancelled' } : testApproval(r.chargeId, r.amountCents))
  },
  async voidCharge(ctx, r) {
    testDriverCalls.voidCharge++
    if (terminalScenario(ctx, r.amountCents) === 'void_fails') return { kind: 'transient', code: 'TEST_VOID_FAILED', message: 'Test card machine could not void (scenario void_fails)' }
    return ok({ voided: true as const })
  },
  async refund(ctx, r) {
    testDriverCalls.refund++
    const s = terminalScenario(ctx, r.original ? undefined : r.amountCents)
    if (s === 'void_fails') return { kind: 'transient', code: 'TEST_REFUND_FAILED', message: 'Test card machine could not refund (scenario void_fails)' }
    return ok({ providerRef: `T-${r.chargeId}` })
  },
  async health(ctx) {
    testDriverCalls.terminalHealth++
    const s = (ctx.settings as TerminalSettings).test?.scenario ?? 'approve'
    return ok({ online: s !== 'offline', latencyMs: 1 })
  },
}
