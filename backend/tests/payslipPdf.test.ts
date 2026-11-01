// The payslip PDF's words (owner, 2026-11-01: "PKR 115,074 — One Hundred Fifteen Thousand Seventy-Four Rupees Only").
import { describe, it, expect } from 'vitest'
import { rupeesInWords, pkr, monthTitle } from '../src/modules/hr/payslipPdf.js'

describe('payslip PDF text', () => {
  it('writes the net in words and figures', () => {
    expect(rupeesInWords(11507400)).toBe('One Hundred Fifteen Thousand Seventy-Four Rupees Only')
    expect(rupeesInWords(0)).toBe('Zero Rupees Only')
    expect(rupeesInWords(100000000)).toBe('One Million Rupees Only')
    expect(rupeesInWords(1234567)).toBe('Twelve Thousand Three Hundred Forty-Six Rupees Only')
    expect(pkr(11507400)).toBe('115,074')
    expect(pkr(-5000)).toBe('-50')
    expect(monthTitle('2026-10')).toBe('October 2026')
  })
})

// Owner, 2026-11-01 (Anusha / Danish): allowances typed in rounded rupees that add up to a rupee more than
// gross − basic still break down; the largest gives back the rounding. A real mismatch stays one line.
import { salaryBreakup } from '../src/modules/hr/payslipBreakup.js'
describe('allowance breakdown and rounding', () => {
  const slip = (gross: number) => ({ lines: [{ kind: 'earning', code: 'salary', label: 'Salary', amountCents: gross }], inputs: null, earningsCents: gross, eobiEmployeeCents: 0, netCents: gross })
  const data = (rows: Array<[string, number]>) => ({ allowances: rows.map(([name, rs]) => ({ name, amountCents: rs * 100 })) })
  it('a rupee over is rounding: each allowance shows, the total is the salary', () => {
    const k = salaryBreakup(slip(16_000_000), { basicSalaryCents: 11_851_900, data: data([['House Rent Allowance', 23_704], ['Fuel Allowance', 5_926], ['Medical Allowance', 11_852]]) })
    expect(k.allowances.map((a) => a.name)).toEqual(['House Rent Allowance', 'Fuel Allowance', 'Medical Allowance'])
    expect(k.allowances.reduce((a, x) => a + x.cents, 0)).toBe(4_148_100)
    expect(k.allowances[0]!.cents).toBe(2_370_300)
  })
  it('far more than the salary leaves room for: one Allowances line', () => {
    const k = salaryBreakup(slip(16_000_000), { basicSalaryCents: 11_851_900, data: data([['House Rent Allowance', 50_000]]) })
    expect(k.allowances).toEqual([{ name: 'Allowances', cents: 4_148_100 }])
  })
})
