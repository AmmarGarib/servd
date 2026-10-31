// The printed payslip (owner, 2026-10-31: "let's build Payslip now"): the company's header image and the
// particulars printed above the salary breakup (payslipBreakup.ts).
//
// Header: ONE image per company (owner: "Paste this Logo as header of Payslip"), uploaded by HR in HR → Settings,
// kept as a data URL in Setting `hr.payslipHeader:<tenantId>` — apart from the HR settings row, which is read on
// every request. A payslip always prints its OWN company's header, never another company's.
//
// Particulars: employee name, employee ID, date of joining, department, designation, employment type, CNIC,
// days in the month and paid days.

import { prisma } from '../../lib/prisma.js'
import { decodeEvidenceFile } from '../../lib/evidenceFile.js'
import { AppError } from '../../lib/errors.js'
import { employeeLabels } from './service.js'
import type { HrEmployee } from '@prisma/client'

export const PAYSLIP_HEADER_MAX_BYTES = 600 * 1024
const headerKey = (tenantId: string) => `hr.payslipHeader:${tenantId}`

export async function getPayslipHeader(tenantId: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: headerKey(tenantId) } })
  return row?.value && row.value.startsWith('data:image/') ? row.value : null
}

/** Checks the image (JPEG / PNG / WebP, magic bytes must agree) and stores it for the company. */
export async function setPayslipHeader(tenantId: string, dataBase64: string, mime: string): Promise<string> {
  let file
  try {
    file = decodeEvidenceFile(dataBase64, mime, { maxBytes: PAYSLIP_HEADER_MAX_BYTES })
  } catch (e) {
    if (e instanceof AppError && /larger|too large/i.test(e.message)) throw new AppError('HEADER_TOO_LARGE', 'The header image is over 600 KB — save it smaller and upload it again', 400)
    throw e
  }
  if (!file.mime.startsWith('image/')) throw new AppError('HEADER_NOT_IMAGE', 'Upload the header as a picture (PNG, JPEG or WebP)', 400)
  const value = `data:${file.mime};base64,${file.bytes.toString('base64')}`
  await prisma.setting.upsert({ where: { key: headerKey(tenantId) }, create: { key: headerKey(tenantId), value }, update: { value } })
  return value
}

export async function clearPayslipHeader(tenantId: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: headerKey(tenantId) } })
}

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
