// Raast QR — matching bank credits to bills (spec §6.4–6.5, amendments M2,
// M3, M4, S1, S6).
//
// A BankCredit (from a bank SMS today, a bank API later) either CONFIRMS a
// Raast receipt the cashier already recorded (same reference), SETTLES the one
// awaiting intent it can only belong to, or is left for a person
// ('unmatched' / 'ambiguous' / 'needs_attention'). It never guesses: a
// settle needs EXACTLY one candidate.
//
// Concurrency (M2/M3). Every Raast write path takes lockRaastTx (the ONE
// per-company advisory lock) first, in its own SHORT transaction. Settling an
// intent from an SMS is three steps, never one long transaction:
//   1. claim  — under the lock: find the one candidate, lease it
//              (RaastReceipt.settlingUntil + smsAlertId), the alert stays
//              'processing'; commit.
//   2. pay    — processPayment / settlePayment (their own transactions, which
//              take lockRaastTx themselves and accept the lease held by THIS
//              alert), then completion, fiscal filing, loyalty.
//   3. finish — under the lock: re-read the receipt (a cashier may have paid
//              it meanwhile) and write the outcome with conditional updates
//              only (needs_attention only from 'awaiting').
//
// Reference claims (M4). An SMS reference can confirm a receipt only when the
// SMS is a CREDIT, still in an open status, on the receipt's OWN bank account,
// and no older than the receipt minus matchWindowMin. A reference a manager
// dismissed as "not a sale" (or a debit's reference) is claimed in
// BankSmsAlert.claimedRef and can never pay a bill (409 RAAST_REF_DISMISSED).

import { Prisma, type BankSmsAlert, type BankSmsAlertStatus, type RaastReceipt, type RaastReceiptStatus, type ExceptionSeverity } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { emitTill } from '../../lib/ws.js'
import { toCents } from '../../lib/money.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { assertShiftOf } from '../../lib/tenantScope.js'
import { processPayment, settlePayment, type ProcessPaymentInput, type SettleInput } from '../../modules/pos/service.js'
import type { BankCredit, RaastSettings } from '../types.js'
import { parseRaastSettings } from '../config.js'
import { connectorNow } from '../registry.js'
import { notifyConnectorPeople, type ConnectorAudience, type ConnectorExceptionKind } from '../alerts.js'
import { scrubMessage } from '../util.js'
import { lockRaastTx } from './lock.js'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

/** A bank credit and a bill agree when they differ by at most 2 paisa. */
export const RAAST_TOLERANCE_CENTS = 2
/** How long an SMS holds an intent while it pays it (longer than processPayment's own budget). */
export const SETTLE_LEASE_MS = 90_000
/** After this many failed (non-refusal) attempts an alert goes to a person. */
export const MAX_ALERT_ATTEMPTS = 5

const TX_OPTS = { maxWait: 10_000, timeout: 15_000 } as const

/** Alert statuses whose reference may still be used (M4). */
export const OPEN_ALERT_STATUSES: BankSmsAlertStatus[] = ['received', 'processing', 'unmatched', 'ambiguous', 'off', 'needs_attention']
/** Receipts that recorded a payment (money booked as a sale). */
export const PAID_RECEIPT_STATUSES: RaastReceiptStatus[] = ['provisional', 'matched', 'unreceived']
/** Receipts with no payment: an SMS link on them may be moved. */
const UNPAID_RECEIPT_STATUSES: RaastReceiptStatus[] = ['awaiting', 'cancelled', 'needs_attention']

const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const within = (a: number, b: number) => Math.abs(a - b) <= RAAST_TOLERANCE_CENTS

// ─── The company's raast connector ───────────────────────────────────────────

export interface RaastConnectorState {
  connectorId: string | null
  enabled: boolean
  settings: RaastSettings
}

/** The raast connector row read inside `db` (no lazy create, no cache). Missing → off with defaults. */
export async function raastConnectorTx(db: Db, tenantId: string): Promise<RaastConnectorState> {
  const row = await db.posConnector.findUnique({ where: { tenantId_kind: { tenantId, kind: 'raast' } }, select: { id: true, enabled: true, settings: true } })
  return { connectorId: row?.id ?? null, enabled: !!row?.enabled, settings: parseRaastSettings(row?.settings ?? {}) }
}

// ─── Flags ───────────────────────────────────────────────────────────────────

export interface RaastFlagInput {
  tenantId: string
  kind: ConnectorExceptionKind
  severity: ExceptionSeverity
  title: string
  description: string
  entityType: 'RaastReceipt' | 'BankSmsAlert' | 'BankAccount' | 'PosConnector'
  entityId: string
  conceptId?: string | null
  amountCents?: number | null
  metadata?: Record<string, string | number | boolean | null>
}

/**
 * Raise (or refresh) ONE open flag of `kind` for the entity. An open or
 * acknowledged flag of the same kind and entity is refreshed in place
 * (description, metadata, amount) instead of raising a second one.
 */
export async function raiseRaastFlagTx(db: Db, input: RaastFlagInput): Promise<{ id: string; created: boolean }> {
  const open = await db.exceptionFlag.findFirst({
    where: { tenantId: input.tenantId, kind: input.kind, entityType: input.entityType, entityId: input.entityId, status: { in: ['open', 'acknowledged'] } },
    select: { id: true },
  })
  const data = {
    severity: input.severity,
    title: input.title.slice(0, 200),
    description: input.description.slice(0, 2000),
    conceptId: input.conceptId ?? null,
    amountCents: input.amountCents ?? null,
    ...(input.metadata && { metadata: input.metadata }),
  }
  if (open) {
    await db.exceptionFlag.update({ where: { id: open.id }, data })
    return { id: open.id, created: false }
  }
  const row = await db.exceptionFlag.create({
    data: { tenantId: input.tenantId, kind: input.kind, entityType: input.entityType, entityId: input.entityId, ...data },
    select: { id: true },
  })
  return { id: row.id, created: true }
}

/** Resolve the open flags of `kinds` on an entity (the thing they were about is settled). */
export async function resolveRaastFlagsTx(db: Db, tenantId: string, kinds: ConnectorExceptionKind[], entityType: RaastFlagInput['entityType'], entityId: string, resolution: string): Promise<number> {
  const r = await db.exceptionFlag.updateMany({
    where: { tenantId, kind: { in: kinds }, entityType, entityId, status: { in: ['open', 'acknowledged'] } },
    data: { status: 'resolved', resolvedAt: connectorNow(), resolution: resolution.slice(0, 500) },
  })
  return r.count
}

/** Best-effort WhatsApp after commit. */
function notify(tenantId: string, audiences: ConnectorAudience[], text: string): void {
  for (const a of audiences) void notifyConnectorPeople(tenantId, a, `servd: ${text}`)
}

/**
 * S6 — an order completed by ANOTHER tender while it holds a needs_attention
 * Raast receipt (the customer's transfer may be in the bank, unbooked).
 * Stream B calls this inside the completing transaction. Raises / refreshes
 * raast_needs_attention for finance and notes the reason on the receipt. No
 * WhatsApp from inside a transaction — the Inbox flag is the record.
 */
export async function raiseRaastAttentionTx(db: Db, input: { tenantId: string; receiptId: string; reason: string; message?: string }): Promise<void> {
  const r = await db.raastReceipt.findFirst({ where: { id: input.receiptId, tenantId: input.tenantId } })
  if (!r) return
  if (r.status === 'needs_attention') {
    await db.raastReceipt.updateMany({ where: { id: r.id, status: 'needs_attention' }, data: { attentionReason: input.reason.slice(0, 64) } })
  }
  await raiseRaastFlagTx(db, {
    tenantId: r.tenantId, kind: 'raast_needs_attention', severity: 'high',
    title: `Raast payment on bill #${orderRefOf(r.orderId)} needs finance`,
    description: input.message
      ?? `Bill #${orderRefOf(r.orderId)} was settled otherwise; the customer's Raast transfer of ${pkr(r.amountCents)} may be in the bank — refund it or attach it.`,
    entityType: 'RaastReceipt', entityId: r.id, conceptId: r.conceptId, amountCents: r.amountCents,
    metadata: { orderId: r.orderId, reason: input.reason.slice(0, 64), bankRef: r.bankRef ?? null },
  })
}

// ─── Reference checks (M4) ───────────────────────────────────────────────────

/**
 * 409 RAAST_REF_DISMISSED when `bankRef` belongs to a transfer a manager
 * marked "not a sale", or to money going OUT (a debit SMS). Stream B calls it
 * in processPayment / settlePayment for every raast tender, under
 * lockRaastTx, before the receipt is written; finance's reference fix too.
 */
export async function assertRefNotClaimedTx(db: Db, tenantId: string, bankRef: string): Promise<void> {
  if (!bankRef) return
  const hit = await db.bankSmsAlert.findFirst({
    where: { tenantId, OR: [{ claimedRef: bankRef }, { bankRef, kind: 'debit' }, { bankRef, status: 'dismissed' }] },
    select: { id: true, kind: true, status: true },
  })
  if (hit) {
    throw new AppError(
      'RAAST_REF_DISMISSED',
      hit.kind === 'debit'
        ? 'That bank reference is money going OUT of the account — it cannot pay a bill. Check the counter phone for the customer\'s transaction ID.'
        : 'A manager marked that bank transfer "not a sale" — it cannot pay a bill. Check the counter phone for the customer\'s transaction ID.',
      409,
      { alertId: hit.id },
    )
  }
}

/** The same check under the name the spec's amendment uses. */
export const assertRaastRefNotDismissedTx = assertRefNotClaimedTx

export interface RaastSmsAlertLite {
  id: string
  tenantId: string
  amountCents: number
  bankRef: string | null
  bankAccountId: string | null
  occurredAt: Date | null
  payer: string | null
  status: BankSmsAlertStatus
}

function lite(a: BankSmsAlert): RaastSmsAlertLite {
  return {
    id: a.id, tenantId: a.tenantId, amountCents: toCents(a.amountCents) ?? 0, bankRef: a.bankRef, bankAccountId: a.bankAccountId,
    occurredAt: a.occurredAt, payer: a.payer, status: a.status,
  }
}

/**
 * The unlinked bank-credit SMS for `bankRef` that may confirm a receipt on
 * `receipt.bankAccountId` created at `receipt.createdAt` (now when the
 * receipt is about to be written), or null. Eligible (M4): kind credit;
 * status received / processing / unmatched / ambiguous / off /
 * needs_attention; the SAME bank account; occurredAt within
 * [createdAt − matchWindowMin, now + clockSkewMin]; not claimed as "not a
 * sale"; not already linked to a paid receipt.
 */
export async function findSmsForRefTx(
  tx: Db,
  tenantId: string,
  bankRef: string,
  receipt: {
    bankAccountId: string
    /** When the receipt was created (now when it is about to be). Alias: createdAt. */
    receiptCreatedAt?: Date | null
    createdAt?: Date | null
    /** The receipt being confirmed — an alert already linked to IT stays eligible. Alias: id. */
    receiptId?: string | null
    id?: string | null
  },
): Promise<RaastSmsAlertLite | null> {
  if (!bankRef) return null
  const { settings } = await raastConnectorTx(tx, tenantId)
  const now = connectorNow()
  const createdAt = receipt.receiptCreatedAt ?? receipt.createdAt ?? now
  const receiptId = receipt.receiptId ?? receipt.id ?? null
  const since = new Date(createdAt.getTime() - settings.matchWindowMin * 60_000)
  const until = new Date(now.getTime() + settings.clockSkewMin * 60_000)
  const rows = await tx.bankSmsAlert.findMany({
    where: {
      tenantId, bankRef, kind: 'credit', status: { in: OPEN_ALERT_STATUSES }, claimedRef: null,
      bankAccountId: receipt.bankAccountId, occurredAt: { gte: since, lte: until },
    },
    include: { receipt: { select: { id: true, status: true } } },
    orderBy: { receivedAt: 'asc' },
    take: 5,
  })
  const free = rows.find((a) => !a.receipt || a.receipt.id === receiptId || !PAID_RECEIPT_STATUSES.includes(a.receipt.status))
  if (!free) return null
  // An SMS that is settling ANOTHER bill right now (it holds a live lease on
  // that bill's intent, M3) is that customer's payment: never handed to a
  // second bill — linkAlertTx would otherwise pull it off the intent mid-settle.
  // Every caller (the till's cross-check, finance's reference fix) gets this.
  const holder = await tx.raastReceipt.findFirst({
    where: { smsAlertId: free.id, settlingUntil: { gt: now }, ...(receiptId ? { id: { not: receiptId } } : {}) },
    select: { orderId: true },
  })
  if (holder) {
    const orderRef = orderRefOf(holder.orderId)
    throw new AppError('RAAST_SMS_IN_USE', `That bank transfer is completing bill #${orderRef} right now — check the reference on the counter phone`, 409, { orderRef })
  }
  return lite(free)
}

/**
 * Link an SMS alert to a receipt: the receipt carries smsAlertId and
 * smsConfirmedAt, the alert takes `status` ('confirmed' — it confirmed a
 * cashier's receipt; 'matched' — it settled an intent; 'attached' — a
 * cashier attached it by hand). Moves the link off an UNPAID receipt that
 * held it; 409 RAAST_SMS_ALREADY_USED when a paid receipt holds it.
 * Resolves the receipt's raast_unconfirmed flag. Caller holds lockRaastTx.
 */
export async function linkAlertTx(tx: Tx, alertId: string, receiptId: string, status: 'confirmed' | 'matched' | 'attached', actorId?: string | null): Promise<void> {
  const [alert, receipt] = await Promise.all([
    tx.bankSmsAlert.findUnique({ where: { id: alertId } }),
    tx.raastReceipt.findUnique({ where: { id: receiptId } }),
  ])
  if (!alert || !receipt || alert.tenantId !== receipt.tenantId) throw new NotFoundError('Bank alert', alertId)
  await tx.raastReceipt.updateMany({
    where: { smsAlertId: alertId, id: { not: receiptId }, status: { in: UNPAID_RECEIPT_STATUSES } },
    data: { smsAlertId: null, settlingUntil: null },
  })
  const other = await tx.raastReceipt.findFirst({ where: { smsAlertId: alertId, id: { not: receiptId } }, select: { id: true, orderId: true } })
  if (other) {
    throw new AppError('RAAST_SMS_ALREADY_USED', `That bank SMS already paid bill #${orderRefOf(other.orderId)}`, 409, { receiptId: other.id })
  }
  const now = connectorNow()
  await tx.raastReceipt.update({
    where: { id: receiptId },
    data: { smsAlertId: alertId, smsConfirmedAt: receipt.smsConfirmedAt ?? now, settlingUntil: null },
  })
  await tx.bankSmsAlert.update({
    where: { id: alertId },
    data: {
      status, processedAt: alert.processedAt ?? now, candidateIds: [],
      ...(actorId && { resolvedById: actorId, resolvedAt: now }),
      resolution: status === 'confirmed' ? `Confirmed bill #${orderRefOf(receipt.orderId)}` : status === 'matched' ? `Paid bill #${orderRefOf(receipt.orderId)}` : `Attached to bill #${orderRefOf(receipt.orderId)}`,
    },
  })
  await resolveRaastFlagsTx(tx, receipt.tenantId, ['raast_unconfirmed', 'raast_needs_attention'], 'RaastReceipt', receipt.id, 'Confirmed by the bank SMS')
  await resolveRaastFlagsTx(tx, receipt.tenantId, ['raast_sms_unmatched', 'raast_needs_attention'], 'BankSmsAlert', alertId, `Linked to bill #${orderRefOf(receipt.orderId)}`)
}

/** A BankCredit from a parsed SMS alert. */
export function creditOfAlert(a: BankSmsAlert): BankCredit {
  return {
    tenantId: a.tenantId,
    bankAccountId: a.bankAccountId,
    amountCents: toCents(a.amountCents) ?? 0,
    bankRef: a.bankRef ?? '',
    occurredAt: a.occurredAt ?? a.receivedAt,
    ...(a.payer && { payer: a.payer }),
    ...(a.accountLast4 && { accountLast4: a.accountLast4 }),
    receiptId: null,
  }
}

// ─── applyBankCredit ─────────────────────────────────────────────────────────

export type CreditOutcome =
  | 'confirmed' | 'matched' | 'needs_attention' | 'duplicate' | 'unmatched' | 'ambiguous' | 'retry' | 'gone' | 'unsupported'

export interface CreditResult {
  outcome: CreditOutcome
  receiptId?: string
  candidateIds?: string[]
}

type Claim =
  | { kind: 'done'; result: CreditResult; emitAlert?: boolean; flag?: { created: boolean; audiences: ConnectorAudience[]; text: string } }
  | { kind: 'settle'; receipt: RaastReceipt }

async function setAlertTx(tx: Tx, alertId: string, status: BankSmsAlertStatus, extra: Prisma.BankSmsAlertUpdateManyMutationInput = {}): Promise<boolean> {
  const r = await tx.bankSmsAlert.updateMany({ where: { id: alertId, status: 'processing' }, data: { status, processedAt: connectorNow(), ...extra } })
  return r.count === 1
}

/**
 * Lease the intent for this alert (status awaiting, or needs_attention when
 * `allowAttention` — a till attach; it goes back to 'awaiting' under the
 * lease, the state processPayment's claim accepts with this alert's lease,
 * and the attach restores it on a refusal). Caller holds lockRaastTx.
 */
async function leaseIntentTx(tx: Tx, receiptId: string, alertId: string, allowAttention: boolean): Promise<boolean> {
  const now = connectorNow()
  await tx.raastReceipt.updateMany({
    where: { smsAlertId: alertId, id: { not: receiptId }, status: { in: UNPAID_RECEIPT_STATUSES } },
    data: { smsAlertId: null, settlingUntil: null },
  })
  const held = await tx.raastReceipt.findFirst({ where: { smsAlertId: alertId, id: { not: receiptId } }, select: { id: true } })
  if (held) return false
  const c = await tx.raastReceipt.updateMany({
    where: {
      id: receiptId,
      status: { in: allowAttention ? ['awaiting', 'needs_attention'] : ['awaiting'] },
      OR: [{ settlingUntil: null }, { settlingUntil: { lt: now } }, { smsAlertId: alertId }],
    },
    data: { settlingUntil: new Date(now.getTime() + SETTLE_LEASE_MS), smsAlertId: alertId, status: 'awaiting' },
  })
  return c.count === 1
}

/**
 * Apply one bank credit (spec §6.5). The SMS alert must be 'processing'
 * (claimed by processAlert). Serialised per company through lockRaastTx in
 * short transactions (see the header).
 */
export async function applyBankCredit(credit: BankCredit, source: { kind: 'sms'; alertId: string } | { kind: 'bank_api'; eventId: string }): Promise<CreditResult> {
  // v1: bank-SMS only. A bank API driver (spec D6) records its events as
  // alerts too, or gets its own table, and joins here — no rework below.
  if (source.kind !== 'sms') return { outcome: 'unsupported' }
  const alertId = source.alertId
  const claim = await prisma.$transaction((tx) => claimTx(tx, credit, alertId), TX_OPTS)
  if (claim.kind === 'done') {
    afterClaim(credit, alertId, claim)
    return claim.result
  }
  const outcome = await settleClaimed(claim.receipt, alertId, credit, { mode: 'sms', actorId: claim.receipt.createdById })
  return { outcome, receiptId: claim.receipt.id }
}

function afterClaim(credit: BankCredit, alertId: string, claim: Extract<Claim, { kind: 'done' }>): void {
  // unmatched / ambiguous are emitted by processAlert (it knows the device's outlet).
  if (claim.emitAlert && claim.result.outcome !== 'unmatched' && claim.result.outcome !== 'ambiguous') {
    emitTill(credit.tenantId, 'raast:alert', { alertId, status: claim.result.outcome, amountCents: credit.amountCents, occurredAt: credit.occurredAt.toISOString(), locationId: null })
  }
  if (claim.flag?.created) notify(credit.tenantId, claim.flag.audiences, claim.flag.text)
}

async function claimTx(tx: Tx, credit: BankCredit, alertId: string): Promise<Claim> {
  const tenantId = credit.tenantId
  await lockRaastTx(tx, tenantId)
  const alert = await tx.bankSmsAlert.findUnique({ where: { id: alertId } })
  if (!alert || alert.tenantId !== tenantId || alert.status !== 'processing') return { kind: 'done', result: { outcome: 'gone' } }
  const { settings } = await raastConnectorTx(tx, tenantId)
  const now = connectorNow()
  const amt = credit.amountCents
  const ref = credit.bankRef

  // A transfer already claimed as "not a sale" is the same transfer again.
  const claimed = await tx.bankSmsAlert.findFirst({ where: { tenantId, claimedRef: ref, id: { not: alertId } }, select: { id: true } })
  if (claimed) {
    await setAlertTx(tx, alertId, 'duplicate', { resolution: 'Same transfer as a bank alert marked "not a sale"' })
    return { kind: 'done', result: { outcome: 'duplicate' } }
  }

  // 1) A receipt already carries this reference (the cashier typed it).
  const byRef = await tx.raastReceipt.findUnique({ where: { tenantId_bankRef: { tenantId, bankRef: ref } } })
  if (byRef) {
    if (byRef.smsAlertId === alertId && PAID_RECEIPT_STATUSES.includes(byRef.status)) {
      const st = byRef.confirmedVia === 'sms' ? 'matched' : 'confirmed'
      await setAlertTx(tx, alertId, st)
      return { kind: 'done', result: { outcome: st, receiptId: byRef.id } }
    }
    if (byRef.smsAlertId && byRef.smsAlertId !== alertId) {
      await setAlertTx(tx, alertId, 'duplicate', { resolution: `Same transfer as an earlier bank SMS (bill #${orderRefOf(byRef.orderId)})` })
      return { kind: 'done', result: { outcome: 'duplicate', receiptId: byRef.id } }
    }
    const okAmount = within(byRef.amountCents, amt)
    const okAccount = !!credit.bankAccountId && byRef.bankAccountId === credit.bankAccountId
    const okTime = credit.occurredAt.getTime() >= byRef.createdAt.getTime() - settings.matchWindowMin * 60_000
      && credit.occurredAt.getTime() <= now.getTime() + settings.clockSkewMin * 60_000
    if ((byRef.status === 'provisional' || byRef.status === 'matched') && okAmount && okAccount && okTime) {
      await linkAlertTx(tx, alertId, byRef.id, 'confirmed')
      return { kind: 'done', result: { outcome: 'confirmed', receiptId: byRef.id }, emitAlert: false }
    }
    const why = !okAmount
      ? `the bank SMS says ${pkr(amt)} but bill #${orderRefOf(byRef.orderId)} recorded ${pkr(byRef.amountCents)} under this reference`
      : !okAccount
        ? `the bank SMS is for a different bank account than bill #${orderRefOf(byRef.orderId)}'s Raast account`
        : !okTime
          ? `the bank SMS is older than bill #${orderRefOf(byRef.orderId)} — it cannot be that bill's payment`
          : `bill #${orderRefOf(byRef.orderId)}'s Raast payment under this reference is ${byRef.status}`
    await setAlertTx(tx, alertId, 'needs_attention', { resolution: scrubMessage(why, 300), candidateIds: [byRef.id] })
    const f = await raiseRaastFlagTx(tx, {
      tenantId, kind: 'raast_needs_attention', severity: 'high',
      title: `Raast reference ${ref} does not agree with bill #${orderRefOf(byRef.orderId)}`,
      description: `Check it: ${why}. A cashier may have typed someone else's reference — compare with the counter phone and the bank statement.`,
      entityType: 'BankSmsAlert', entityId: alertId, conceptId: byRef.conceptId, amountCents: amt,
      metadata: { receiptId: byRef.id, orderId: byRef.orderId, bankRef: ref },
    })
    return { kind: 'done', result: { outcome: 'needs_attention', receiptId: byRef.id }, emitAlert: true, flag: { created: f.created, audiences: ['raast_floor', 'raast_finance'], text: `Raast reference ${ref} does not agree with bill #${orderRefOf(byRef.orderId)} — check it in the till's bank alerts.` } }
  }

  // The same transfer reported twice (a second SMS for one credit).
  const twin = await tx.bankSmsAlert.findFirst({
    where: {
      tenantId, bankRef: ref, kind: 'credit', id: { not: alertId }, createdAt: { lte: alert.createdAt },
      status: { in: ['processing', 'unmatched', 'ambiguous', 'needs_attention', 'matched', 'confirmed', 'attached', 'dismissed', 'off'] },
    },
    select: { id: true },
  })
  if (twin) {
    await setAlertTx(tx, alertId, 'duplicate', { resolution: 'Same transfer as an earlier bank SMS' })
    return { kind: 'done', result: { outcome: 'duplicate' } }
  }

  // 2) A future dynamic QR names the bill (credit.receiptId).
  if (credit.receiptId) {
    const r = await tx.raastReceipt.findFirst({ where: { id: credit.receiptId, tenantId, status: 'awaiting' } })
    if (r && within(r.amountCents, amt) && (!credit.bankAccountId || r.bankAccountId === credit.bankAccountId) && await leaseIntentTx(tx, r.id, alertId, false)) {
      return { kind: 'settle', receipt: (await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })) }
    }
    await setAlertTx(tx, alertId, 'needs_attention', { resolution: 'The bill this transfer names is not waiting for this amount' })
    return { kind: 'done', result: { outcome: 'needs_attention' }, emitAlert: true }
  }

  // 3) The awaiting intents it could belong to: EVERY intent still live when
  //    the money arrived (expiresAt > occurredAt) and put up no later than the
  //    clock skew after it. No lower bound on createdAt (RV-FRAUD-2): an older
  //    intent of the same amount that is still waiting is just as likely the
  //    payer — two of them is 'ambiguous', never a guess for the newer one.
  const hi = new Date(credit.occurredAt.getTime() + settings.clockSkewMin * 60_000)
  const cands = await tx.raastReceipt.findMany({
    where: {
      tenantId, status: 'awaiting',
      ...(credit.bankAccountId && { bankAccountId: credit.bankAccountId }),
      amountCents: { gte: amt - RAAST_TOLERANCE_CENTS, lte: amt + RAAST_TOLERANCE_CENTS },
      createdAt: { lte: hi },
      expiresAt: { gt: credit.occurredAt },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })
  if (cands.length === 0) {
    await setAlertTx(tx, alertId, 'unmatched', { candidateIds: [] })
    return { kind: 'done', result: { outcome: 'unmatched' }, emitAlert: true }
  }
  if (cands.length >= 2) {
    const ids = cands.map((c) => c.id)
    await setAlertTx(tx, alertId, 'ambiguous', { candidateIds: ids })
    return { kind: 'done', result: { outcome: 'ambiguous', candidateIds: ids }, emitAlert: true }
  }
  // 4) Exactly one: lease it, then pay outside this transaction (M3).
  if (!(await leaseIntentTx(tx, cands[0]!.id, alertId, false))) {
    await setAlertTx(tx, alertId, 'unmatched', { candidateIds: [cands[0]!.id], resolution: 'Another bank SMS was completing that bill' })
    return { kind: 'done', result: { outcome: 'unmatched' }, emitAlert: true }
  }
  return { kind: 'settle', receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: cands[0]!.id } }) }
}

function isRefusal(err: unknown): err is AppError {
  return err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500
}

/**
 * Pay a leased intent with the SMS (steps 2 and 3). mode 'sms': a refusal
 * puts the bill in front of a person (needs_attention). mode 'attach': the
 * cashier is waiting — a refusal rolls the claim back and is rethrown.
 */
export async function settleClaimed(
  receipt: RaastReceipt,
  alertId: string,
  credit: BankCredit,
  opts: { mode: 'sms' | 'attach'; actorId: string; prior?: { alertStatus: BankSmsAlertStatus; receiptStatus: RaastReceiptStatus; createdForAttach: boolean } },
): Promise<CreditOutcome> {
  let err: unknown = null
  try {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: receipt.orderId }, select: { concept: { select: { tenantId: true } } } })
    if (!receipt.shiftId) throw new AppError('SHIFT_REQUIRED', 'The Raast payment has no drawer', 422)
    await assertShiftOf(order.concept.tenantId, receipt.shiftId, true)
    const raast = { intentId: receipt.id, via: 'sms' as const, smsAlertId: alertId }
    if (receipt.targetPaymentId) {
      const input: SettleInput = {
        paymentId: receipt.targetPaymentId, via: 'till', shiftId: receipt.shiftId, gatewayRef: credit.bankRef, actorId: opts.actorId, raast,
      }
      await settlePayment(input)
    } else {
      const input: ProcessPaymentInput = {
        orderId: receipt.orderId,
        shiftId: receipt.shiftId,
        actorId: opts.actorId,
        idempotencyKey: `raast:${receipt.id}`,
        payments: [{ method: 'raast', amountCents: receipt.amountCents, tipCents: receipt.tipCents, gatewayRef: credit.bankRef, raast }],
      }
      await processPayment(input)
    }
  } catch (e) {
    err = e
  }

  const fin = await prisma.$transaction(async (tx) => {
    await lockRaastTx(tx, receipt.tenantId)
    const r = await tx.raastReceipt.findUnique({ where: { id: receipt.id } })
    const doneStatus = opts.mode === 'attach' ? 'attached' as const : 'matched' as const
    // Paid — by this alert (success, or a replay) or, M2, by the cashier with the same reference.
    if (r && (r.status === 'provisional' || r.status === 'matched')) {
      const ours = r.smsAlertId === alertId
      if (ours || (!r.smsAlertId && r.bankRef === credit.bankRef && within(r.amountCents, credit.amountCents) && r.bankAccountId === credit.bankAccountId)) {
        // ours: this SMS paid it. Otherwise (M2) the cashier recorded the same
        // transfer a moment earlier — the SMS confirms that receipt.
        await linkAlertTx(tx, alertId, r.id, ours ? doneStatus : 'confirmed', opts.mode === 'attach' ? opts.actorId : null)
        return { outcome: ours ? 'matched' as const : 'confirmed' as const, flag: null }
      }
      // Paid some other way (another reference / tender) while this SMS waited.
      await setAlertTx(tx, alertId, 'needs_attention', { resolution: `Bill #${orderRefOf(r.orderId)} was paid another way while this transfer waited` })
      const f = await raiseRaastFlagTx(tx, {
        tenantId: r.tenantId, kind: 'raast_needs_attention', severity: 'high',
        title: `Raast transfer of ${pkr(credit.amountCents)} not booked`,
        description: `Bill #${orderRefOf(r.orderId)} was paid another way while this bank transfer (ref ${credit.bankRef}) was settling it. Refund the customer or attach the transfer to the right bill.`,
        entityType: 'BankSmsAlert', entityId: alertId, conceptId: r.conceptId, amountCents: credit.amountCents,
        metadata: { receiptId: r.id, orderId: r.orderId, bankRef: credit.bankRef },
      })
      return { outcome: 'needs_attention' as const, flag: f }
    }

    if (opts.mode === 'attach') {
      // Roll the claim back exactly; the cashier sees the refusal.
      if (opts.prior?.createdForAttach) {
        await tx.raastReceipt.updateMany({ where: { id: receipt.id, status: 'awaiting', smsAlertId: alertId }, data: { status: 'cancelled', cancelReason: 'attach_refused', smsAlertId: null, settlingUntil: null, expiresAt: null } })
      } else {
        await tx.raastReceipt.updateMany({
          where: { id: receipt.id, smsAlertId: alertId, status: { in: ['awaiting', 'needs_attention'] } },
          data: { smsAlertId: null, settlingUntil: null, status: opts.prior?.receiptStatus === 'needs_attention' ? 'needs_attention' : 'awaiting' },
        })
      }
      await tx.bankSmsAlert.updateMany({ where: { id: alertId, status: 'processing' }, data: { status: opts.prior?.alertStatus ?? 'unmatched' } })
      return { outcome: 'retry' as const, flag: null }
    }

    if (isRefusal(err)) {
      // M2: needs_attention ONLY from 'awaiting' — never over a paid receipt.
      const code = err.code.slice(0, 64)
      const moved = await tx.raastReceipt.updateMany({
        where: { id: receipt.id, status: 'awaiting' },
        data: { status: 'needs_attention', attentionReason: code, settlingUntil: null, expiresAt: null },
      })
      if (moved.count === 0 && r && r.smsAlertId === alertId) {
        await tx.raastReceipt.updateMany({ where: { id: receipt.id, smsAlertId: alertId, status: { in: UNPAID_RECEIPT_STATUSES } }, data: { settlingUntil: null, ...(r.status === 'cancelled' && { smsAlertId: null }) } })
      }
      await setAlertTx(tx, alertId, 'needs_attention', { resolution: scrubMessage(`${code}: ${err.message}`, 300), candidateIds: [receipt.id] })
      const f = await raiseRaastFlagTx(tx, {
        tenantId: receipt.tenantId, kind: 'raast_needs_attention', severity: 'high',
        title: `Raast payment on bill #${orderRefOf(receipt.orderId)} needs a person`,
        description: `A bank SMS for ${pkr(credit.amountCents)} (ref ${credit.bankRef}) arrived for this bill but servd could not complete it (${code}: ${scrubMessage(err.message, 200)}). Check the bill at the till — attach the bank alert, or refund the customer.`,
        entityType: 'RaastReceipt', entityId: receipt.id, conceptId: receipt.conceptId, amountCents: credit.amountCents,
        metadata: { orderId: receipt.orderId, alertId, bankRef: credit.bankRef, code },
      })
      return { outcome: 'needs_attention' as const, flag: f }
    }

    // Not a refusal (a crash, a timeout): release the lease and try again later.
    await tx.raastReceipt.updateMany({ where: { id: receipt.id, smsAlertId: alertId, status: { in: ['awaiting', 'needs_attention'] } }, data: { settlingUntil: null, smsAlertId: null } })
    const a = await tx.bankSmsAlert.findUnique({ where: { id: alertId }, select: { attempts: true } })
    const attempts = (a?.attempts ?? 0) + 1
    if (attempts >= MAX_ALERT_ATTEMPTS) {
      await setAlertTx(tx, alertId, 'needs_attention', { attempts, resolution: scrubMessage(`Gave up after ${attempts} attempts: ${err instanceof Error ? err.message : String(err)}`, 300) })
      const f = await raiseRaastFlagTx(tx, {
        tenantId: receipt.tenantId, kind: 'raast_needs_attention', severity: 'high',
        title: `Bank SMS for ${pkr(credit.amountCents)} could not be applied`,
        description: `servd tried ${attempts} times to complete bill #${orderRefOf(receipt.orderId)} with a bank transfer (ref ${credit.bankRef}) and failed. Attach it at the till or refund the customer.`,
        entityType: 'BankSmsAlert', entityId: alertId, conceptId: receipt.conceptId, amountCents: credit.amountCents,
        metadata: { receiptId: receipt.id, orderId: receipt.orderId, bankRef: credit.bankRef },
      })
      return { outcome: 'needs_attention' as const, flag: f }
    }
    await tx.bankSmsAlert.updateMany({ where: { id: alertId, status: 'processing' }, data: { status: 'received', attempts } })
    return { outcome: 'retry' as const, flag: null }
  }, TX_OPTS)

  const fresh = await prisma.raastReceipt.findUnique({ where: { id: receipt.id }, select: { status: true, bankRef: true, attentionReason: true } })
  emitTill(receipt.tenantId, 'raast:intent', {
    receiptId: receipt.id, orderId: receipt.orderId, status: fresh?.status ?? receipt.status, amountCents: receipt.amountCents,
    ...(fresh?.bankRef && { refLast4: fresh.bankRef.slice(-4) }), ...(fresh?.attentionReason && { reason: fresh.attentionReason }),
  })
  if (fin.outcome === 'matched' || fin.outcome === 'confirmed') {
    await audit({
      category: 'identity', action: opts.mode === 'attach' ? 'raast.sms_attached' : 'raast.sms_settled', entity: 'RaastReceipt', entityId: receipt.id,
      userId: opts.mode === 'attach' ? opts.actorId : null, tenantId: receipt.tenantId,
      metadata: { orderId: receipt.orderId, alertId, amountCents: receipt.amountCents, bankRef: credit.bankRef, outcome: fin.outcome },
    })
  } else if (fin.outcome === 'needs_attention') {
    emitTill(receipt.tenantId, 'raast:alert', { alertId, status: 'needs_attention', amountCents: credit.amountCents, occurredAt: credit.occurredAt.toISOString(), locationId: null })
    if (fin.flag?.created) notify(receipt.tenantId, ['raast_floor', 'raast_finance'], `a Raast payment of ${pkr(credit.amountCents)} on bill #${orderRefOf(receipt.orderId)} needs a person (bank alerts at the till).`)
  }
  if (opts.mode === 'attach' && err && fin.outcome === 'retry') throw err
  return fin.outcome
}

// ─── An intent created after its SMS arrived (S1) ────────────────────────────

/**
 * A new intent: an UNMATCHED credit SMS of the same company, bank account and
 * amount with occurredAt >= intent.createdAt − clockSkewMin settles it when
 * there is exactly one (S1 — an SMS from before the bill was put up for
 * Raast is a different customer's payment until a cashier says otherwise;
 * those show as "possible earlier payment", see possibleEarlierPayments).
 */
export async function matchOnIntentCreated(receiptId: string): Promise<CreditResult> {
  const r0 = await prisma.raastReceipt.findUnique({ where: { id: receiptId } })
  if (!r0 || r0.status !== 'awaiting') return { outcome: 'gone' }
  const { enabled } = await raastConnectorTx(prisma, r0.tenantId)
  if (!enabled) return { outcome: 'unmatched' }
  type IntentClaim =
    | { kind: 'settle'; receipt: RaastReceipt; alert: BankSmsAlert }
    | { kind: 'ambiguous'; alert: BankSmsAlert; candidateIds: string[] }
  const claim = await prisma.$transaction(async (tx): Promise<IntentClaim | null> => {
    await lockRaastTx(tx, r0.tenantId)
    const r = await tx.raastReceipt.findUnique({ where: { id: receiptId } })
    if (!r || r.status !== 'awaiting') return null
    const { settings } = await raastConnectorTx(tx, r.tenantId)
    const now = connectorNow()
    const alerts = await tx.bankSmsAlert.findMany({
      where: {
        tenantId: r.tenantId, kind: 'credit', status: 'unmatched', claimedRef: null, bankAccountId: r.bankAccountId,
        amountCents: { gte: r.amountCents - RAAST_TOLERANCE_CENTS, lte: r.amountCents + RAAST_TOLERANCE_CENTS },
        occurredAt: {
          gte: new Date(r.createdAt.getTime() - settings.clockSkewMin * 60_000),
          lte: new Date(Math.min(now.getTime() + settings.clockSkewMin * 60_000, (r.expiresAt ?? now).getTime())),
        },
      },
      include: { receipt: { select: { status: true } } },
      take: 5,
    })
    const free = alerts.filter((a) => !a.receipt || !PAID_RECEIPT_STATUSES.includes(a.receipt.status))
    if (free.length !== 1) return null
    const a = free[0]!
    if (!a.bankRef || await tx.raastReceipt.findUnique({ where: { tenantId_bankRef: { tenantId: r.tenantId, bankRef: a.bankRef } }, select: { id: true } })) return null
    // RV-FRAUD-3: the same "exactly one" rule as claimTx, from the intent's
    // side — another live awaiting intent that could own this credit makes it
    // ambiguous; a cashier decides which bill it pays.
    const occurredAt = a.occurredAt ?? a.receivedAt
    const smsCents = toCents(a.amountCents) ?? 0
    const others = await tx.raastReceipt.findMany({
      where: {
        tenantId: r.tenantId, status: 'awaiting', id: { not: r.id }, bankAccountId: r.bankAccountId,
        amountCents: { gte: smsCents - RAAST_TOLERANCE_CENTS, lte: smsCents + RAAST_TOLERANCE_CENTS },
        expiresAt: { gt: occurredAt },
        createdAt: { lte: new Date(occurredAt.getTime() + settings.clockSkewMin * 60_000) },
        OR: [{ settlingUntil: null }, { settlingUntil: { lte: now } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 9,
    })
    if (others.length > 0) {
      const ids = [r.id, ...others.map((o) => o.id)]
      const set = await tx.bankSmsAlert.updateMany({ where: { id: a.id, status: 'unmatched' }, data: { status: 'ambiguous', candidateIds: ids, processedAt: now } })
      return set.count === 1 ? { kind: 'ambiguous', alert: a, candidateIds: ids } : null
    }
    const took = await tx.bankSmsAlert.updateMany({ where: { id: a.id, status: 'unmatched' }, data: { status: 'processing' } })
    if (took.count !== 1) return null
    if (!(await leaseIntentTx(tx, r.id, a.id, false))) {
      await tx.bankSmsAlert.updateMany({ where: { id: a.id, status: 'processing' }, data: { status: 'unmatched' } })
      return null
    }
    return { kind: 'settle', receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } }), alert: a }
  }, TX_OPTS)
  if (!claim) return { outcome: 'unmatched' }
  if (claim.kind === 'ambiguous') {
    const a = claim.alert
    emitTill(r0.tenantId, 'raast:alert', {
      alertId: a.id, status: 'ambiguous', amountCents: toCents(a.amountCents) ?? 0, occurredAt: (a.occurredAt ?? a.receivedAt).toISOString(), locationId: a.locationId,
    })
    return { outcome: 'ambiguous', candidateIds: claim.candidateIds }
  }
  const outcome = await settleClaimed(claim.receipt, claim.alert.id, creditOfAlert(claim.alert), { mode: 'sms', actorId: claim.receipt.createdById })
  return { outcome, receiptId: claim.receipt.id }
}

export interface EarlierPayment {
  alertId: string
  amountCents: number
  payer: string | null
  occurredAt: string | null
  bankRefLast4: string | null
}

/**
 * S1 — unmatched credit SMS on the intent's bank account for its amount that
 * arrived up to matchWindowMin BEFORE the intent (older than clockSkewMin).
 * Shown to the cashier as "possible earlier payment"; attached only by hand.
 */
export async function possibleEarlierPayments(db: Db, r: Pick<RaastReceipt, 'tenantId' | 'bankAccountId' | 'amountCents' | 'createdAt'>): Promise<EarlierPayment[]> {
  const { settings } = await raastConnectorTx(db, r.tenantId)
  const rows = await db.bankSmsAlert.findMany({
    where: {
      tenantId: r.tenantId, kind: 'credit', status: { in: ['unmatched', 'ambiguous'] }, claimedRef: null, bankAccountId: r.bankAccountId,
      amountCents: { gte: r.amountCents - RAAST_TOLERANCE_CENTS, lte: r.amountCents + RAAST_TOLERANCE_CENTS },
      occurredAt: {
        gte: new Date(r.createdAt.getTime() - settings.matchWindowMin * 60_000),
        lt: new Date(r.createdAt.getTime() - settings.clockSkewMin * 60_000),
      },
    },
    orderBy: { occurredAt: 'desc' },
    take: 5,
  })
  return rows.map((a) => ({
    alertId: a.id, amountCents: toCents(a.amountCents) ?? 0, payer: a.payer, occurredAt: a.occurredAt?.toISOString() ?? null,
    bankRefLast4: a.bankRef ? a.bankRef.slice(-4) : null,
  }))
}

/** Lease helper for the till's attach action (intents.ts). Caller holds lockRaastTx. */
export const leaseIntentForAlertTx = leaseIntentTx

/** P2002 on a unique key — exported for the routes. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}
