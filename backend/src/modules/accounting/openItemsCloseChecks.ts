// Month close: documents still open in the period (owner, 2026-11-01: "Every uncompleted/Opened voucher, unbalanced
// accounts, Payroll in process and other standard missing requirements to close the monthly books should raise
// warning and block the month and finance should have access to close those issues with a notification to CEO").
//
// Extends the ONE checklist (closeChecks.ts CLOSE_CHECKS). Payroll in process is the existing `payroll` check
// (hr/closeChecks.ts: no run, not locked — draft / with finance / approved — or not on the books); the trial balance
// is `trial_balance`; vouchers still held on 1357 / documents not checked are their own checks. These add:
//   vouchers_open            cash vouchers raised in the period and not finished (waiting, returned, approved unpaid)
//   journal_requests_open    journal requests / changes waiting for a decision, dated in the period
//   shift_corrections_open   shift corrections not applied (waiting for the CEO, approved but not run, failed)
//   supplier_bills_draft     supplier bills dated in the period still in draft (not on the books)
//   clearing_accounts        clearing / suspense accounts not at zero at the lock
// All block; the CEO may close over them with a reason (overridable). Every query is the company's own.

import type { CloseCheck } from './closeCheckTypes.js'
import { fmtPktDate } from './dates.js'
import { fmtPkrCents as pkr } from '../../lib/money.js'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const listed = (xs: string[], total: number) => xs.join(', ') + (total > xs.length ? ` and ${total - xs.length} more` : '')

/** Cash voucher statuses that are not finished: waiting for finance / the CEO, sent back, or approved but not paid. */
export const OPEN_VOUCHER_STATUSES = ['draft', 'hod_signed', 'submitted', 'finance_approved', 'returned', 'approved'] as const

const vouchersOpenCheck: CloseCheck = {
  key: 'vouchers_open',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const where = { tenantId: ctx.tenantId, status: { in: [...OPEN_VOUCHER_STATUSES] }, createdAt: { lte: ctx.newLock } }
    const [rows, agg] = await Promise.all([
      ctx.db.cashVoucher.findMany({ where, select: { id: true, number: true }, orderBy: { seq: 'asc' }, take: 5 }),
      ctx.db.cashVoucher.aggregate({ where, _count: { _all: true }, _sum: { amountCents: true } }),
    ])
    const count = agg._count._all
    if (count === 0) return null
    const cents = agg._sum.amountCents ?? 0
    return {
      key: 'vouchers_open',
      severity: 'block',
      title: 'Cash vouchers not completed',
      detail: `${plural(count, 'cash voucher')} raised on or before ${fmtPktDate(ctx.newLock)} (${pkr(cents)}: ${listed(rows.map((r) => r.number), count)}) ${count === 1 ? 'is' : 'are'} still open — waiting for approval, sent back for correction, or approved and not paid. `
        + 'Pay, reject or cancel each one in Finance → Cash vouchers before closing.',
      count,
      cents,
      link: rows.length === 1 && count === 1 ? `/finance/cash-vouchers/${rows[0]!.id}` : '/finance/cash-vouchers',
      overridable: true,
    }
  },
}

const journalRequestsOpenCheck: CloseCheck = {
  key: 'journal_requests_open',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const where = {
      tenantId: ctx.tenantId, status: { in: ['draft', 'submitted', 'returned'] },
      OR: [{ entryDate: { lte: ctx.newLock } }, { entryDate: null, createdAt: { lte: ctx.newLock } }],
    }
    const count = await ctx.db.journalRequest.count({ where })
    if (count === 0) return null
    return {
      key: 'journal_requests_open',
      severity: 'block',
      title: 'Journal requests waiting',
      detail: `${plural(count, 'journal request')} (new entries or changes to entries) dated on or before ${fmtPktDate(ctx.newLock)} ${count === 1 ? 'is' : 'are'} not decided. `
        + 'Post, withdraw or reject each one on Accounting → Journal before closing.',
      count,
      link: '/accounting/journal?tab=requests',
      overridable: true,
    }
  },
}

const shiftCorrectionsOpenCheck: CloseCheck = {
  key: 'shift_corrections_open',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const count = await ctx.db.shiftCorrection.count({
      where: { tenantId: ctx.tenantId, status: { in: ['submitted', 'draft', 'approved', 'failed'] }, shift: { openedAt: { lte: ctx.newLock } } },
    })
    if (count === 0) return null
    return {
      key: 'shift_corrections_open',
      severity: 'block',
      title: 'Shift corrections not finished',
      detail: `${plural(count, 'shift correction')} on drawers opened on or before ${fmtPktDate(ctx.newLock)} ${count === 1 ? 'is' : 'are'} waiting for the CEO, approved but not applied, or failed. `
        + 'Have it decided (or retried) in Finance → Shift corrections before closing.',
      count,
      link: '/finance/shift-corrections',
      overridable: true,
    }
  },
}

const supplierBillsDraftCheck: CloseCheck = {
  key: 'supplier_bills_draft',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const where = { status: 'draft', billDate: { lte: ctx.newLock }, supplier: { tenantId: ctx.tenantId } }
    const agg = await ctx.db.supplierBill.aggregate({ where, _count: { _all: true }, _sum: { totalCents: true } })
    const count = agg._count._all
    if (count === 0) return null
    const cents = Number(agg._sum.totalCents ?? 0)
    return {
      key: 'supplier_bills_draft',
      severity: 'block',
      title: 'Supplier bills still in draft',
      detail: `${plural(count, 'supplier bill')} dated on or before ${fmtPktDate(ctx.newLock)} (${pkr(cents)}) ${count === 1 ? 'is' : 'are'} still a draft, so ${count === 1 ? 'it is' : 'they are'} not on the books. Book or void each one before closing.`,
      count,
      cents,
      link: '/procurement?tab=bills',
      overridable: true,
    }
  },
}

// Accounts that must be zero at every month end. Clearing / suspense accounts with their own check or a normal
// balance are left out: 1110 / 1115 (receivables, till clearing), 1290 (stock differences — its own check),
// 1357 (vouchers held — its own check), 2015 (received not billed — grni_stale).
const CLEARING_ALWAYS = ['1395']
const CLEARING_SKIP = new Set(['1110', '1115', '1290', '1357', '2015'])

const clearingAccountsCheck: CloseCheck = {
  key: 'clearing_accounts',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const accounts = await ctx.db.account.findMany({
      where: {
        tenantId: ctx.tenantId,
        OR: [{ code: { in: CLEARING_ALWAYS } }, { name: { contains: 'clearing', mode: 'insensitive' } }, { name: { contains: 'suspense', mode: 'insensitive' } }],
      },
      select: { id: true, code: true, name: true },
    })
    const watch = accounts.filter((a) => !CLEARING_SKIP.has(a.code))
    if (watch.length === 0) return null
    const sums = await ctx.db.journalLine.groupBy({
      by: ['accountId', 'type'],
      where: { accountId: { in: watch.map((a) => a.id) }, journalEntry: { tenantId: ctx.tenantId, entryDate: { lte: ctx.newLock } } },
      _sum: { amountCents: true },
    })
    const bal = new Map<string, number>()
    for (const s of sums) bal.set(s.accountId, (bal.get(s.accountId) ?? 0) + (s.type === 'debit' ? 1 : -1) * Number(s._sum.amountCents ?? 0))
    const off = watch.filter((a) => (bal.get(a.id) ?? 0) !== 0).sort((a, b) => a.code.localeCompare(b.code))
    if (off.length === 0) return null
    const cents = off.reduce((t, a) => t + Math.abs(bal.get(a.id)!), 0)
    return {
      key: 'clearing_accounts',
      severity: 'block',
      title: 'Clearing accounts not at zero',
      detail: `${off.map((a) => `${a.code} ${a.name} (${pkr(bal.get(a.id)!)} ${bal.get(a.id)! > 0 ? 'Dr' : 'Cr'})`).join('; ')} ${off.length === 1 ? 'is' : 'are'} not at zero on ${fmtPktDate(ctx.newLock)}. `
        + 'A clearing account must be empty at month end — find the entry that left it and clear it with a journal dated in the period.',
      count: off.length,
      cents,
      link: off.length === 1 ? `/accounting/journal?tab=accounts&accountId=${off[0]!.id}` : '/accounting/trial-balance',
      overridable: true,
    }
  },
}

export const openItemsCloseChecks: CloseCheck[] = [
  vouchersOpenCheck, journalRequestsOpenCheck, shiftCorrectionsOpenCheck, supplierBillsDraftCheck, clearingAccountsCheck,
]
