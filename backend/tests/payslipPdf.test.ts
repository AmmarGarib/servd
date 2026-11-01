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
