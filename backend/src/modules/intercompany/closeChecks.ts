// Inter-company items on the period-close checklist (accounting/closeChecks.ts
// lists these in CLOSE_CHECKS — closeCheckTypes.ts is the contract).
//
//   intercompany_pending    block (overridable)  transfers dated in the close still waiting for the CEO
//   fleet_recharge          block (overridable)  ended months in the close with shared-fleet trips and a
//                                                rate above zero but no charge — fix: POST
//                                                /accounting/intercompany/fleet/charge (Charge now)
//   fleet_no_rate           warn                 trips in the close with no rate set (nothing can be charged)
//   intercompany_mismatch   warn                 the two books of a pair disagree at the close
//   intercompany_unsettled  warn                 a pair balance still open at the close (H30: settled monthly)
//   control_tieout          warn                 2050 / 2060 / 2080 disagree with their subledgers
//
// Every check is about ctx.tenantId. The fleet and mismatch checks read the
// pair's other side only as far as the pair itself (its fleet agreement, its
// Due from / Due to accounts) — never the other company's other data.

import type { CloseCheck, CloseCheckContext, CloseProblem } from '../accounting/closeCheckTypes.js'
import { toCents } from '../../lib/money.js'
import { counterpartiesOf, pairBalances } from './accounts.js'
import { fleetMonths, isMonthEnded, monthLabel } from './fleet.js'
import { controlTieOut } from './legacy.js'

const LINK = '/accounting/intercompany'
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The close's months whose last day is inside it (a month the close cuts through is charged later). */
function endedMonthsInClose(ctx: CloseCheckContext): string[] {
  return ctx.months.filter((m) => isMonthEnded(m, new Date(ctx.newLock.getTime() + 1)))
}

async function agreementsOf(ctx: CloseCheckContext) {
  return ctx.db.fleetAgreement.findMany({
    where: { OR: [{ providerTenantId: ctx.tenantId }, { clientTenantId: ctx.tenantId }] },
    select: { id: true, providerTenantId: true, clientTenantId: true },
  })
}

const pending: CloseCheck = {
  key: 'intercompany_pending',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const rows = await ctx.db.intercompanyTransfer.findMany({
      where: {
        status: 'submitted',
        entryDate: { lte: ctx.newLock },
        OR: [{ tenantId: ctx.tenantId }, { counterpartyTenantId: ctx.tenantId }],
      },
      select: { amountCents: true },
    })
    if (rows.length === 0) return null
    const cents = rows.reduce((s, r) => s + toCents(r.amountCents), 0)
    return {
      key: 'intercompany_pending', severity: 'block', overridable: true,
      title: 'Inter-company transfers waiting for the CEO',
      detail: `${rows.length} transfer${rows.length === 1 ? '' : 's'} (${pkr(cents)}) dated in this close still wait for approval. Approve or reject them first — once the month is closed they cannot post on their date.`,
      count: rows.length, cents, link: `${LINK}?tab=transfers`,
    }
  },
}

const fleetRecharge: CloseCheck = {
  key: 'fleet_recharge',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const months = endedMonthsInClose(ctx)
    if (months.length === 0) return null
    const due: Array<{ month: string; cents: number }> = []
    for (const ag of await agreementsOf(ctx)) {
      for (const m of await fleetMonths(ctx.db, ag, months, new Date())) {
        if (m.status === 'due') due.push({ month: m.month, cents: m.amountCents })
      }
    }
    if (due.length === 0) return null
    const cents = due.reduce((s, d) => s + d.cents, 0)
    const list = Array.from(new Set(due.map((d) => d.month))).sort()
    return {
      key: 'fleet_recharge', severity: 'block', overridable: true,
      title: 'Shared-fleet trips not charged',
      detail: `Rider trips of ${list.map(monthLabel).join(', ')} (${pkr(cents)}) are not charged between the companies yet. Charge them so both companies' rider cost is right.`,
      count: due.length, cents, months: list, link: `${LINK}?tab=fleet`,
      fix: { method: 'POST', path: '/accounting/intercompany/fleet/charge', label: 'Charge now' },
    }
  },
}

const fleetNoRate: CloseCheck = {
  key: 'fleet_no_rate',
  severity: 'warn',
  overridable: true,
  async run(ctx) {
    const months = endedMonthsInClose(ctx)
    if (months.length === 0) return null
    let trips = 0
    const list = new Set<string>()
    for (const ag of await agreementsOf(ctx)) {
      for (const m of await fleetMonths(ctx.db, ag, months, new Date())) {
        if (m.status === 'no_rate') { trips += m.trips; list.add(m.month) }
      }
    }
    if (trips === 0) return null
    const ms = Array.from(list).sort()
    return {
      key: 'fleet_no_rate', severity: 'warn', overridable: true,
      title: 'Shared-fleet trips with no rate',
      detail: `${trips} trip${trips === 1 ? '' : 's'} by another company's riders (or for another company) in ${ms.map(monthLabel).join(', ')} have no per-trip rate, so nothing is charged. The CEO sets the rate on Inter-company → Shared fleet (0 = not charged).`,
      count: trips, months: ms, link: `${LINK}?tab=fleet`,
    }
  },
}

async function pairs(ctx: CloseCheckContext) {
  const out: Array<{ other: string; b: Awaited<ReturnType<typeof pairBalances>> }> = []
  for (const other of await counterpartiesOf(ctx.db, ctx.tenantId)) {
    out.push({ other, b: await pairBalances(ctx.db, ctx.tenantId, other, ctx.newLock) })
  }
  return out
}

const mismatch: CloseCheck = {
  key: 'intercompany_mismatch',
  severity: 'warn',
  overridable: true,
  async run(ctx) {
    const bad = (await pairs(ctx)).filter((p) => p.b.mismatchCents !== 0)
    if (bad.length === 0) return null
    const cents = bad.reduce((s, p) => s + p.b.mismatchCents, 0)
    return {
      key: 'intercompany_mismatch', severity: 'warn', overridable: true,
      title: "Inter-company balances don't agree",
      detail: `With ${bad.length} compan${bad.length === 1 ? 'y' : 'ies'}, what this company says it owes or is owed differs from the other company's books by ${pkr(cents)} in total. Every inter-company posting moves both books, so look for a hand entry or a reversal in one book only.`,
      count: bad.length, cents, link: `${LINK}?tab=balances`,
    }
  },
}

const unsettled: CloseCheck = {
  key: 'intercompany_unsettled',
  severity: 'warn',
  overridable: true,
  async run(ctx) {
    const open = (await pairs(ctx)).filter((p) => p.b.aDueFromB !== 0 || p.b.aDueToB !== 0)
    if (open.length === 0) return null
    const cents = open.reduce((s, p) => s + Math.abs(p.b.netOwedByA), 0)
    return {
      key: 'intercompany_unsettled', severity: 'warn', overridable: true,
      title: 'Inter-company balances not settled',
      detail: `Balances with ${open.length} compan${open.length === 1 ? 'y' : 'ies'} are open at the close (net ${pkr(cents)}). The default is to settle them monthly by bank, or net the two directions.`,
      count: open.length, cents, link: `${LINK}?tab=balances`,
    }
  },
}

const tieOut: CloseCheck = {
  key: 'control_tieout',
  severity: 'warn',
  overridable: true,
  async run(ctx): Promise<CloseProblem | null> {
    const t = await controlTieOut(ctx.db, ctx.tenantId, ctx.newLock)
    const off = t.rows.filter((r) => r.differenceCents !== 0)
    if (off.length === 0) return null
    const cents = off.reduce((s, r) => s + Math.abs(r.differenceCents), 0)
    return {
      key: 'control_tieout', severity: 'warn', overridable: true,
      title: 'Wallets, loyalty or gift cards disagree with the ledger',
      detail: off.map((r) => `${r.code} ${r.label}: ledger ${pkr(r.ledgerCents)} vs ${pkr(r.subledgerCents)}`).join('; ')
        + '. Pre-launch cross-company residue can be written off once (Inter-company → Tie-out & legacy); anything later is a real difference to find.',
      count: off.length, cents, link: `${LINK}?tab=tieout`,
    }
  },
}

/** The inter-company checks, in the order the checklist shows them. */
export const intercompanyCloseChecks: CloseCheck[] = [pending, fleetRecharge, fleetNoRate, mismatch, unsettled, tieOut]
