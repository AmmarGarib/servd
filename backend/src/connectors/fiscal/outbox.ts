// The fiscal outbox (spec §6.2–§6.6, D4, D5, D7, §17.0, §17.7).
//
// One FiscalDocument per sale (inserted inside completeOrder's claim
// transaction — completion is the full & final bill, exactly once per order)
// and one per refund / void (inserted inside refundOrder's transaction with
// the negative Payment). NOTHING else enqueues fiscal work; a pre-bill never
// does (§17.1).
//
// Sending is single-flight through a DB lease (UPDATE … RETURNING), retries
// and backoff live in the row (nextAttemptAt), BullMQ is only a fast path and
// a Redis-independent sweeper re-drives anything due. An "unknown" outcome
// (the vendor MAY have filed) is always followed by a LOOKUP before any
// resubmit, so a document is filed exactly once even when a process dies
// mid-HTTP.
//
// Statuses: held (connector off / not live / not registered — visible, never
// auto-sent), waiting (refund waiting for its sale), pending, submitting,
// filed, rejected, failed, skipped (AUTOMATIC ONLY — never an operator choice,
// §17.0), manual_required, manual_filed.

import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { Prisma, type FiscalDocument, type FiscalDocStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { getFiscalQueue } from '../../lib/queue.js'
import { getIOSafe } from '../../lib/ws.js'
import type { ConnectorCtx, FiscalAuthority, FiscalDriver, FiscalPayload, FiscalResult, FiscalSettings, Outcome } from '../types.js'
import { fiscalDriverOf, getConnectorFresh, buildCtx, connectorNow, ensureConnectorRow, type LoadedConnector } from '../registry.js'
import { parseFiscalSettings, reportingRequiredOf, reportingRequiredSinceOf, saleFileable } from '../config.js'
import { isTestTenant } from '../../lib/testCompany.js'
import { nextDelayMs, scrubMessage, withTimeout } from '../util.js'
import { alertFiscalAuth, alertFiscalDocument, notifyConnectorPeople } from '../alerts.js'
import { buildFiscalSaleTx, buildRefundPayload, payloadHash, totalsCheck, type RefundOriginal, type TotalsCheck, type VoidReturnSplit } from './payload.js'
import { FISCAL_VIEW_SELECT, toFiscalView, type FiscalView } from './view.js'
import { voidSplitOf } from '../../modules/accounting/orderPosting.js'

type Tx = Prisma.TransactionClient
export type FiscalVia = 'sync_till' | 'worker' | 'sweeper' | 'manual_retry' | 'webhook'

const LEASE_MS = 60_000
const MAX_ATTEMPTS = 60
const AUTH_BACKOFF_FLOOR_MS = 5 * 60_000
const PROCESSING_DEFAULT_MS = 30_000

/** A fresh document id (doubles as the vendor idempotency key). */
export function newDocumentId(): string {
  return `fd${Date.now().toString(36)}${randomBytes(8).toString('hex')}`
}

const leaseOwner = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`

function asPayload(v: Prisma.JsonValue): FiscalPayload {
  return v as unknown as FiscalPayload
}

function toJson(p: FiscalPayload): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(p)) as Prisma.InputJsonValue
}

/** The fiscal settings + switch read inside a transaction (no cache). */
async function fiscalConnectorTx(tx: Tx, tenantId: string) {
  const row = await tx.posConnector.findUnique({ where: { tenantId_kind: { tenantId, kind: 'fiscal' } } })
  return {
    row,
    settings: parseFiscalSettings(row?.settings ?? {}),
    required: row ? reportingRequiredOf(row.settings) : true,
    live: !!row && row.enabled && row.driver !== 'none' && !!fiscalDriverOf(row.driver),
    driver: row ? fiscalDriverOf(row.driver) : null,
  }
}

/**
 * Does this order's sale go to the fiscal POS at all (fr-2)? Reporting is
 * required, the company is not a test company, and the sale was completed
 * after reporting became required (config.ts saleFileable) — a test
 * company's past sales are never filed once test mode is turned off.
 */
async function saleFileableTx(tx: Tx, conn: { row: { settings: Prisma.JsonValue } | null; required: boolean }, tenantId: string, orderId: string): Promise<boolean> {
  if (!conn.required) return false
  const isTest = await isTestTenant(tenantId, tx)
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { completedAt: true } })
  return saleFileable(conn.row?.settings ?? {}, { hasRow: !!conn.row, isTest, completedAt: order?.completedAt ?? null })
}

/** Insert once on (tenantId, idempotencyKey) without aborting the caller's transaction on a race. */
async function insertOnceTx(tx: Tx, data: Prisma.FiscalDocumentCreateManyInput): Promise<FiscalDocument> {
  await tx.fiscalDocument.createMany({ data: [data], skipDuplicates: true })
  return tx.fiscalDocument.findUniqueOrThrow({
    where: { tenantId_idempotencyKey: { tenantId: data.tenantId, idempotencyKey: data.idempotencyKey } },
  })
}

// ─── Totals that do not add up (ONL-R2-02) ───────────────────────────────────
//
// A document whose figures fail totalsCheck (lines + tax + service + tip +
// delivery ≠ the bill) is NEVER filed: it is stored 'failed' with reason
// 'totals_mismatch' and raises a fiscal_failed exception in the company's
// Inbox. It stays visible, counts in /health, and can be retried (a sale never
// sent is rebuilt from the order) or recorded as filed by hand.

export const TOTALS_MISMATCH = 'totals_mismatch'

/**
 * Till flow (owner, 2026-10-20): a bill CLOSED IN SERVD (Order.settlementChannel
 * 'servd') is filed BY HAND on the SRB / FBR portal (daily / weekly / monthly —
 * owner confirmed). Its sale document — and every return of that sale — is
 * 'manual_required' with this reason: never sent to the fiscal POS (not at
 * enqueue, not by a retry, not by a release, not by the sender — sendOnce turns
 * it back), never skipped. Finance records the portal filing with
 * recordManualFiling (Finance → Servd sales to file, accounting/servdFilings.ts),
 * and the month close blocks while any stays unfiled (close check
 * 'servd_sales_unfiled').
 */
export const SERVD_CHANNEL = 'servd_channel'

/** Is this order's bill closed in servd (filed by hand)? */
async function servdChannelTx(db: Tx | typeof prisma, orderId: string): Promise<boolean> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { settlementChannel: true } })
  return o?.settlementChannel === 'servd'
}

function mismatchText(orderRef: string, check: TotalsCheck, inDoubt = false, kind: FiscalDocument['kind'] = 'sale'): string {
  if (inDoubt) {
    // F-RV-2: an earlier submit's outcome is unknown — the vendor MAY have it.
    // A row is only left in doubt when this fiscal POS has no lookup (a POS
    // that can be asked is asked before the totals gate), so Retry cannot ask
    // it either: the vendor is asked outside servd.
    return `Order ${orderRef}: the fiscal document's figures do not add up (${check.problems.join('; ')}), so it was not sent again. An earlier submit's outcome is UNKNOWN — the fiscal POS may already have filed it. Do NOT file it on the authority portal yet. servd cannot ask this fiscal POS about it automatically: ask the fiscal POS vendor (outside servd) whether they have it; if they do, record the filing by hand with their fiscal number; only if they confirm they never got it, file it on the authority portal and record that.`
  }
  if (kind === 'refund') {
    // A refund is never rebuilt from the order (retryMismatch): Retry re-checks the same frozen figures.
    return `Order ${orderRef}: the fiscal document's figures do not add up (${check.problems.join('; ')}). It was NOT sent to the fiscal POS. A refund is not rebuilt from the order — Retry only re-checks the stored figures. File it on the authority portal and record it there.`
  }
  return `Order ${orderRef}: the fiscal document's figures do not add up (${check.problems.join('; ')}). It was NOT sent to the fiscal POS. Check the order's stored figures, then Retry it in Dev → API → POS connector → Submissions, or file it on the authority portal and record it there.`
}

/**
 * The vendor MAY already hold this document: an earlier submit's outcome was
 * unknown (timeout, lease expired), it answered "processing", or it gave us a
 * reference. Such a document is looked up before any resubmit, and its
 * payload is never rebuilt until the vendor says it does not have it.
 */
function mayExistAtVendor(doc: Pick<FiscalDocument, 'lastErrorCode' | 'providerRef'>): boolean {
  return (doc.lastErrorCode?.startsWith('UNKNOWN') ?? false) || doc.lastErrorCode === 'PROCESSING' || !!doc.providerRef
}

/** The fiscal_failed flag for a totals mismatch, inside the caller's transaction (the flag and the document stand or fall together). */
async function flagMismatchTx(tx: Tx, doc: { id: string; tenantId: string; conceptId: string; amountCents: number; kind: FiscalDocument['kind'] }, orderRef: string, check: TotalsCheck): Promise<void> {
  await tx.exceptionFlag.create({
    data: {
      tenantId: doc.tenantId,
      kind: 'fiscal_failed',
      severity: 'high',
      title: 'Fiscal document not sent: totals do not add up',
      description: mismatchText(orderRef, check, false, doc.kind),
      entityType: 'FiscalDocument',
      entityId: doc.id,
      conceptId: doc.conceptId,
      amountCents: doc.amountCents,
    },
  })
  console.error(`[fiscal] document ${doc.id} (order ${orderRef}) held back as ${TOTALS_MISMATCH}: ${check.problems.join('; ')}`)
}

// ─── Enqueue: sale ────────────────────────────────────────────────────────────

export interface EnqueuedDoc {
  id: string
  status: FiscalDocStatus
  statusReason: string | null
  /** False when the document already existed (idempotent replay). */
  created: boolean
}

/**
 * Called INSIDE completeOrder's claim transaction, right after the
 * 'order.complete' audit row. Idempotent on (tenantId, 'sale:'+orderId).
 * Returns null when the company does not report sales at all (§17.7).
 */
export async function enqueueFiscalSaleTx(tx: Tx, input: { orderId: string; tenantId: string }): Promise<EnqueuedDoc | null> {
  const key = `sale:${input.orderId}`
  const existing = await tx.fiscalDocument.findUnique({
    where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: key } },
    select: { id: true, status: true, statusReason: true },
  })
  if (existing) return { ...existing, created: false }

  const conn = await fiscalConnectorTx(tx, input.tenantId)
  if (!(await saleFileableTx(tx, conn, input.tenantId, input.orderId))) return null

  const id = newDocumentId()
  const built = await buildFiscalSaleTx(tx, input.orderId, id, conn.settings)
  let status: FiscalDocStatus
  let reason: string | null = null
  if (built.legacy.fbrInvoiceNumber || built.legacy.srbInvoiceNumber) { status = 'skipped'; reason = 'prefiled_direct' }
  // Never filed, never auto-skipped: figures that do not add up are an exception (ONL-R2-02).
  else if (!built.check.ok) { status = 'failed'; reason = TOTALS_MISMATCH }
  // Zero-value = the BILL is zero (a wallet- or gift-card-paid sale is not, ONL-R2-02).
  else if (built.totalCents === 0 && !conn.settings.fileZeroValue) { status = 'skipped'; reason = 'zero_value' }
  // Closed in servd: filed by hand on the portal — never sent (till flow, 2026-10-20).
  else if (built.settlementChannel === 'servd') { status = 'manual_required'; reason = SERVD_CHANNEL }
  else if (!conn.live) { status = 'held'; reason = 'no_connector' }
  else if (built.registrations.length === 0) { status = 'held'; reason = 'not_registered' }
  else if (built.totalCents === 0 && !capsOf(conn.driver, conn.row).zeroValue) { status = 'skipped'; reason = 'zero_value_unsupported' }
  else { status = 'pending' }

  const row = await insertOnceTx(tx, {
    id,
    tenantId: input.tenantId,
    kind: 'sale',
    orderId: input.orderId,
    conceptId: built.conceptId,
    locationId: built.locationId,
    idempotencyKey: key,
    status,
    statusReason: reason,
    payload: toJson(built.payload),
    payloadHash: built.hash,
    amountCents: built.totalCents,
    nextAttemptAt: connectorNow(),
    ...(reason === TOTALS_MISMATCH && { alertedAt: connectorNow(), lastErrorCode: 'TOTALS_MISMATCH', lastError: built.check.problems.join('; ').slice(0, 500) }),
  })
  if (row.id === id && reason === TOTALS_MISMATCH) await flagMismatchTx(tx, row, built.payload.orderRef, built.check)
  return { id: row.id, status: row.status, statusReason: row.statusReason, created: row.id === id }
}

function capsOf(driver: FiscalDriver | null, row: { tenantId: string; id: string; driver: string; settings: Prisma.JsonValue } | null) {
  if (!driver || !row) return { refunds: false, zeroValue: false, lookup: false }
  try {
    const ctx: ConnectorCtx = {
      tenantId: row.tenantId, connectorId: row.id, driver: row.driver, isTest: row.driver === 'test',
      baseUrl: null, apiKey: null, webhookSecret: null, settings: parseFiscalSettings(row.settings),
      signal: AbortSignal.timeout(1000), now: connectorNow, log: () => {},
    }
    return driver.capabilities(ctx)
  } catch {
    return { refunds: false, zeroValue: false, lookup: false }
  }
}

// ─── Enqueue: refund / void ───────────────────────────────────────────────────

function originalOf(sale: Pick<FiscalDocument, 'id' | 'fiscalNumber' | 'authority' | 'fiscalAt'>): RefundOriginal | null {
  if (!sale.fiscalNumber) return null
  return {
    documentId: sale.id,
    fiscalNumber: sale.fiscalNumber,
    ...(sale.authority && { authority: sale.authority }),
    ...(sale.fiscalAt && { issuedAt: sale.fiscalAt.toISOString() }),
  }
}

/**
 * Called INSIDE refundOrder's transaction (with the negative Payment), or with
 * refundPaymentId null from the order-status path ('void:<orderId>').
 * Idempotent on the key. Returns null only when the company does not report
 * sales (§17.7) and the order has no sale document.
 */
export async function enqueueFiscalRefundTx(tx: Tx, input: {
  orderId: string
  tenantId: string
  refundPaymentId: string | null
  amountCents: number
  reason?: string
  /**
   * How the money went back: cash / card / raast (Raast QR, sent back by bank
   * transfer) / keenu_qr (an old sale refunded the way it was paid); omitted,
   * it defaults from the sale (payload.ts buildRefundPayload).
   */
  method?: string | null
  /** The refund's tip share when known (0 for a voided line's refund — W4-FISCAL-1); omitted → pro rata. */
  tipShareCents?: number
  /** A TILL-R3 void's exact split (orderPosting voidSplitOf + the voided line) — payload.ts buildRefundPayload. */
  voidSplit?: VoidReturnSplit
}): Promise<EnqueuedDoc | null> {
  const key = input.refundPaymentId ? `refund:${input.refundPaymentId}` : `void:${input.orderId}`
  const existing = await tx.fiscalDocument.findUnique({
    where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: key } },
    select: { id: true, status: true, statusReason: true },
  })
  if (existing) return { ...existing, created: false }

  const sale = await tx.fiscalDocument.findUnique({
    where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: `sale:${input.orderId}` } },
  })
  const conn = await fiscalConnectorTx(tx, input.tenantId)
  // No sale document and the sale is not one that files (reporting off, a
  // test company, or completed before reporting became required — fr-2):
  // its return files nothing either.
  if (!sale && !(await saleFileableTx(tx, conn, input.tenantId, input.orderId))) return null

  const id = newDocumentId()
  const now = connectorNow()
  let status: FiscalDocStatus
  let reason: string | null = null
  let salePayload: FiscalPayload
  let original: RefundOriginal | null = null
  let conceptId: string
  let locationId: string | null

  if (sale) {
    salePayload = asPayload(sale.payload)
    conceptId = sale.conceptId
    locationId = sale.locationId
    if (sale.status === 'filed' || sale.status === 'manual_filed') {
      status = 'pending'
      original = originalOf(sale)
    } else if (sale.status === 'skipped') {
      if (sale.statusReason === 'prefiled_direct') {
        // Owner flag (e): the sale was filed directly with SRB / FBR before
        // the cutover — its return has to be filed by hand against that number.
        status = 'manual_required'; reason = 'prefiled_direct_refund'
        const o = await tx.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { srbInvoiceNumber: true, fbrInvoiceNumber: true } })
        original = o.srbInvoiceNumber ? { fiscalNumber: o.srbInvoiceNumber, authority: 'srb' } : o.fbrInvoiceNumber ? { fiscalNumber: o.fbrInvoiceNumber, authority: 'fbr' } : null
      } else {
        status = 'skipped'; reason = sale.statusReason
      }
    } else {
      // held / pending / submitting / waiting / failed / rejected / manual_required:
      // the return files once its sale has a fiscal number.
      status = 'waiting'
    }
  } else {
    const built = await buildFiscalSaleTx(tx, input.orderId, `${id}-sale`, conn.settings)
    salePayload = built.payload
    conceptId = built.conceptId
    locationId = built.locationId
    if (built.legacy.srbInvoiceNumber || built.legacy.fbrInvoiceNumber) {
      status = 'manual_required'; reason = 'prefiled_direct_refund'
      original = built.legacy.srbInvoiceNumber
        ? { fiscalNumber: built.legacy.srbInvoiceNumber, authority: 'srb' }
        : { fiscalNumber: built.legacy.fbrInvoiceNumber!, authority: 'fbr' }
    } else {
      // Automatic, never an operator choice: there is no filed sale to return against.
      status = 'skipped'; reason = 'no_sale_document'
      console.info(`[fiscal] refund ${key} on order ${input.orderId}: no sale document — skipped (no_sale_document)`)
    }
  }

  // A return of a sale closed in servd is filed by hand too (till flow,
  // 2026-10-20) — whatever its sale's state, never sent to the fiscal POS.
  if ((status === 'pending' || status === 'waiting') && (sale?.statusReason === SERVD_CHANNEL || await servdChannelTx(tx, input.orderId))) {
    status = 'manual_required'; reason = SERVD_CHANNEL
  }

  const payload = buildRefundPayload(salePayload, {
    documentId: id,
    refundAmountCents: input.amountCents,
    issuedAt: now,
    reason: input.reason,
    method: input.method ?? null,
    original,
    ...(input.tipShareCents !== undefined && { tipShareCents: input.tipShareCents }),
    ...(input.voidSplit && { voidSplit: input.voidSplit }),
  })
  // The same totals rule as the sale: a return that does not add up is never filed.
  const check = totalsCheck(payload)
  if (!check.ok && (status === 'pending' || status === 'waiting' || reason === SERVD_CHANNEL)) { status = 'failed'; reason = TOTALS_MISMATCH }
  const row = await insertOnceTx(tx, {
    id,
    tenantId: input.tenantId,
    kind: 'refund',
    orderId: input.orderId,
    conceptId,
    locationId,
    idempotencyKey: key,
    saleDocumentId: sale?.id ?? null,
    refundPaymentId: input.refundPaymentId,
    status,
    statusReason: reason,
    payload: toJson(payload),
    payloadHash: payloadHash(payload),
    amountCents: payload.refundAmountCents ?? input.amountCents,
    nextAttemptAt: now,
    ...(((status === 'manual_required' && reason !== SERVD_CHANNEL) || reason === TOTALS_MISMATCH) && { alertedAt: now }),
    ...(reason === TOTALS_MISMATCH && { lastErrorCode: 'TOTALS_MISMATCH', lastError: check.problems.join('; ').slice(0, 500) }),
  })
  if (row.id === id && reason === TOTALS_MISMATCH) await flagMismatchTx(tx, row, payload.orderRef, check)
  // (A servd-channel return is the close check's business, not an exception flag.)
  if (row.id === id && status === 'manual_required' && reason !== SERVD_CHANNEL) {
    // Inside the refund's transaction, so the flag and the document stand or fall together.
    await tx.exceptionFlag.create({
      data: {
        tenantId: input.tenantId,
        kind: 'fiscal_manual_refund',
        severity: 'medium',
        title: 'Refund must be filed by hand',
        description: `This sale was filed directly with ${original?.authority?.toUpperCase() ?? 'the authority'} before the POS connector (invoice ${original?.fiscalNumber ?? '-'}). File the return of PKR ${(row.amountCents / 100).toFixed(2)} on the authority portal, then record it in Dev → API → POS connector → Submissions.`,
        entityType: 'FiscalDocument',
        entityId: row.id,
        conceptId,
        amountCents: row.amountCents,
      },
    })
  }
  return { id: row.id, status: row.status, statusReason: row.statusReason, created: row.id === id }
}

// ─── Fast path ────────────────────────────────────────────────────────────────

type Kicker = (documentId: string, attempts: number) => Promise<void>

const defaultKicker: Kicker = async (documentId, attempts) => {
  const q = getFiscalQueue()
  if (!q) throw new Error('fiscal queue unavailable')
  // The shared Redis client never rejects while Redis is down (BullMQ needs
  // maxRetriesPerRequest: null), so bound the add — the sweeper covers it.
  // W1-R2: a finished job is removed at once. BullMQ silently ignores an add
  // whose jobId still exists, and `attempts` can go DOWN (connector off →
  // held, connector read failed → pending), so a kept job would swallow every
  // later kick for the same slot. A job still waiting dedupes concurrent kicks;
  // the DB lease is the real single-flight guarantee.
  await withTimeout(q.add('send', { documentId }, {
    jobId: `fiscal-${documentId}-${attempts}`,
    removeOnComplete: true,
    removeOnFail: true,
  }), 2000, 'fiscal queue add')
}

let kicker: Kicker = defaultKicker

/** Tests only: replace the BullMQ add (null restores it). */
export function setFiscalKicker(fn: Kicker | null): void {
  kicker = fn ?? defaultKicker
}

/** Queue a send through BullMQ. Never throws; false when the queue is unreachable (the sweeper re-drives it). */
export async function kickFiscal(documentId: string, attempts?: number): Promise<boolean> {
  try {
    const n = attempts ?? (await prisma.fiscalDocument.findUnique({ where: { id: documentId }, select: { attempts: true } }))?.attempts ?? 0
    await kicker(documentId, n)
    return true
  } catch (err) {
    console.warn(`[fiscal] kick ${documentId} failed (sweeper will send it):`, (err as Error).message)
    return false
  }
}

/** Raw kick that throws, for the sweeper's inline fallback. */
async function kickOrThrow(documentId: string, attempts: number): Promise<void> {
  await kicker(documentId, attempts)
}

/**
 * The till's bounded synchronous attempt (D10). Always resolves to a view
 * (or null when the document does not exist); never throws.
 */
export async function submitFiscalNow(documentId: string, opts: { budgetMs?: number; via?: FiscalVia } = {}): Promise<FiscalView | null> {
  const budgetMs = Math.max(500, Math.min(5000, opts.budgetMs ?? 3000))
  try {
    return await withTimeout(sendFiscalDocument(documentId, opts.via ?? 'sync_till', budgetMs), budgetMs + 1500, 'fiscal sync')
  } catch (err) {
    console.warn(`[fiscal] sync attempt for ${documentId} did not finish:`, (err as Error).message)
    try { return await viewOf(documentId) } catch { return null }
  }
}

/**
 * The till's after-commit step in one call (spec §6.3): when the company's
 * settings say syncAtTill, a bounded attempt within syncTimeoutMs; otherwise
 * a kick. Only a `pending` document is sent; anything else just returns its
 * view (held / skipped / …). Never throws.
 */
export async function submitFiscalAtTill(documentId: string): Promise<FiscalView | null> {
  try {
    const doc = await prisma.fiscalDocument.findUnique({ where: { id: documentId }, select: { tenantId: true, status: true, attempts: true } })
    if (!doc) return null
    if (doc.status !== 'pending') return viewOf(documentId)
    const conn = await getConnectorFresh(doc.tenantId, 'fiscal')
    if (!conn.fiscalSettings.syncAtTill) {
      void kickFiscal(documentId, doc.attempts)
      return viewOf(documentId)
    }
    return submitFiscalNow(documentId, { budgetMs: conn.fiscalSettings.syncTimeoutMs, via: 'sync_till' })
  } catch (err) {
    console.warn(`[fiscal] till attempt for ${documentId} failed:`, (err as Error).message)
    try { return await viewOf(documentId) } catch { return null }
  }
}

async function viewOf(documentId: string, staff = true): Promise<FiscalView | null> {
  const row = await prisma.fiscalDocument.findUnique({ where: { id: documentId }, select: FISCAL_VIEW_SELECT })
  return row ? toFiscalView(row, { staff }) : null
}

// ─── Send ─────────────────────────────────────────────────────────────────────

async function logAttempt(doc: Pick<FiscalDocument, 'id' | 'tenantId' | 'attempts'>, op: 'submit' | 'lookup', outcome: string, via: FiscalVia, t0: number, extra: { httpStatus?: number; errorCode?: string; message?: string } = {}) {
  try {
    await prisma.fiscalAttempt.create({
      data: {
        tenantId: doc.tenantId,
        documentId: doc.id,
        attemptNo: doc.attempts,
        op,
        outcome,
        httpStatus: extra.httpStatus ?? null,
        errorCode: extra.errorCode?.slice(0, 64) ?? null,
        message: extra.message ? scrubMessage(extra.message) : null,
        durationMs: Math.max(0, Date.now() - t0),
        via,
      },
    })
  } catch (err) {
    console.warn('[fiscal] attempt log failed:', (err as Error).message)
  }
}

/**
 * When this document's retry clock started: its first submit/lookup after the
 * latest manual retry. Held documents released late therefore get their full
 * maxAgeHours from release, not from the sale.
 */
async function retryClock(documentId: string): Promise<{ anchor: Date | null; attemptsAtRetry: number }> {
  const retry = await prisma.fiscalAttempt.findFirst({ where: { documentId, op: 'retry' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, attemptNo: true } })
  const first = await prisma.fiscalAttempt.findFirst({
    where: { documentId, op: { in: ['submit', 'lookup'] }, ...(retry && { createdAt: { gte: retry.createdAt } }) },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  })
  return { anchor: first?.createdAt ?? null, attemptsAtRetry: retry?.attemptNo ?? 0 }
}

/**
 * Out of attempts or past maxAgeHours — both measured since the latest manual
 * retry (W1-R8), so "Retry" after a long outage gives a document a full new
 * run, not one shot.
 */
async function isExhausted(doc: Pick<FiscalDocument, 'id' | 'attempts'>, settings: FiscalSettings, now: Date): Promise<boolean> {
  const { anchor, attemptsAtRetry } = await retryClock(doc.id)
  if (doc.attempts - attemptsAtRetry >= MAX_ATTEMPTS) return true
  return !!anchor && now.getTime() - anchor.getTime() > settings.maxAgeHours * 3_600_000
}

/** Only the lease holder may move a submitting row. */
async function updateLeased(doc: Pick<FiscalDocument, 'id'>, data: Prisma.FiscalDocumentUpdateManyMutationInput): Promise<boolean> {
  const r = await prisma.fiscalDocument.updateMany({
    where: { id: doc.id, status: 'submitting', leaseOwner },
    data: { ...data, leaseUntil: null, leaseOwner: null },
  })
  return r.count > 0
}

async function markFailed(doc: FiscalDocument, why: string): Promise<void> {
  await alertFiscalDocument(doc, 'fiscal_failed', 'high',
    'Sale not filed with the fiscal POS',
    `Order ${asPayload(doc.payload).orderRef ?? doc.orderId}: gave up after ${doc.attempts} attempts (${why}). Check the fiscal POS, then Retry it in Dev → API → POS connector → Submissions.`)
}

/** Apply a filed result (from a submit, a lookup or a webhook) — the row must currently be in `from`. */
async function applyFiled(doc: FiscalDocument, result: FiscalResult, isTest: boolean, driverId: string, guard: 'lease' | FiscalDocStatus[]): Promise<boolean> {
  const fiscalAt = Number.isFinite(Date.parse(result.fiscalAt)) ? new Date(result.fiscalAt) : connectorNow()
  const data: Prisma.FiscalDocumentUpdateManyMutationInput = {
    status: 'filed',
    statusReason: null,
    fiscalNumber: result.fiscalNumber,
    authority: result.authority,
    qrPayload: result.qrPayload ?? null,
    verifyUrl: result.verifyUrl ?? null,
    providerRef: result.providerRef ?? doc.providerRef,
    extraNumbers: result.extraNumbers ? (JSON.parse(JSON.stringify(result.extraNumbers)) as Prisma.InputJsonValue) : Prisma.DbNull,
    fiscalAt,
    filedAt: connectorNow(),
    isTest,
    driver: driverId,
    lastErrorCode: null,
    lastError: null,
  }
  const ok = guard === 'lease'
    ? await updateLeased(doc, data)
    : (await prisma.fiscalDocument.updateMany({ where: { id: doc.id, tenantId: doc.tenantId, status: { in: guard } }, data: { ...data, leaseUntil: null, leaseOwner: null } })).count > 0
  if (!ok) return false
  await afterFiled(doc)
  return true
}

async function afterFiled(doc: Pick<FiscalDocument, 'id' | 'tenantId' | 'orderId' | 'kind'>): Promise<void> {
  try {
    await prisma.posConnector.updateMany({ where: { tenantId: doc.tenantId, kind: 'fiscal' }, data: { lastOkAt: connectorNow() } })
  } catch { /* status only */ }
  if (doc.kind === 'sale') await promoteWaitingRefunds(doc.id, doc.tenantId)
  const io = getIOSafe()
  try { io?.to(`tenant:${doc.tenantId}:orders`).emit('fiscal.filed', { orderId: doc.orderId, documentId: doc.id }) } catch { /* best effort */ }
}

/**
 * How a refund row's return document is built when the row gave back a line
 * voided on a paid, still-open order (pos/service voidOrderItem, TILL-R3): no
 * tip share, and its exact split on its own line when the row stores one
 * (voidRefundShape). {} for any other refund.
 */
async function voidRefundShapeOf(refundPaymentId: string | null): Promise<{ tipShareCents?: number; voidSplit?: VoidReturnSplit }> {
  if (!refundPaymentId) return {}
  const p = await prisma.payment.findUnique({ where: { id: refundPaymentId }, select: { amountCents: true, gatewayMeta: true } })
  return p ? voidRefundShape(p) : {}
}

/** The return-document shape of one refund row (see voidRefundShapeOf). Pure. */
export function voidRefundShape(p: { amountCents: number; gatewayMeta?: unknown }): { tipShareCents?: number; voidSplit?: VoidReturnSplit } {
  const meta = p.gatewayMeta as { refund?: { voidedItemId?: unknown } } | null | undefined
  const voidedItemId = meta?.refund?.voidedItemId
  if (typeof voidedItemId !== 'string') return {}
  const split = voidSplitOf(p)
  return { tipShareCents: 0, ...(split && { voidSplit: { ...split, lineId: voidedItemId } }) }
}

/**
 * A sale is filed (or manually filed): its waiting refunds get the original
 * fiscal number in their (never-sent) payload and become due.
 */
export async function promoteWaitingRefunds(saleDocumentId: string, tenantId: string): Promise<number> {
  const sale = await prisma.fiscalDocument.findFirst({ where: { id: saleDocumentId, tenantId } })
  if (!sale || (sale.status !== 'filed' && sale.status !== 'manual_filed')) return 0
  const waiting = await prisma.fiscalDocument.findMany({ where: { tenantId, saleDocumentId, status: 'waiting' }, take: 500 })
  let n = 0
  for (const r of waiting) {
    const original = originalOf(sale)
    const payload = asPayload(r.payload)
    // W1-R4: a refund never sent yet is rebuilt from the sale AS FILED — a
    // held sale's payload is rebuilt on release (POS ids added, seller fixed),
    // and the credit note must carry the same registrations and seller. The
    // refund keeps its own time, amount, reason and tender.
    const next: FiscalPayload = r.attempts === 0
      ? buildRefundPayload(asPayload(sale.payload), {
        documentId: r.id,
        refundAmountCents: payload.refundAmountCents ?? r.amountCents,
        issuedAt: Number.isFinite(Date.parse(payload.issuedAt)) ? new Date(payload.issuedAt) : r.createdAt,
        reason: payload.reason,
        method: payload.payment?.tenders?.[0]?.method ?? null,
        original: original ?? payload.original ?? null,
        // A voided line's refund holds no tip (W4-FISCAL-1), and goes back
        // on its own line with its exact split when the row stores one.
        ...(await voidRefundShapeOf(r.refundPaymentId)),
      })
      : payload
    const check = totalsCheck(next)
    if (!check.ok) {
      // Never filed with figures that do not add up (ONL-R2-02).
      const failed = await prisma.fiscalDocument.updateMany({
        where: { id: r.id, status: 'waiting' },
        data: {
          status: 'failed', statusReason: TOTALS_MISMATCH, lastErrorCode: 'TOTALS_MISMATCH', lastError: check.problems.join('; ').slice(0, 500),
          payload: toJson(next), payloadHash: payloadHash(next), amountCents: next.refundAmountCents ?? r.amountCents,
        },
      })
      if (failed.count > 0) await alertFiscalDocument(r, 'fiscal_failed', 'high', 'Fiscal document not sent: totals do not add up', mismatchText(next.orderRef ?? r.orderId, check, false, r.kind))
      continue
    }
    const moved = await prisma.fiscalDocument.updateMany({
      where: { id: r.id, status: 'waiting' },
      data: {
        status: 'pending', statusReason: null, nextAttemptAt: connectorNow(), payload: toJson(next), payloadHash: payloadHash(next),
        amountCents: next.refundAmountCents ?? r.amountCents,
      },
    })
    if (moved.count > 0) { n++; void kickFiscal(r.id, r.attempts) }
  }
  return n
}

type SendResult = 'filed' | 'pending' | 'rejected' | 'failed' | 'held' | 'busy'

/**
 * THE send. The sync till path, the worker, the sweeper and manual retry all
 * call it. Returns the document's view after the attempt (null if it does
 * not exist).
 */
export async function sendFiscalDocument(documentId: string, via: FiscalVia, budgetMs: number): Promise<FiscalView | null> {
  await sendOnce(documentId, via, budgetMs)
  return viewOf(documentId)
}

export async function sendOnce(documentId: string, via: FiscalVia, budgetMs: number): Promise<SendResult> {
  const now = connectorNow()
  const leaseUntil = new Date(now.getTime() + LEASE_MS)
  // 1. Lease — single flight. Zero rows: busy, final or not due.
  const leased = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE fiscal_documents
       SET status = 'submitting', "leaseUntil" = ${leaseUntil}, "leaseOwner" = ${leaseOwner},
           attempts = attempts + 1, "updatedAt" = ${now}
     WHERE id = ${documentId} AND status = 'pending' AND "nextAttemptAt" <= ${now}
     RETURNING id`
  if (leased.length === 0) return 'busy'
  const doc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })

  // Till flow (2026-10-20): a document of a bill closed in servd is NEVER sent —
  // whatever moved it to pending (a retry, a rebuild, a release), it goes back to
  // 'manual_required' / servd_channel for finance to record the portal filing.
  if (await servdChannelTx(prisma, doc.orderId)) {
    await updateLeased(doc, { status: 'manual_required', statusReason: SERVD_CHANNEL, attempts: { decrement: 1 } })
    return 'held'
  }

  // 2. The connector of THIS document's company, read fresh.
  let conn: LoadedConnector
  try {
    conn = await getConnectorFresh(doc.tenantId, 'fiscal')
  } catch (err) {
    await updateLeased(doc, { status: 'pending', attempts: { decrement: 1 }, nextAttemptAt: new Date(now.getTime() + 60_000), lastError: scrubMessage(err) })
    return 'pending'
  }
  const driver = fiscalDriverOf(conn.row.driver)
  if (!conn.row.enabled || !driver) {
    // Switched off (or no driver): back to the visible backlog, never sent.
    await updateLeased(doc, { status: 'held', statusReason: 'no_connector', attempts: { decrement: 1 } })
    return 'held'
  }
  const settings = conn.fiscalSettings
  const isTest = driver.id === 'test'

  if (conn.secretError) {
    return applyFailure(doc, conn, settings, { kind: 'rejected', code: 'AUTH', message: `Stored API key cannot be read: ${conn.secretError}` }, via, now)
  }

  const caps = (() => { try { return driver.capabilities(buildCtx(conn, budgetMs)) } catch { return { refunds: true, zeroValue: true, lookup: false } } })()
  const payload = asPayload(doc.payload)

  if (doc.kind === 'refund' && !caps.refunds) {
    // This fiscal POS cannot file credit notes: a person files it on the portal.
    await updateLeased(doc, { status: 'manual_required', statusReason: 'refunds_unsupported', attempts: { decrement: 1 } })
    await alertFiscalDocument(doc, 'fiscal_manual_refund', 'medium', 'Refund must be filed by hand',
      `The fiscal POS cannot file refunds. File the return of PKR ${(doc.amountCents / 100).toFixed(2)} (order ${payload.orderRef ?? doc.orderId}) on the authority portal, then record it in Dev → API → POS connector → Submissions.`)
    return 'held'
  }

  // 3. Lookup first when the vendor may already have it.
  const mayExist = mayExistAtVendor(doc)
  let confirmedAbsent = false
  if (mayExist && caps.lookup) {
    const t0 = Date.now()
    let lk: Awaited<ReturnType<FiscalDriver['getDocumentStatus']>>
    try {
      lk = await withTimeout(driver.getDocumentStatus(buildCtx(conn, budgetMs), { documentId: doc.id, ...(doc.providerRef && { providerRef: doc.providerRef }) }), budgetMs + 250, 'fiscal lookup')
    } catch (err) {
      lk = { kind: 'transient', code: 'LOOKUP_TIMEOUT', message: scrubMessage(err) }
    }
    if (lk.kind === 'ok') {
      await logAttempt(doc, 'lookup', lk.value.state, via, t0)
      if (lk.value.state === 'filed') {
        return (await applyFiled(doc, lk.value.result, isTest, driver.id, 'lease')) ? 'filed' : 'busy'
      }
      if (lk.value.state === 'processing') {
        await updateLeased(doc, { status: 'pending', lastErrorCode: 'PROCESSING', nextAttemptAt: new Date(now.getTime() + Math.max(lk.value.retryAfterMs ?? PROCESSING_DEFAULT_MS, 1000)) })
        return 'pending'
      }
      // not_found → the vendor never got it: submit below.
      confirmedAbsent = true
    } else {
      await logAttempt(doc, 'lookup', lk.kind, via, t0, { httpStatus: 'httpStatus' in lk ? lk.httpStatus : undefined, errorCode: lk.code, message: lk.message })
      // Never resubmit blind: a lookup that failed is a retry later (keeping
      // the UNKNOWN / PROCESSING marker so the next attempt looks up again).
      if (lk.kind === 'rejected' && lk.code === 'AUTH') return applyFailure(doc, conn, settings, lk, via, now, { keepCode: true })
      return applyFailure(doc, conn, settings, { kind: 'transient', code: lk.code, message: lk.message }, via, now, { keepCode: true })
    }
  }

  // The last gate before the vendor (ONL-R2-02): a payload whose totals do not
  // add up is never submitted or resubmitted — e.g. one frozen before the
  // totals fix. It guards only an actual (re)submit (F-RV-2): a document the
  // vendor may already hold was looked up above, and the lookup's answer
  // wins. When it could not be looked up (this fiscal POS has no lookup), the
  // UNKNOWN / PROCESSING marker is kept, the alert never says "not sent", and
  // it tells the operator to ask the vendor outside servd — Retry cannot.
  // (A vendor webhook can still report it filed: applyFiled accepts a failed
  // row.)
  const check = totalsCheck(payload)
  if (!check.ok) {
    const inDoubt = mayExist && !confirmedAbsent
    await updateLeased(doc, {
      status: 'failed', statusReason: TOTALS_MISMATCH, attempts: { decrement: 1 },
      lastErrorCode: inDoubt ? doc.lastErrorCode : 'TOTALS_MISMATCH',
      lastError: `${inDoubt ? 'TOTALS_MISMATCH (an earlier submit\'s outcome is unknown): ' : ''}${check.problems.join('; ')}`.slice(0, 500),
    })
    await alertFiscalDocument(doc, 'fiscal_failed', 'high',
      inDoubt ? 'Fiscal document in doubt: totals do not add up' : 'Fiscal document not sent: totals do not add up',
      mismatchText(payload.orderRef ?? doc.orderId, check, inDoubt, doc.kind))
    return 'failed'
  }

  // 4. Submit the frozen payload.
  const t0 = Date.now()
  let out: Outcome<{ state: 'filed'; result: FiscalResult } | { state: 'processing'; providerRef?: string; retryAfterMs?: number }>
  try {
    const ctx = buildCtx(conn, budgetMs)
    const call = doc.kind === 'refund' ? driver.submitRefund(ctx, payload) : driver.submitSale(ctx, payload)
    out = await withTimeout(call, budgetMs + 250, 'fiscal submit')
  } catch (err) {
    out = { kind: 'unknown', code: 'TIMEOUT', message: scrubMessage(err) }
  }

  // 5. Apply.
  if (out.kind === 'ok') {
    await logAttempt(doc, 'submit', out.value.state, via, t0)
    if (out.value.state === 'filed') {
      return (await applyFiled(doc, out.value.result, isTest, driver.id, 'lease')) ? 'filed' : 'busy'
    }
    await updateLeased(doc, {
      status: 'pending',
      lastErrorCode: 'PROCESSING',
      lastError: null,
      driver: driver.id,
      ...(out.value.providerRef && { providerRef: out.value.providerRef }),
      nextAttemptAt: new Date(now.getTime() + Math.max(out.value.retryAfterMs ?? PROCESSING_DEFAULT_MS, 1000)),
    })
    return 'pending'
  }
  await logAttempt(doc, 'submit', out.kind, via, t0, { httpStatus: 'httpStatus' in out ? out.httpStatus : undefined, errorCode: out.code, message: out.message })
  return applyFailure(doc, conn, settings, out, via, now)
}

async function applyFailure(
  doc: FiscalDocument,
  conn: LoadedConnector,
  settings: FiscalSettings,
  out: Exclude<Outcome<unknown>, { kind: 'ok' }>,
  _via: FiscalVia,
  now: Date,
  opts: { keepCode?: boolean } = {},
): Promise<SendResult> {
  const message = scrubMessage(out.message)
  if (out.kind === 'rejected' && out.code !== 'AUTH') {
    await updateLeased(doc, { status: 'rejected', lastErrorCode: out.code.slice(0, 64), lastError: message, driver: conn.row.driver })
    await alertFiscalDocument(doc, 'fiscal_rejected', 'high',
      'Fiscal POS rejected a document',
      `Order ${asPayload(doc.payload).orderRef ?? doc.orderId} was rejected (${out.code}: ${message}). Fix the cause (POS ids, item data), then Retry it in Dev → API → POS connector → Submissions.`)
    return 'rejected'
  }
  if (await isExhausted(doc, settings, now)) {
    await updateLeased(doc, { status: 'failed', lastErrorCode: opts.keepCode ? doc.lastErrorCode : out.code.slice(0, 64), lastError: message })
    await markFailed(doc, message)
    return 'failed'
  }
  const isAuth = out.kind === 'rejected' && out.code === 'AUTH'
  const delay = nextDelayMs(doc.attempts, {
    retryAfterMs: out.kind === 'transient' ? out.retryAfterMs : undefined,
    floorMs: isAuth ? AUTH_BACKOFF_FLOOR_MS : 0,
  })
  const code = opts.keepCode && doc.lastErrorCode
    ? doc.lastErrorCode
    : out.kind === 'unknown' ? `UNKNOWN_${out.code}`.slice(0, 64) : out.code.slice(0, 64)
  await updateLeased(doc, { status: 'pending', lastErrorCode: code, lastError: message, nextAttemptAt: new Date(now.getTime() + delay), driver: conn.row.driver })
  if (isAuth) {
    try {
      await prisma.posConnector.update({ where: { id: conn.row.id }, data: { lastError: `AUTH: ${message}`, lastErrorAt: now } })
    } catch { /* status only */ }
    await alertFiscalAuth(doc.tenantId, conn.row.id, message, now)
  }
  return 'pending'
}

// ─── Inbound webhook (fiscal.document.updated) ────────────────────────────────

export async function applyFiscalWebhook(
  tenantId: string,
  documentId: string,
  value: { state: 'filed'; result: FiscalResult } | { state: 'processing'; retryAfterMs?: number } | { state: 'not_found' } | { state: 'rejected'; code: string; message: string },
): Promise<'applied' | 'ignored'> {
  // Looked up WITH the connector's company: another company's id is ignored.
  const doc = await prisma.fiscalDocument.findFirst({ where: { id: documentId, tenantId } })
  if (!doc) return 'ignored'
  const t0 = Date.now()
  const conn = await getConnectorFresh(tenantId, 'fiscal')
  if (value.state === 'filed') {
    const ok = await applyFiled(doc, value.result, conn.row.driver === 'test', conn.row.driver, ['pending', 'submitting', 'failed', 'rejected'])
    await logAttempt(doc, 'lookup', 'filed', 'webhook', t0)
    return ok ? 'applied' : 'ignored'
  }
  if (value.state === 'rejected') {
    const r = await prisma.fiscalDocument.updateMany({
      where: { id: doc.id, tenantId, status: { in: ['pending', 'submitting'] } },
      data: { status: 'rejected', lastErrorCode: value.code.slice(0, 64), lastError: scrubMessage(value.message), leaseUntil: null, leaseOwner: null },
    })
    await logAttempt(doc, 'lookup', 'rejected', 'webhook', t0, { errorCode: value.code, message: value.message })
    if (r.count > 0) {
      await alertFiscalDocument(doc, 'fiscal_rejected', 'high', 'Fiscal POS rejected a document',
        `Order ${asPayload(doc.payload).orderRef ?? doc.orderId} was rejected (${value.code}). Fix the cause, then Retry it in Dev → API → POS connector → Submissions.`)
    }
    return r.count > 0 ? 'applied' : 'ignored'
  }
  await logAttempt(doc, 'lookup', value.state, 'webhook', t0)
  return 'ignored'
}

// ─── Operator actions (no skip — §17.0) ───────────────────────────────────────

/**
 * F-RV-2: ask the fiscal POS whether it holds a document whose earlier submit
 * is in doubt, before Retry rebuilds it. 'filed' has already been applied.
 */
async function lookupBeforeRebuild(doc: FiscalDocument): Promise<{ state: 'filed' | 'not_found' } | { state: 'unresolved'; why: string }> {
  let conn: LoadedConnector
  try {
    conn = await getConnectorFresh(doc.tenantId, 'fiscal')
  } catch (err) {
    return { state: 'unresolved', why: `the connector could not be read (${scrubMessage(err)})` }
  }
  const driver = fiscalDriverOf(conn.row.driver)
  if (!conn.row.enabled || !driver) return { state: 'unresolved', why: 'the fiscal POS is switched off' }
  if (conn.secretError) return { state: 'unresolved', why: 'the stored API key cannot be read' }
  const budgetMs = 5000
  const caps = (() => { try { return driver.capabilities(buildCtx(conn, budgetMs)) } catch { return { refunds: true, zeroValue: true, lookup: false } } })()
  if (!caps.lookup) return { state: 'unresolved', why: 'this fiscal POS cannot be asked about a document' }
  const t0 = Date.now()
  let lk: Awaited<ReturnType<FiscalDriver['getDocumentStatus']>>
  try {
    lk = await withTimeout(driver.getDocumentStatus(buildCtx(conn, budgetMs), { documentId: doc.id, ...(doc.providerRef && { providerRef: doc.providerRef }) }), budgetMs + 250, 'fiscal lookup')
  } catch (err) {
    lk = { kind: 'transient', code: 'LOOKUP_TIMEOUT', message: scrubMessage(err) }
  }
  if (lk.kind !== 'ok') {
    await logAttempt(doc, 'lookup', lk.kind, 'manual_retry', t0, { httpStatus: 'httpStatus' in lk ? lk.httpStatus : undefined, errorCode: lk.code, message: lk.message })
    return { state: 'unresolved', why: `the fiscal POS did not answer (${lk.code})` }
  }
  await logAttempt(doc, 'lookup', lk.value.state, 'manual_retry', t0)
  if (lk.value.state === 'filed') {
    await applyFiled(doc, lk.value.result, driver.id === 'test', driver.id, ['failed'])
    return { state: 'filed' }
  }
  if (lk.value.state === 'processing') return { state: 'unresolved', why: 'the fiscal POS is still processing it' }
  return { state: 'not_found' }
}

/**
 * A document held back because its totals did not add up (ONL-R2-02), on
 * Retry: a sale the fiscal POS does not hold is rebuilt from the order as it
 * is now — one never submitted, one whose earlier attempts failed outright,
 * or (F-RV-2) one in doubt that a lookup shows the vendor never got (a lookup
 * that shows it filed records the filing instead). Anything else is
 * re-checked as stored. Still wrong → 409 TOTALS_MISMATCH (fix the order, or
 * file it by hand and record it); in doubt and unresolved → 409
 * FISCAL_IN_DOUBT. Right → back on its normal path: pending when the fiscal
 * POS is live and the sale registered, else held; a refund whose sale is not
 * filed yet waits for it.
 */
async function retryMismatch(doc: FiscalDocument): Promise<FiscalDocument> {
  const now = connectorNow()
  let rebuild = doc.kind === 'sale' && !mayExistAtVendor(doc)
  if (doc.kind === 'sale' && !rebuild) {
    const lk = await lookupBeforeRebuild(doc)
    if (lk.state === 'filed') return prisma.fiscalDocument.findUniqueOrThrow({ where: { id: doc.id } })
    if (lk.state === 'unresolved') {
      throw new AppError('FISCAL_IN_DOUBT', `This sale may already be at the fiscal POS (an earlier submit's outcome is unknown) and it cannot be rebuilt until the fiscal POS confirms it does not have it: ${lk.why}. Try again later; if the fiscal POS confirms it never got it, file it on the authority portal and record it.`, 409)
    }
    rebuild = true
  }
  await prisma.$transaction(async (tx) => {
    const cur = await tx.fiscalDocument.findFirst({ where: { id: doc.id, tenantId: doc.tenantId, status: 'failed', statusReason: TOTALS_MISMATCH } })
    if (!cur) throw new AppError('NOT_RETRYABLE', 'This document has moved on — reload it', 409)
    const conn = await fiscalConnectorTx(tx, cur.tenantId)
    let payload = asPayload(cur.payload)
    let total = cur.amountCents
    if (cur.kind === 'sale' && rebuild) {
      const built = await buildFiscalSaleTx(tx, cur.orderId, cur.id, conn.settings)
      payload = built.payload
      total = built.totalCents
    }
    const check = totalsCheck(payload)
    if (!check.ok) {
      // An in-doubt refund is never looked up (only a sale is, above): say it is
      // in doubt, so nobody files a credit note the fiscal POS may already hold.
      // (The prefix stays "The figures still do not add up: " — the admin's
      // connectorErrorText reads the problems after it.)
      if (cur.kind === 'refund' && mayExistAtVendor(cur)) {
        throw new AppError('TOTALS_MISMATCH', `The figures still do not add up: ${check.problems.join('; ')}. An earlier submit's outcome is unknown, so the fiscal POS may already have it — confirm with the fiscal POS vendor (outside servd) before filing it by hand.`, 409)
      }
      throw new AppError('TOTALS_MISMATCH', `The figures still do not add up: ${check.problems.join('; ')}`, 409)
    }
    let status: FiscalDocStatus = 'pending'
    let reason: string | null = null
    if (await servdChannelTx(tx, cur.orderId)) { status = 'manual_required'; reason = SERVD_CHANNEL }
    else if (cur.kind === 'refund') {
      const sale = cur.saleDocumentId ? await tx.fiscalDocument.findFirst({ where: { id: cur.saleDocumentId, tenantId: cur.tenantId }, select: { status: true } }) : null
      if (sale && sale.status !== 'filed' && sale.status !== 'manual_filed') status = 'waiting'
    } else if (!conn.live) { status = 'held'; reason = 'no_connector' }
    else if ((payload.registrations ?? []).length === 0) { status = 'held'; reason = 'not_registered' }
    await tx.fiscalDocument.update({
      where: { id: cur.id },
      data: {
        status, statusReason: reason, payload: toJson(payload), payloadHash: payloadHash(payload), amountCents: total,
        nextAttemptAt: now, alertedAt: null, lastErrorCode: null, lastError: null,
      },
    })
    await tx.fiscalAttempt.create({
      data: { tenantId: cur.tenantId, documentId: cur.id, attemptNo: cur.attempts, op: 'retry', outcome: 'queued', durationMs: 0, via: 'manual_retry' },
    })
  }, { maxWait: 10_000, timeout: 15_000 })
  const after = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: doc.id } })
  if (after.status === 'pending') void kickFiscal(after.id, after.attempts)
  return after
}

/** Retry one document: failed / rejected / pending-not-leased → pending now. */
export async function retryDocument(documentId: string, tenantWhere: { tenantId: string } | { tenantId: { in: string[] } }): Promise<FiscalDocument> {
  const doc = await prisma.fiscalDocument.findFirst({ where: { id: documentId, ...tenantWhere } })
  if (!doc) throw new NotFoundError('Fiscal document', documentId)
  if (doc.status === 'failed' && doc.statusReason === TOTALS_MISMATCH) return retryMismatch(doc)
  const now = connectorNow()
  const r = await prisma.fiscalDocument.updateMany({
    where: {
      id: doc.id,
      OR: [
        { status: { in: ['failed', 'rejected'] } },
        { status: 'pending', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      ],
    },
    data: { status: 'pending', nextAttemptAt: now, alertedAt: null },
  })
  if (r.count === 0) throw new AppError('NOT_RETRYABLE', `This document is ${doc.status} — only failed, rejected or waiting-to-retry documents can be retried`, 409)
  await prisma.fiscalAttempt.create({
    data: { tenantId: doc.tenantId, documentId: doc.id, attemptNo: doc.attempts, op: 'retry', outcome: 'queued', durationMs: 0, via: 'manual_retry' },
  })
  void kickFiscal(doc.id, doc.attempts)
  return prisma.fiscalDocument.findUniqueOrThrow({ where: { id: doc.id } })
}

/** Retry every failed / rejected document of ONE company (max 500). */
export async function retryFailedForTenant(tenantId: string): Promise<number> {
  const rows = await prisma.fiscalDocument.findMany({ where: { tenantId, status: { in: ['failed', 'rejected'] } }, select: { id: true }, take: 500, orderBy: { createdAt: 'asc' } })
  let n = 0
  for (const r of rows) {
    try { await retryDocument(r.id, { tenantId }); n++ } catch { /* moved meanwhile */ }
  }
  return n
}

export const MANUAL_FILABLE: FiscalDocStatus[] = ['held', 'waiting', 'pending', 'failed', 'rejected', 'manual_required']

/** Record an out-of-band filing (the operator filed it on the authority portal). */
export async function recordManualFiling(documentId: string, tenantWhere: { tenantId: string } | { tenantId: { in: string[] } }, input: {
  fiscalNumber: string; authority: FiscalAuthority; qrPayload?: string | null; verifyUrl?: string | null; actorId: string
  /** When it was filed on the portal (till flow: finance files servd sales daily / weekly / monthly). Default now. */
  filedOn?: Date | null
  /** statusReason after the filing. Default 'operator'; servd-channel filings say 'servd_portal'. */
  reason?: string
}): Promise<FiscalDocument> {
  const doc = await prisma.fiscalDocument.findFirst({ where: { id: documentId, ...tenantWhere } })
  if (!doc) throw new NotFoundError('Fiscal document', documentId)
  const now = connectorNow()
  const filedOn = input.filedOn ?? now
  const r = await prisma.fiscalDocument.updateMany({
    where: {
      id: doc.id,
      OR: [
        { status: { in: MANUAL_FILABLE.filter((s) => s !== 'pending') } },
        { status: 'pending', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      ],
    },
    data: {
      status: 'manual_filed', statusReason: input.reason ?? 'operator', driver: 'manual',
      fiscalNumber: input.fiscalNumber.trim(), authority: input.authority,
      qrPayload: input.qrPayload ?? null, verifyUrl: input.verifyUrl ?? null,
      fiscalAt: filedOn, filedAt: now, isTest: false, resolvedById: input.actorId,
      lastErrorCode: null, leaseUntil: null, leaseOwner: null,
    },
  })
  if (r.count === 0) throw new AppError('NOT_MANUALLY_FILABLE', `This document is ${doc.status} — it cannot be recorded as filed by hand`, 409)
  await afterFiled(doc)
  return prisma.fiscalDocument.findUniqueOrThrow({ where: { id: doc.id } })
}

/**
 * Release the company's HELD documents (all of them, or one brand's) into the
 * queue: payload rebuilt (registrations may have been fixed), → pending.
 * Rows still unregistered stay held. Never by date range, never skipped
 * (§17.0). Requires the connector to be live.
 */
export async function releaseHeld(tenantId: string, opts: { conceptId?: string | null; limit?: number } = {}): Promise<{ released: number; stillHeld: number }> {
  const conn = await getConnectorFresh(tenantId, 'fiscal')
  const driver = fiscalDriverOf(conn.row.driver)
  if (!conn.row.enabled || !driver) throw new AppError('NOT_LIVE', 'Go live with the fiscal POS before releasing held sales', 409)
  // BOOKS-R2-02: a company the CEO marked "Fiscal reporting required: OFF"
  // files nothing. Its held sales are kept as they are (never skipped) and
  // release as usual once reporting is switched back on.
  if (!reportingRequiredOf(conn.row.settings)) {
    throw new AppError('REPORTING_OFF', 'Fiscal reporting is switched off for this company. Its held sales are kept; switch "Fiscal reporting required" back on to release them.', 409)
  }
  const caps = capsOf(driver, conn.row)
  const rows = await prisma.fiscalDocument.findMany({
    where: { tenantId, status: 'held', ...(opts.conceptId && { conceptId: opts.conceptId }) },
    orderBy: { createdAt: 'asc' },
    take: Math.min(opts.limit ?? 5000, 5000),
    select: { id: true, kind: true, attempts: true },
  })
  let released = 0
  const now = connectorNow()
  // fr-2 belt and braces: a sale document created AFTER reporting became
  // required for an order completed BEFORE it can only have come from a
  // retroactive path (a test company's past sale) — it stays held, never
  // filed. Held documents created while the company was reporting are real
  // sales and release as usual.
  const since = reportingRequiredSinceOf(conn.row.settings)
  for (const r of rows) {
    const moved = await prisma.$transaction(async (tx) => {
      const doc = await tx.fiscalDocument.findFirst({ where: { id: r.id, tenantId, status: 'held' } })
      if (!doc) return false
      if (since && doc.kind === 'sale' && doc.createdAt >= since) {
        const o = await tx.order.findUnique({ where: { id: doc.orderId }, select: { completedAt: true } })
        if (o?.completedAt && o.completedAt < since) return false
      }
      let payload = asPayload(doc.payload)
      let total = doc.amountCents
      let registrations = payload.registrations ?? []
      if (doc.kind === 'sale' && doc.attempts === 0) {
        // Rebuilt from the order as it is now — a sale held before the totals
        // fix (ONL-R2-02) goes out with the bill, the delivery fee and its
        // wallet / gift-card / COD tenders.
        const built = await buildFiscalSaleTx(tx, doc.orderId, doc.id, conn.fiscalSettings)
        payload = built.payload
        total = built.totalCents
        registrations = built.registrations
      }
      const check = totalsCheck(payload)
      if (!check.ok) {
        await tx.fiscalDocument.update({
          where: { id: doc.id },
          data: {
            payload: toJson(payload), payloadHash: payloadHash(payload), amountCents: total,
            status: 'failed', statusReason: TOTALS_MISMATCH, alertedAt: now,
            lastErrorCode: 'TOTALS_MISMATCH', lastError: check.problems.join('; ').slice(0, 500),
          },
        })
        await flagMismatchTx(tx, { ...doc, amountCents: total }, payload.orderRef ?? doc.orderId, check)
        return false
      }
      const unregistered = registrations.length === 0
      const zeroUnsupported = total === 0 && !caps.zeroValue
      await tx.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          payload: toJson(payload),
          payloadHash: payloadHash(payload),
          amountCents: total,
          ...(unregistered
            ? { statusReason: 'not_registered' }
            : zeroUnsupported
              ? { status: 'skipped', statusReason: 'zero_value_unsupported' }
              : { status: 'pending', statusReason: null, nextAttemptAt: now }),
        },
      })
      return !unregistered && !zeroUnsupported
    })
    if (moved) { released++; void kickFiscal(r.id, r.attempts) }
  }
  const stillHeld = await prisma.fiscalDocument.count({ where: { tenantId, status: 'held', ...(opts.conceptId && { conceptId: opts.conceptId }) } })
  return { released, stillHeld }
}

// ─── Sweeper (worker; Redis-independent) ──────────────────────────────────────

export interface SweepStats { leasesFreed: number; promoted: number; kicked: number; sentInline: number; failed: number }

export async function sweepFiscal(opts: { perTenant?: number } = {}): Promise<SweepStats> {
  const now = connectorNow()
  const stats: SweepStats = { leasesFreed: 0, promoted: 0, kicked: 0, sentInline: 0, failed: 0 }

  // (a) expired leases → pending, look up before any resubmit.
  const freed = await prisma.fiscalDocument.updateMany({
    where: { status: 'submitting', leaseUntil: { lt: now } },
    data: { status: 'pending', lastErrorCode: 'UNKNOWN_LEASE_EXPIRED', leaseUntil: null, leaseOwner: null, nextAttemptAt: now },
  })
  stats.leasesFreed = freed.count

  // (b) waiting refunds whose sale is filed.
  const waiting = await prisma.fiscalDocument.findMany({
    where: { status: 'waiting', saleDocumentId: { not: null } },
    select: { saleDocumentId: true, tenantId: true },
    distinct: ['saleDocumentId'],
    take: 500,
  })
  for (const w of waiting) stats.promoted += await promoteWaitingRefunds(w.saleDocumentId!, w.tenantId)

  // (c) due pending rows, per company.
  const tenants = await prisma.fiscalDocument.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: now } },
    select: { tenantId: true },
    distinct: ['tenantId'],
  })
  for (const { tenantId } of tenants) {
    const due = await prisma.fiscalDocument.findMany({
      where: { tenantId, status: 'pending', nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      take: opts.perTenant ?? 200,
      select: { id: true, attempts: true },
    })
    let queueDown = false
    for (const d of due) {
      if (!queueDown) {
        try { await kickOrThrow(d.id, d.attempts); stats.kicked++; continue } catch { queueDown = true }
      }
      // Redis down: send inline, one at a time.
      await sendOnce(d.id, 'sweeper', 15_000)
      stats.sentInline++
    }
  }

  // (d) pending rows past their age → failed.
  const aged = await prisma.fiscalDocument.findMany({
    // Only rows that could be past their age (maxAgeHours ≥ 1) or out of attempts.
    where: { status: 'pending', attempts: { gt: 0 }, OR: [{ attempts: { gte: MAX_ATTEMPTS } }, { createdAt: { lt: new Date(now.getTime() - 3_600_000) } }] },
    orderBy: { updatedAt: 'asc' },
    take: 200,
  })
  const settingsByTenant = new Map<string, FiscalSettings>()
  for (const doc of aged) {
    let s = settingsByTenant.get(doc.tenantId)
    if (!s) { s = parseFiscalSettings((await ensureConnectorRow(doc.tenantId, 'fiscal')).settings); settingsByTenant.set(doc.tenantId, s) }
    if (!(await isExhausted(doc, s, now))) continue
    const r = await prisma.fiscalDocument.updateMany({ where: { id: doc.id, status: 'pending' }, data: { status: 'failed' } })
    if (r.count > 0) { stats.failed++; await markFailed(doc, 'too old to keep retrying') }
  }

  // (e) digest per company: sales not filed for 15+ minutes.
  await digestAlerts(now)
  return stats
}

const digestMemory = new Map<string, number>()

async function digestAlerts(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 15 * 60_000)
  const groups = await prisma.fiscalDocument.groupBy({
    by: ['tenantId'],
    where: { status: { in: ['pending', 'submitting'] }, createdAt: { lt: cutoff } },
    _count: { _all: true },
    _min: { createdAt: true },
  })
  for (const g of groups) {
    if (!(await claimDigest(g.tenantId, now))) continue
    const mins = g._min.createdAt ? Math.round((now.getTime() - g._min.createdAt.getTime()) / 60_000) : 15
    void notifyConnectorPeople(g.tenantId, 'fiscal',
      `servd: ${g._count._all} sales not filed for ${mins} min — fiscal POS unreachable; nothing lost, retrying.`)
  }
}

async function claimDigest(tenantId: string, now: Date): Promise<boolean> {
  try {
    const { redisFast } = await import('../../lib/redis.js')
    const r = await withTimeout(redisFast.set(`fiscal:digest:${tenantId}`, '1', 'EX', 900, 'NX'), 1000, 'digest claim')
    return r === 'OK'
  } catch {
    const last = digestMemory.get(tenantId) ?? 0
    if (now.getTime() - last < 15 * 60_000) return false
    digestMemory.set(tenantId, now.getTime())
    return true
  }
}

// ─── Counts (routes + /health) ────────────────────────────────────────────────

export interface FiscalCounts {
  held: number; waiting: number; pending: number; submittingStale: number; failed: number; rejected: number
  manualRequired: number; filedToday: number; oldestPendingAt: string | null
}

export async function fiscalCounts(tenantIds: string[], now: Date = connectorNow()): Promise<FiscalCounts> {
  const where = { tenantId: { in: tenantIds } }
  const grouped = await prisma.fiscalDocument.groupBy({ by: ['status'], where, _count: { _all: true } })
  const c = (s: FiscalDocStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0
  const dayStart = new Date(`${new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)}T00:00:00+05:00`)
  const [submittingStale, filedToday, oldest] = await Promise.all([
    prisma.fiscalDocument.count({ where: { ...where, status: 'submitting', leaseUntil: { lt: now } } }),
    prisma.fiscalDocument.count({ where: { ...where, status: { in: ['filed', 'manual_filed'] }, filedAt: { gte: dayStart } } }),
    prisma.fiscalDocument.findFirst({ where: { ...where, status: { in: ['pending', 'submitting'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ])
  return {
    held: c('held'), waiting: c('waiting'), pending: c('pending') + c('submitting'), submittingStale,
    failed: c('failed'), rejected: c('rejected'), manualRequired: c('manual_required'), filedToday,
    oldestPendingAt: oldest?.createdAt.toISOString() ?? null,
  }
}
