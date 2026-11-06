// Intern Management (owner, 2026-11-06) — HR → Interns. Types and helpers shared by the intern screens.
// The contract is the header of backend/src/modules/hr/interns.ts (paths, bodies, codes); money is paisa.

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from './api'

export type InternStatus = 'draft' | 'pending_approval' | 'active' | 'completed' | 'terminated'
export type AttendanceStatus = 'present' | 'absent' | 'late' | 'half_day' | 'leave' | 'weekly_off'
export type RunStatus = 'draft' | 'finance_review' | 'finance_checked' | 'approved' | 'paid'

export interface InternLookups {
  departments: Array<{ id: string; name: string; tenantId: string | null }>
  supervisors: Array<{ id: string; fullName: string; employeeCode: string; tenantId: string; designation: string | null }>
  statuses: InternStatus[]
  statusLabels: Record<string, string>
  attendanceStatuses: AttendanceStatus[]
  attendanceLabels: Record<string, string>
  weekdays: Array<{ value: number; label: string }>
  certificateStatusLabels: Record<string, string>
}

export function useInternLookups() {
  return useQuery({ queryKey: ['intern-lookups'], queryFn: () => api.get<InternLookups>('/hr/interns/lookups'), staleTime: 60_000 })
}

export interface InternRow {
  id: string; tenantId: string; internCode: string; fullName: string; fatherName: string | null; cnic: string | null
  dateOfBirth: string | null; gender: string | null; phone: string | null; email: string | null; address: string | null
  emergencyContactName: string | null; emergencyContactPhone: string | null
  institution: string | null; degree: string | null; fieldOfStudy: string | null; semester: string | null; studentRegNo: string | null
  departmentId: string | null; designation: string | null; supervisorEmployeeId: string | null
  startDate: string; endDate: string | null; internshipType: 'paid' | 'unpaid'; monthlyStipendCents: number
  workingDays: number[]; workingHours: string | null
  status: InternStatus; rejectionNote: string | null; terminationReason: string | null; terminationEffectiveDate: string | null
  completedOn: string | null; performanceRemarks: string | null; userId: string | null
  statusLabel: string; department: string | null
  supervisor: { id: string; fullName: string; employeeCode: string } | null
  lastDay: string | null; loginLinked: boolean
  certificateStatus: string; certificateStatusLabel: string; certificateNumber: string | null
}

export interface InternEvent {
  id: string; kind: string; note: string | null; before: unknown; after: unknown; effectiveDate: string | null
  actorId: string | null; actorName: string | null; createdAt: string
}
export interface InternCertificate {
  id: string; number: string; status: string; remarks: string | null; issuedAt: string | null; reissueOfId: string | null
  reissueReason: string | null; supersededAt: string | null; createdAt: string
}
export interface DayMark { status: AttendanceStatus; checkIn: string | null; checkOut: string | null; note: string | null; source: string }
export interface MonthAttendance { month: string; days: Record<string, DayMark>; summary: Record<string, number> }

export interface InternDetail extends InternRow {
  login: { id: string; name: string; email: string | null; role: string } | null
  events: InternEvent[]
  certificates: InternCertificate[]
  stipends: Array<{ slipId: string; runId: string; period: string; runStatus: string; netCents: number; paidDays: number }>
  attendance: MonthAttendance
}

export const INTERN_BADGE: Record<string, string> = {
  draft: 's-badge-muted', pending_approval: 's-badge-amber', active: 's-badge-green', completed: 's-badge-purple', terminated: 's-badge-red',
}
export const CERT_BADGE: Record<string, string> = { not_issued: 's-badge-muted', generated: 's-badge-amber', issued: 's-badge-green', reissued: 's-badge-purple' }
export const RUN_BADGE: Record<string, string> = {
  draft: 's-badge-muted', finance_review: 's-badge-amber', finance_checked: 's-badge-purple', approved: 's-badge-green', paid: 's-badge-green',
}
export const RUN_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft (HR)', finance_review: 'With finance for review', finance_checked: 'Waiting for the CEO', approved: 'Approved — to pay', paid: 'Paid',
}
export const RUN_STEPS: RunStatus[] = ['draft', 'finance_review', 'finance_checked', 'approved', 'paid']

export const ATTENDANCE_CODE: Record<AttendanceStatus, string> = { present: 'P', absent: 'A', late: 'L', half_day: '½', leave: 'LV', weekly_off: 'WO' }
/** Cell colours by token (never a hard-coded colour). */
export const ATTENDANCE_TONE: Record<AttendanceStatus, string> = {
  present: 'var(--erp-success)', absent: 'var(--erp-danger)', late: 'var(--erp-warning)',
  half_day: 'var(--erp-warning)', leave: 'var(--erp-primary-ink)', weekly_off: 'rgb(var(--fg-rgb) / 0.45)',
}
export const ATTENDANCE_STATUS_ORDER: AttendanceStatus[] = ['present', 'late', 'half_day', 'absent', 'leave', 'weekly_off']
export const ATTENDANCE_FALLBACK_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present', absent: 'Absent', late: 'Late', half_day: 'Half day', leave: 'Leave', weekly_off: 'Weekly off',
}
export const SKIP_REASON: Record<string, string> = {
  NOT_ENROLLED: 'Not an approved intern yet', OUTSIDE_INTERNSHIP: 'Outside the internship', FUTURE: 'A day that has not come',
  NOT_A_WORKING_DAY: 'Not one of the intern’s working days', IN_PAYROLL: 'That month’s stipend payroll has left draft', ALREADY_MARKED: 'Already marked (tick “Replace marked days”)',
}
export const EVENT_LABEL: Record<string, string> = {
  enrolled: 'Enrolled', submitted: 'Submitted for approval', approved: 'Approved', rejected: 'Sent back', edited: 'Details edited',
  extended: 'Internship extended', department_changed: 'Department changed', supervisor_changed: 'Supervisor changed',
  stipend_changed: 'Stipend changed', dates_changed: 'Dates changed', completed: 'Completed', terminated: 'Terminated',
  login_linked: 'Login linked', login_unlinked: 'Login unlinked', certificate_generated: 'Certificate generated',
  certificate_issued: 'Certificate issued', certificate_reissued: 'Certificate re-issued', remarks: 'Supervisor remarks',
}

export const PKT_OFFSET_MS = 5 * 3600_000
/** Today in Karachi, YYYY-MM-DD. */
export const pktToday = () => new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10)
export const thisMonth = () => pktToday().slice(0, 7)
/** An API date (a date or an ISO instant) as YYYY-MM-DD. */
export const ymd = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '')
export const shortDate = (v: string | null | undefined) => {
  const s = ymd(v)
  return s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'
}
export const shortDateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
export const monthLabel = (m: string) =>
  /^\d{4}-\d{2}$/.test(m) ? new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : m
export const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7)
}
export const daysOfMonth = (m: string): string[] => {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`)
}
export const weekdayShort = (d: string) => ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][new Date(`${d}T00:00:00Z`).getUTCDay()]!

/** "3 months, 5 days" between two dates, both included (the server's certificate wording follows the same idea). */
export function durationLabel(start: string, end: string | null | undefined): string {
  const s = ymd(start), e = ymd(end)
  if (!s) return ''
  if (!e) return 'Open-ended'
  const a = new Date(`${s}T00:00:00Z`), b = new Date(`${e}T00:00:00Z`)
  if (b < a) return ''
  const next = new Date(b.getTime() + 86_400_000)
  let months = (next.getUTCFullYear() - a.getUTCFullYear()) * 12 + next.getUTCMonth() - a.getUTCMonth()
  const at = (m: number) => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + m, a.getUTCDate()))
  if (at(months) > next) months--
  const days = Math.round((next.getTime() - at(months).getTime()) / 86_400_000)
  const parts = [months > 0 ? `${months} month${months === 1 ? '' : 's'}` : '', days > 0 ? `${days} day${days === 1 ? '' : 's'}` : ''].filter(Boolean)
  return parts.join(', ') || '1 day'
}

/** Weekday chips run Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** Fields the API names in a rule failure (codes from backend hr/interns.ts) → the form field to mark. */
const CODE_FIELD: Record<string, string> = {
  DEPARTMENT_NOT_IN_COMPANY: 'departmentId', SUPERVISOR_NOT_IN_COMPANY: 'supervisorEmployeeId',
  STIPEND_REQUIRED: 'monthlyStipendCents', STIPEND_ON_UNPAID: 'monthlyStipendCents', BAD_DATES: 'endDate', INTERN_CNIC_EXISTS: 'cnic',
}

/** An API error as a message plus the per-field messages (zod issues carry a path; rule codes map above). */
export function apiErrors(e: unknown): { message: string; fields: Record<string, string> } {
  if (e instanceof ApiError) {
    const fields: Record<string, string> = {}
    if (Array.isArray(e.details)) {
      for (const i of e.details as Array<{ path?: unknown[]; message?: string }>) {
        const k = i.path?.[0]
        if (typeof k === 'string' && !fields[k]) fields[k] = i.message ?? 'Check this value'
      }
    }
    const byCode = CODE_FIELD[e.code]
    if (byCode) fields[byCode] = e.message
    return { message: Object.keys(fields).length ? 'Please fix the marked fields.' : e.message, fields }
  }
  return { message: e instanceof Error ? e.message : 'Something went wrong', fields: {} }
}
export const errText = (e: unknown) => apiErrors(e).message

/** The editable internship form, as text boxes (rupees for the stipend). */
export interface InternFormState {
  fullName: string; fatherName: string; cnic: string; dateOfBirth: string; gender: string; phone: string; email: string; address: string
  emergencyContactName: string; emergencyContactPhone: string
  institution: string; degree: string; fieldOfStudy: string; semester: string; studentRegNo: string
  departmentId: string; designation: string; supervisorEmployeeId: string
  startDate: string; endDate: string; internshipType: 'paid' | 'unpaid'; stipend: number | null; workingDays: number[]; workingHours: string
  performanceRemarks: string
}

export const emptyInternForm = (): InternFormState => ({
  fullName: '', fatherName: '', cnic: '', dateOfBirth: '', gender: '', phone: '', email: '', address: '',
  emergencyContactName: '', emergencyContactPhone: '', institution: '', degree: '', fieldOfStudy: '', semester: '', studentRegNo: '',
  departmentId: '', designation: '', supervisorEmployeeId: '', startDate: pktToday(), endDate: '', internshipType: 'unpaid', stipend: null,
  workingDays: [1, 2, 3, 4, 5, 6], workingHours: '', performanceRemarks: '',
})

export const formFromIntern = (i: InternRow): InternFormState => ({
  fullName: i.fullName, fatherName: i.fatherName ?? '', cnic: i.cnic ?? '', dateOfBirth: ymd(i.dateOfBirth), gender: i.gender ?? '',
  phone: i.phone ?? '', email: i.email ?? '', address: i.address ?? '', emergencyContactName: i.emergencyContactName ?? '',
  emergencyContactPhone: i.emergencyContactPhone ?? '', institution: i.institution ?? '', degree: i.degree ?? '', fieldOfStudy: i.fieldOfStudy ?? '',
  semester: i.semester ?? '', studentRegNo: i.studentRegNo ?? '', departmentId: i.departmentId ?? '', designation: i.designation ?? '',
  supervisorEmployeeId: i.supervisorEmployeeId ?? '', startDate: ymd(i.startDate), endDate: ymd(i.endDate), internshipType: i.internshipType,
  stipend: i.internshipType === 'paid' ? i.monthlyStipendCents / 100 : null, workingDays: [...i.workingDays], workingHours: i.workingHours ?? '',
  performanceRemarks: i.performanceRemarks ?? '',
})

const nul = (s: string) => (s.trim() ? s.trim() : null)

/** Form → API body. `closed` leaves out the internship fields (an ended internship refuses them: 409 INTERN_CLOSED). */
export function bodyFromForm(f: InternFormState, opts: { closed?: boolean } = {}): Record<string, unknown> {
  const personal = {
    fullName: f.fullName.trim(), fatherName: nul(f.fatherName), cnic: nul(f.cnic), dateOfBirth: f.dateOfBirth || null, gender: f.gender || null,
    phone: nul(f.phone), email: nul(f.email), address: nul(f.address), emergencyContactName: nul(f.emergencyContactName),
    emergencyContactPhone: nul(f.emergencyContactPhone), institution: nul(f.institution), degree: nul(f.degree), fieldOfStudy: nul(f.fieldOfStudy),
    semester: nul(f.semester), studentRegNo: nul(f.studentRegNo), performanceRemarks: nul(f.performanceRemarks),
  }
  if (opts.closed) return personal
  return {
    ...personal,
    departmentId: f.departmentId || null, designation: nul(f.designation), supervisorEmployeeId: f.supervisorEmployeeId || null,
    startDate: f.startDate, endDate: f.endDate || null, internshipType: f.internshipType,
    monthlyStipendCents: f.internshipType === 'paid' ? Math.round((f.stipend ?? 0) * 100) : 0,
    workingDays: f.workingDays, workingHours: nul(f.workingHours),
  }
}

/** Client-side checks that mirror the API's; the API's answer still decides. */
export function validateInternForm(f: InternFormState, opts: { closed?: boolean } = {}): Record<string, string> {
  const e: Record<string, string> = {}
  if (f.fullName.trim().length < 2) e['fullName'] = 'Full name is required'
  if (f.cnic.trim() && !/^\d{5}-?\d{7}-?\d$/.test(f.cnic.trim())) e['cnic'] = 'CNIC / B-form as 12345-1234567-1'
  if (f.email.trim() && !/^\S+@\S+\.\S+$/.test(f.email.trim())) e['email'] = 'Enter a valid email'
  if (opts.closed) return e
  if (!f.departmentId) e['departmentId'] = 'Pick the department'
  if (!f.startDate) e['startDate'] = 'Start date is required'
  if (f.startDate && f.endDate && f.endDate < f.startDate) e['endDate'] = 'The end date is before the start date'
  if (f.internshipType === 'paid' && !((f.stipend ?? 0) > 0)) e['monthlyStipendCents'] = 'A paid internship needs a monthly stipend'
  if (f.workingDays.length === 0) e['workingDays'] = 'Pick at least one working day'
  return e
}

export interface DashboardData {
  month: string; total: number; byStatus: Record<string, number>; statusLabels: Record<string, string>
  active: number; paid: number; unpaid: number
  byDepartment: Array<{ departmentId: string | null; name: string; count: number }>
  stipend: { period: string; runs: Array<{ id: string; tenantId: string; status: string }>; runStatus: string; netCents: number }
  certificatesIssued: number; certificatesIssuedThisMonth: number; pendingApproval: number
  endingSoon: Array<{ id: string; internCode: string; fullName: string; endDate: string | null }>
}

export interface ReportData {
  key: string; title: string; period?: string; sectionKey?: string
  columns: Array<{ key: string; label: string; type?: 'cents' | 'number' | string }>
  rows: Array<Record<string, unknown>>
}

export interface Adjustment { id: string; kind: 'addition' | 'deduction'; label: string; amountCents: number; note: string | null }
export interface StipendSlip {
  id: string; runId: string; internId: string; monthlyStipendCents: number; daysInMonth: number; daysEngaged: number
  absentDays: number; halfDays: number; unpaidLeaveDays: number; paidDays: number
  baseCents: number; additionsCents: number; deductionsCents: number; netCents: number; adjustments: Adjustment[] | unknown
  intern: { id: string; internCode: string; fullName: string; department: string | null; designation: string | null; status: string }
}
export interface StipendRun {
  id: string; tenantId: string; period: string; status: RunStatus; statusLabel: string
  totals: { interns?: number; baseCents?: number; additionsCents?: number; deductionsCents?: number; netCents?: number; negativeSlips?: number }
  createdById: string | null; preparedByIds: string[]; sentToFinanceById: string | null
  financeNote: string | null; financeReturnNote: string | null; financeReturnedAt: string | null
  ceoReturnNote: string | null; ceoReturnedAt: string | null
  paidAt: string | null; paidOn: string | null; paymentMethod: string | null; paymentReference: string | null
  people?: Record<string, string | null>
}
export interface StipendRunView extends StipendRun { slips: StipendSlip[] }

export const adjustmentsOf = (s: StipendSlip): Adjustment[] => (Array.isArray(s.adjustments) ? (s.adjustments as Adjustment[]) : [])

/** A supervised intern as GET /hr/my-interns sends it — no stipend, no CNIC. */
export interface SupervisedIntern {
  id: string; internCode: string; fullName: string; department: string | null; designation: string | null; institution: string | null
  startDate: string; endDate: string | null; lastDay: string | null; status: InternStatus; statusLabel: string; internshipType: 'paid' | 'unpaid'
  workingDays: number[]; workingHours: string | null; performanceRemarks: string | null; phone: string | null; email: string | null
}
