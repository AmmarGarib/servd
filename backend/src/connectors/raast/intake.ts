// Bank SMS intake (spec §6.3–6.4).
//
// The forwarder on the counter phone POSTs every SMS it is set to forward.
// servd keeps ONLY SMS from the company's listed bank senders that carry no
// ignore keyword (OTPs, PINs, passwords): anything else is counted on the
// device (ignoredCount) and its text is never stored. A kept SMS becomes a
// BankSmsAlert('received') — deduped on (company, sender, text, received
// second) — and is processed straight after the reply (setImmediate), with
// the worker as the backstop.
//
// processAlert: received → processing (a claim), parse with the sender's
// templates, then:
//   no template matches / bad reference → 'unparsed' + ONE open
//     raast_sms_unparsed flag per company + sender (count refreshed, WhatsApp
//     to admin / it / finance at most hourly — never silent);
//   a debit → 'debit' + raast_debit_alert (finance); its reference is claimed
//     so it can never pay a bill;
//   SMS matching OFF → 'off' (kept so IT can check templates on real
//     traffic; never matched);
//   else applyBankCredit.

import { createHash } from 'node:crypto'
import { Prisma, type BankSmsDevice } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { emitTill } from '../../lib/ws.js'
import { connectorNow } from '../registry.js'
import { parseRaastSettings } from '../config.js'
import { notifyConnectorPeople } from '../alerts.js'
import { assertValidBankRef } from './reference.js'
import { MAX_SMS_CHARS, isIgnored, normalizeSender, parseSms } from './sms.js'
import { applyBankCredit, creditOfAlert, raiseRaastFlagTx, raastConnectorTx, type CreditResult } from './match.js'

// ─── Body extraction (lenient: JSON or form) ─────────────────────────────────

const SENDER_KEYS = ['from', 'sender', 'address', 'phone', 'number', 'originatingaddress']
const TEXT_KEYS = ['text', 'body', 'message', 'msg', 'content', 'sms']
const TIME_KEYS = ['receivedat', 'receivedstamp', 'sentstamp', 'timestamp', 'time', 'date']

export interface SmsFields {
  sender: string
  text: string
  receivedAt: Date | null
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  const lower = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]))
  for (const k of keys) {
    const v = lower.get(k)
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/** A forwarder's time field: epoch ms or s (number or digits), or an ISO-ish string. */
export function parseForwarderTime(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number' || (typeof v === 'string' && /^[0-9]{9,14}$/.test(v.trim()))) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return null
    const d = new Date(n < 1e12 ? n * 1000 : n)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'string' && v.length <= 64) {
    const d = new Date(v.trim())
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/** sender / text / time from a raw body (JSON object, or x-www-form-urlencoded); null when sender or text is missing. */
export function extractSmsFields(raw: string, contentType?: string | null): SmsFields | null {
  let obj: Record<string, unknown> | null = null
  const body = String(raw ?? '')
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      const v = JSON.parse(trimmed) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) obj = v as Record<string, unknown>
    } catch { obj = null }
  }
  if (!obj && (!contentType || /form|text|plain/i.test(contentType) || !trimmed.startsWith('{'))) {
    try {
      const p = new URLSearchParams(body)
      const o: Record<string, unknown> = {}
      for (const [k, v] of p) o[k] = v
      if (Object.keys(o).length > 0) obj = o
    } catch { obj = null }
  }
  if (!obj) return null
  const sender = pick(obj, SENDER_KEYS)
  const text = pick(obj, TEXT_KEYS)
  if (typeof sender !== 'string' && typeof sender !== 'number') return null
  if (typeof text !== 'string' || !text.trim()) return null
  return { sender: String(sender).slice(0, 64), text: text.slice(0, MAX_SMS_CHARS), receivedAt: parseForwarderTime(pick(obj, TIME_KEYS)) }
}

// ─── Intake ──────────────────────────────────────────────────────────────────

export type IntakeResult =
  | { ignored: true; reason: 'sender_not_listed' | 'keyword' }
  | { duplicate: true }
  | { ok: true; id: string }

function bodyHashOf(tenantId: string, sender: string, text: string, receivedAt: Date): string {
  const second = new Date(Math.floor(receivedAt.getTime() / 1000) * 1000).toISOString()
  return createHash('sha256').update(`${tenantId}|${sender}|${text}|${second}`, 'utf8').digest('hex')
}

/** Store one forwarded SMS for the device's company (or count it as ignored). Never stores an unlisted or keyword SMS. */
export async function intakeSms(device: BankSmsDevice, fields: SmsFields): Promise<IntakeResult> {
  const now = connectorNow()
  const conn = await prisma.posConnector.findUnique({ where: { id: device.connectorId }, select: { settings: true } })
  const settings = parseRaastSettings(conn?.settings ?? {})
  const sender = normalizeSender(fields.sender)
  const listed = !!sender && settings.senders.some((s) => s.active && normalizeSender(s.senderId) === sender)
  const text = fields.text.slice(0, MAX_SMS_CHARS)
  const ignoredReason = !listed ? 'sender_not_listed' as const : isIgnored(text, settings.ignoreKeywords) ? 'keyword' as const : null
  if (ignoredReason) {
    await prisma.bankSmsDevice.update({ where: { id: device.id }, data: { lastSeenAt: now, ignoredCount: { increment: 1 }, lastIgnoredAt: now } })
    return { ignored: true, reason: ignoredReason }
  }
  // The phone's own clock, when believable (a week back, a day ahead); else now.
  const rec = fields.receivedAt
  const receivedAt = rec && rec.getTime() >= now.getTime() - 7 * 86_400_000 && rec.getTime() <= now.getTime() + 86_400_000 ? rec : now
  const bodyHash = bodyHashOf(device.tenantId, sender, text, receivedAt)
  // A forwarder retry (the common case) is answered without a failed insert.
  if (await prisma.bankSmsAlert.findUnique({ where: { tenantId_bodyHash: { tenantId: device.tenantId, bodyHash } }, select: { id: true } })) {
    await prisma.bankSmsDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } })
    return { duplicate: true }
  }
  try {
    const row = await prisma.bankSmsAlert.create({
      data: {
        tenantId: device.tenantId, deviceId: device.id, locationId: device.locationId, sender,
        bodyHash, body: text, receivedAt, status: 'received',
      },
      select: { id: true },
    })
    await prisma.bankSmsDevice.update({ where: { id: device.id }, data: { lastSeenAt: now, lastSmsAt: now } })
    return { ok: true, id: row.id }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await prisma.bankSmsDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } })
      return { duplicate: true }
    }
    throw err
  }
}

// ─── processAlert ────────────────────────────────────────────────────────────

export type ProcessOutcome = CreditResult['outcome'] | 'unparsed' | 'debit' | 'off' | 'skipped'

const HOUR = 3_600_000

async function flagUnparsed(tenantId: string, connectorId: string | null, sender: string, why: string): Promise<void> {
  const now = connectorNow()
  const open = await prisma.exceptionFlag.findFirst({
    where: { tenantId, kind: 'raast_sms_unparsed', status: { in: ['open', 'acknowledged'] }, metadata: { path: ['sender'], equals: sender } },
    select: { id: true, metadata: true },
  })
  const meta = (open?.metadata && typeof open.metadata === 'object' && !Array.isArray(open.metadata) ? open.metadata : {}) as Record<string, unknown>
  const count = (typeof meta['count'] === 'number' ? meta['count'] : 0) + 1
  const lastNotified = typeof meta['notifiedAt'] === 'string' ? Date.parse(meta['notifiedAt']) : 0
  const shouldNotify = !lastNotified || now.getTime() - lastNotified >= HOUR
  const metadata = { sender, count, lastAt: now.toISOString(), lastProblem: why.slice(0, 200), notifiedAt: shouldNotify ? now.toISOString() : (meta['notifiedAt'] as string | undefined) ?? null }
  const title = `Bank SMS from ${sender} not understood`
  const description = `${count} SMS from ${sender} matched none of its templates (latest: ${why}). Money may have arrived that servd cannot see. Fix: Dev → API → POS connector → Raast QR — test the SMS in the template tester and add or correct the template.`
  if (open) {
    await prisma.exceptionFlag.update({ where: { id: open.id }, data: { description, metadata, updatedAt: now } })
  } else {
    await prisma.exceptionFlag.create({
      data: { tenantId, kind: 'raast_sms_unparsed', severity: 'medium', title, description, entityType: 'PosConnector', entityId: connectorId, metadata },
    })
  }
  if (shouldNotify) void notifyConnectorPeople(tenantId, 'raast_finance', `servd: ${title}. Check the Raast QR templates in Dev → API → POS connector.`)
}

/**
 * Process one 'received' alert (claim → parse → route). Safe to call twice:
 * the claim (received → processing) lets one caller through.
 */
export async function processAlert(alertId: string): Promise<ProcessOutcome> {
  const claim = await prisma.bankSmsAlert.updateMany({ where: { id: alertId, status: 'received' }, data: { status: 'processing' } })
  if (claim.count === 0) return 'skipped'
  const alert = await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })
  const now = connectorNow()
  const state = await raastConnectorTx(prisma, alert.tenantId)
  const s = state.settings
  const setStatus = (status: 'unparsed' | 'debit' | 'off', data: Prisma.BankSmsAlertUpdateManyMutationInput = {}) =>
    prisma.bankSmsAlert.updateMany({ where: { id: alertId, status: 'processing' }, data: { status, processedAt: now, ...data } })

  const entries = s.senders.filter((e) => e.active && normalizeSender(e.senderId) === alert.sender)
  if (!alert.body || entries.length === 0) {
    await setStatus('unparsed', { resolution: entries.length === 0 ? 'The sender is no longer on the bank sender list' : 'No SMS text' })
    return 'unparsed'
  }
  const templateIds = new Set(entries.flatMap((e) => e.templateIds))
  const templates = s.templates.filter((t) => t.active && templateIds.has(t.id))
  const parsed = parseSms(alert.body, templates, { receivedAt: alert.receivedAt, now })
  if (!parsed) {
    await setStatus('unparsed', { resolution: 'Matched no template' })
    await flagUnparsed(alert.tenantId, state.connectorId, alert.sender, 'no template matched')
    return 'unparsed'
  }

  // Which receiving account: the only entry for this sender, or the one whose last 4 digits the SMS names.
  const entry = entries.length === 1 ? entries[0]! : entries.find((e) => e.accountLast4 && e.accountLast4 === parsed.accountLast4) ?? null
  const fields: Prisma.BankSmsAlertUpdateManyMutationInput = {
    templateId: parsed.templateId, kind: parsed.kind, amountCents: parsed.amountCents, bankRef: parsed.bankRef,
    occurredAt: parsed.occurredAt, payer: parsed.payer, accountLast4: parsed.accountLast4,
  }
  const account = entry
    ? await prisma.bankAccount.findFirst({ where: { id: entry.bankAccountId, tenantId: alert.tenantId, deletedAt: null }, select: { id: true } })
    : null
  if (!account) {
    await setStatus('unparsed', { ...fields, resolution: entry ? 'The bank account for this sender is not one of this company\'s' : 'Several accounts use this sender and the SMS does not say which (add the last 4 digits to each sender entry)' })
    await flagUnparsed(alert.tenantId, state.connectorId, alert.sender, 'cannot tell which bank account')
    return 'unparsed'
  }
  fields.bankAccountId = account.id

  if (parsed.kind === 'debit') {
    // Money going OUT: never a sale. Its reference is claimed (M4).
    let claimedRef: string | null = parsed.bankRef
    if (claimedRef) {
      const taken = await prisma.bankSmsAlert.findFirst({ where: { tenantId: alert.tenantId, claimedRef }, select: { id: true } })
      if (taken) claimedRef = null
    }
    try {
      await setStatus('debit', { ...fields, claimedRef })
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err
      await setStatus('debit', fields)
    }
    const amount = parsed.amountCents
    const f = await raiseRaastFlagTx(prisma, {
      tenantId: alert.tenantId, kind: 'raast_debit_alert', severity: 'medium',
      title: `PKR ${(amount / 100).toFixed(2)} left a Raast receiving account`,
      description: `A bank SMS from ${alert.sender} reports money going OUT of a Raast receiving account (ref ${parsed.bankRef ?? 'none'}). Check it was expected (a refund, a transfer to the operating account).`,
      entityType: 'BankSmsAlert', entityId: alert.id, amountCents: amount,
      metadata: { bankAccountId: account.id, bankRef: parsed.bankRef ?? null },
    })
    if (f.created) void notifyConnectorPeople(alert.tenantId, 'raast_finance', `servd: PKR ${(amount / 100).toFixed(2)} left a Raast receiving account (bank SMS). Check it was expected.`)
    return 'debit'
  }

  if (!parsed.bankRef) {
    await setStatus('unparsed', { ...fields, resolution: 'No transaction ID' })
    await flagUnparsed(alert.tenantId, state.connectorId, alert.sender, 'no transaction ID')
    return 'unparsed'
  }
  try {
    assertValidBankRef(parsed.bankRef, { min: s.refMinLength, max: s.refMaxLength })
  } catch {
    await setStatus('unparsed', { ...fields, bankRef: null, resolution: `The transaction ID "${parsed.bankRef.slice(0, 40)}" does not look like a bank reference` })
    await flagUnparsed(alert.tenantId, state.connectorId, alert.sender, 'the transaction ID does not look right')
    return 'unparsed'
  }

  if (!state.enabled) {
    await setStatus('off', fields)
    return 'off'
  }
  await prisma.bankSmsAlert.updateMany({ where: { id: alertId, status: 'processing' }, data: fields })
  const fresh = await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })
  const r = await applyBankCredit(creditOfAlert(fresh), { kind: 'sms', alertId })
  if (['unmatched', 'ambiguous'].includes(r.outcome)) {
    emitTill(alert.tenantId, 'raast:alert', { alertId, status: r.outcome, amountCents: parsed.amountCents, occurredAt: parsed.occurredAt.toISOString(), locationId: alert.locationId })
  }
  return r.outcome
}

/** Fire-and-forget processing after the webhook reply. Errors put the alert back to 'received' (the worker retries). */
export function processAlertSoon(alertId: string): void {
  setImmediate(() => {
    processAlert(alertId).catch(async (err) => {
      console.error(`[raast] alert ${alertId} failed (will retry):`, (err as Error).message)
      await prisma.bankSmsAlert.updateMany({ where: { id: alertId, status: 'processing' }, data: { status: 'received', attempts: { increment: 1 } } }).catch(() => {})
    })
  })
}
