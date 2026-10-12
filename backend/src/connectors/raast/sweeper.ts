// Raast QR background work (spec §6.10). Driven by workers/raastConnector.ts
// (node-cron, no Redis). Each step is safe to run twice and from two
// processes: every write is a conditional claim.
//
//   every 30 s  — process 'received' alerts older than 20 s (the webhook's
//                 setImmediate is the fast path), put 'processing' alerts
//                 stuck for 2 min back to 'received', expire awaiting
//                 intents (→ cancelled 'expired').
//   every 10 min (companies with SMS matching ON) — a cashier-typed Raast
//                 reference with no bank SMS after smsConfirmMin →
//                 raast_unconfirmed (high, floor); unmatched / ambiguous
//                 bank credits older than unmatchedAlertEscalateMin →
//                 raast_sms_unmatched (finance + floor).
//   daily       — drop SMS text older than 90 days (unparsed: 30 days).

import { prisma } from '../../lib/prisma.js'
import { toCents } from '../../lib/money.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { connectorNow } from '../registry.js'
import { notifyConnectorPeople } from '../alerts.js'
import { processAlert } from './intake.js'
import { expireRaastIntents } from './intents.js'
import { raiseRaastFlagTx, raastConnectorTx } from './match.js'

const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

export interface RaastTickStats { processed: number; reset: number; expired: number }

export async function runRaastTick(): Promise<RaastTickStats> {
  const now = connectorNow()
  // Stuck claims (a crash between claim and finish) go back to the queue.
  const reset = await prisma.bankSmsAlert.updateMany({
    where: { status: 'processing', updatedAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
    data: { status: 'received', attempts: { increment: 1 } },
  })
  const due = await prisma.bankSmsAlert.findMany({
    where: { status: 'received', createdAt: { lt: new Date(now.getTime() - 20_000) } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  let processed = 0
  for (const a of due) {
    try {
      await processAlert(a.id)
      processed++
    } catch (err) {
      console.error(`[raast] alert ${a.id} failed (will retry):`, (err as Error).message)
      await prisma.bankSmsAlert.updateMany({ where: { id: a.id, status: 'processing' }, data: { status: 'received', attempts: { increment: 1 } } }).catch(() => {})
    }
  }
  const expired = await expireRaastIntents()
  return { processed, reset: reset.count, expired }
}

/** When the CEO last switched SMS matching on (settings.smsOnSince), or null. */
function smsOnSinceOf(raw: unknown): Date | null {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)['smsOnSince'] : null
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export interface RaastEscalationStats { unconfirmed: number; unmatched: number }

export async function runRaastEscalations(): Promise<RaastEscalationStats> {
  const now = connectorNow()
  const on = await prisma.posConnector.findMany({ where: { kind: 'raast', enabled: true }, select: { tenantId: true, settings: true } })
  let unconfirmed = 0
  let unmatched = 0
  for (const c of on) {
    const { settings } = await raastConnectorTx(prisma, c.tenantId)
    // Only receipts recorded while SMS matching was on, and in the last day.
    const floor = Math.max(now.getTime() - 86_400_000, smsOnSinceOf(c.settings)?.getTime() ?? 0)

    const late = await prisma.raastReceipt.findMany({
      where: {
        tenantId: c.tenantId, status: 'provisional', confirmedVia: 'cashier', smsAlertId: null, flaggedAt: null,
        confirmedAt: { lt: new Date(now.getTime() - settings.smsConfirmMin * 60_000), gte: new Date(floor) },
      },
      take: 100,
    })
    for (const r of late) {
      const claim = await prisma.raastReceipt.updateMany({ where: { id: r.id, flaggedAt: null, smsAlertId: null }, data: { flaggedAt: now } })
      if (claim.count === 0) continue
      const f = await raiseRaastFlagTx(prisma, {
        tenantId: r.tenantId, kind: 'raast_unconfirmed', severity: 'high',
        title: `No bank SMS for Raast ${pkr(r.amountCents)} on bill #${orderRefOf(r.orderId)}`,
        description: `The cashier recorded a Raast payment (ref ${r.bankRef ?? '—'}) ${settings.smsConfirmMin}+ minutes ago but no bank SMS has confirmed it. Check the counter phone and the bank — the reference may be mistyped, or the money may not have arrived.`,
        entityType: 'RaastReceipt', entityId: r.id, conceptId: r.conceptId, amountCents: r.amountCents,
        metadata: { orderId: r.orderId, bankRef: r.bankRef ?? null, confirmedById: r.confirmedById ?? null },
      })
      unconfirmed++
      if (f.created) void notifyConnectorPeople(r.tenantId, 'raast_floor', `servd: no bank SMS has confirmed the Raast payment on bill #${orderRefOf(r.orderId)} (${pkr(r.amountCents)}). Check the counter phone.`)
    }

    const old = await prisma.bankSmsAlert.findMany({
      where: {
        tenantId: c.tenantId, kind: 'credit', status: { in: ['unmatched', 'ambiguous'] }, alertedAt: null,
        receivedAt: { lt: new Date(now.getTime() - settings.unmatchedAlertEscalateMin * 60_000) },
      },
      take: 100,
    })
    for (const a of old) {
      const claim = await prisma.bankSmsAlert.updateMany({ where: { id: a.id, alertedAt: null, status: { in: ['unmatched', 'ambiguous'] } }, data: { alertedAt: now } })
      if (claim.count === 0) continue
      const amount = toCents(a.amountCents) ?? 0
      const f = await raiseRaastFlagTx(prisma, {
        tenantId: a.tenantId, kind: 'raast_sms_unmatched', severity: 'medium',
        title: `Bank transfer of ${pkr(amount)} not matched to a bill`,
        description: `A Raast credit (ref ${a.bankRef ?? '—'}${a.payer ? `, from ${a.payer}` : ''}) arrived ${settings.unmatchedAlertEscalateMin}+ minutes ago and no bill has claimed it. Attach it to its bill at the till, or a manager marks it "not a sale".`,
        entityType: 'BankSmsAlert', entityId: a.id, amountCents: amount,
        metadata: { bankRef: a.bankRef ?? null, bankAccountId: a.bankAccountId ?? null, status: a.status },
      })
      unmatched++
      if (f.created) {
        void notifyConnectorPeople(a.tenantId, 'raast_finance', `servd: a Raast transfer of ${pkr(amount)} has not been matched to a bill.`)
        void notifyConnectorPeople(a.tenantId, 'raast_floor', `servd: a Raast transfer of ${pkr(amount)} has not been matched to a bill — attach it at the till.`)
      }
    }
  }
  return { unconfirmed, unmatched }
}

/** Retention: SMS text is dropped after 90 days (unparsed after 30). Parsed fields stay. */
export async function runRaastRetention(): Promise<number> {
  const now = connectorNow()
  const a = await prisma.bankSmsAlert.updateMany({ where: { body: { not: null }, receivedAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } }, data: { body: null } })
  const b = await prisma.bankSmsAlert.updateMany({ where: { body: { not: null }, status: 'unparsed', receivedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } }, data: { body: null } })
  return a.count + b.count
}
