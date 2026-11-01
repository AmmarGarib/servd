// The payslip's particulars (owner, 2026-10-31: "let's build Payslip now"), printed above the salary breakup
// (payslipBreakup.ts). The uploaded header picture was removed (owner, 2026-11-01: "remove the GS header") — the
// PDF (payslipPdf.ts) prints the company name in text.
//
// Particulars: employee name, employee ID, date of joining, department, designation, employment type, CNIC,
// days in the month and paid days.

import { prisma } from '../../lib/prisma.js'
import { employeeLabels } from './service.js'
import type { HrEmployee } from '@prisma/client'

export interface PayslipParticulars {
  employeeName: string
  employeeCode: string
  joiningDate: string | null
  department: string | null
  designation: string | null
  employmentType: string | null
  cnic: string | null
  monthDays: number | null
  paidDays: number | null
}

type Emp = Pick<HrEmployee, 'fullName' | 'employeeCode' | 'joiningDate' | 'departmentId' | 'designationId' | 'gradeId' | 'locationId' | 'managerId' | 'employmentType' | 'cnic'>
export const PARTICULAR_FIELDS = {
  fullName: true, employeeCode: true, joiningDate: true, departmentId: true, designationId: true, gradeId: true,
  locationId: true, managerId: true, employmentType: true, cnic: true,
} as const

const TYPE_LABEL: Record<string, string> = { permanent: 'Permanent', probation: 'Probation', contract: 'Contract', temporary: 'Temporary', intern: 'Intern' }

/** The particulars of each payslip, by the employee's own company (names resolved in one pass). */
export async function payslipParticulars(tenantId: string, slips: Array<{ id: string; inputs: unknown; employee: Emp }>): Promise<Map<string, PayslipParticulars>> {
  const label = await employeeLabels(tenantId, slips.map((s) => s.employee))
  const out = new Map<string, PayslipParticulars>()
  for (const s of slips) {
    const e = s.employee
    const b = ((s.inputs as Record<string, unknown> | null)?.['payBasis'] ?? null) as Record<string, number> | null
    out.set(s.id, {
      employeeName: e.fullName,
      employeeCode: e.employeeCode,
      joiningDate: e.joiningDate ? e.joiningDate.toISOString().slice(0, 10) : null,
      department: label(e.departmentId),
      designation: label(e.designationId),
      employmentType: e.employmentType ? TYPE_LABEL[e.employmentType] ?? e.employmentType : null,
      cnic: e.cnic ?? null,
      monthDays: typeof b?.['daysInMonth'] === 'number' ? b['daysInMonth'] : null,
      paidDays: typeof b?.['paidDays'] === 'number' ? b['paidDays'] : null,
    })
  }
  return out
}
