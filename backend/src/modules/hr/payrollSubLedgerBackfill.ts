// The per-employee wages sub-ledger for payroll already on the books (owner,
// 2026-10-23). ONE time per company (Setting `subAccounts.payrollBackfilledAt:
// <tenantId>`), at boot: every employee gets a wages sub-account under their
// department's wages account and 2020, then every posted payroll run and full &
// final is tagged from its payslips / settlement exactly as a new posting is
// (hr/ledger.ts tagPayrollRunTx / tagSettlementTx). Journal lines, amounts and
// dates are never touched — tags only. An entry whose payslip figures do not
// add up to its lines is left untagged and flagged ONCE
// (sub_account_backfill_mismatch). Re-running finds everything tagged already.

import { serviceClient as prisma } from '../../lib/prisma.js'
import { ACCT } from '../accounting/journal.js'
import { ensureEmployeeSubAccountTx } from '../../lib/subAccounts.js'
import { tagPayrollRunTx, tagSettlementTx, wageAccountFor, FNF_ACCRUAL } from './ledger.js'

export const payrollBackfillKey = (tenantId: string) => `subAccounts.payrollBackfilledAt:${tenantId}`

export interface BackfillResult { tenantId: string; employees: number; runs: number; settlements: number; mismatched: string[] }

export async function backfillPayrollSubLedger(opts: { tenantIds?: string[]; force?: boolean } = {}): Promise<BackfillResult[]> {
  const tenants = await prisma.tenant.findMany({ where: opts.tenantIds ? { id: { in: opts.tenantIds } } : {}, select: { id: true } })
  const out: BackfillResult[] = []
  for (const { id: tenantId } of tenants) {
    if (!opts.force && await prisma.setting.findUnique({ where: { key: payrollBackfillKey(tenantId) } })) continue
    const res: BackfillResult = { tenantId, employees: 0, runs: 0, settlements: 0, mismatched: [] }

    // Every employee's buckets (wages account of their department + wages payable).
    const accounts = await prisma.account.findMany({ where: { tenantId }, select: { id: true, code: true } })
    const accountOf = new Map(accounts.map((a) => [a.code, a.id]))
    const emps = await prisma.hrEmployee.findMany({ where: { tenantId }, select: { id: true, fullName: true, employeeCode: true, departmentId: true } })
    const depts = await prisma.department.findMany({ where: { id: { in: [...new Set(emps.map((e) => e.departmentId).filter((d): d is string => !!d))] } }, select: { id: true, name: true } })
    const deptName = new Map(depts.map((d) => [d.id, d.name]))
    for (const e of emps) {
      for (const code of [wageAccountFor(e.departmentId ? deptName.get(e.departmentId) : null), ACCT.WAGES_PAYABLE]) {
        const accountId = accountOf.get(code)
        if (accountId) await ensureEmployeeSubAccountTx(prisma, tenantId, accountId, e)
      }
      res.employees++
    }

    const runRefs = await prisma.journalEntry.findMany({ where: { tenantId, reference: { startsWith: 'hr.payroll.accrual:' } }, select: { reference: true } })
    for (const r of runRefs) {
      const runId = r.reference!.slice('hr.payroll.accrual:'.length)
      const t = await prisma.$transaction((tx) => tagPayrollRunTx(tx, runId), { timeout: 60_000 })
      res.runs++
      res.mismatched.push(...t.mismatched)
    }
    const fnfRefs = await prisma.journalEntry.findMany({ where: { tenantId, reference: { startsWith: `${FNF_ACCRUAL}:` } }, select: { reference: true } })
    for (const r of fnfRefs) {
      const recId = r.reference!.slice(FNF_ACCRUAL.length + 1)
      const t = await prisma.$transaction((tx) => tagSettlementTx(tx, recId), { timeout: 60_000 })
      res.settlements++
      res.mismatched.push(...t.mismatched)
    }

    if (res.mismatched.length) {
      const { flagException } = await import('../../lib/exceptions.js')
      for (const m of res.mismatched) {
        const [reference, code] = m.split('#')
        const entry = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, select: { id: true } })
        await flagException({
          tenantId, kind: 'sub_account_backfill_mismatch', severity: 'low',
          title: `Payroll entry ${reference} left without employee tags on ${code}`,
          description: `The payslip / settlement figures do not add up to the ${code} line of ${reference}, so its per-employee wages sub-ledger was not filled. The books are unchanged; tag the line by hand in Accounting → Journals if needed.`,
          entityType: 'JournalEntry', entityId: entry?.id, metadata: { reference, code },
        })
      }
    }
    const now = new Date().toISOString()
    await prisma.setting.upsert({ where: { key: payrollBackfillKey(tenantId) }, create: { key: payrollBackfillKey(tenantId), value: now }, update: { value: now } })
    out.push(res)
  }
  return out
}
