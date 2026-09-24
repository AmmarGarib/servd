// Shared HR types and helpers for the admin. Mirrors backend/src/modules/hr/forms.ts.

export type FieldType =
  | 'text' | 'textarea' | 'number' | 'money' | 'percent'
  | 'date' | 'time' | 'datetime'
  | 'select' | 'multiselect' | 'boolean'
  | 'email' | 'phone' | 'file'
  | 'employee' | 'employees' | 'location' | 'department'
  | 'orgunit' | 'record' | 'table'

export const FIELD_TYPES: FieldType[] = [
  'text', 'textarea', 'number', 'money', 'percent', 'date', 'time', 'datetime',
  'select', 'multiselect', 'boolean', 'email', 'phone', 'file',
  'employee', 'employees', 'location', 'department', 'orgunit', 'record', 'table',
]

export const RECORD_SLOTS = ['employeeId', 'startDate', 'endDate', 'effectiveDate', 'quantity', 'amountCents', 'refId', 'category'] as const

export interface HrField {
  key: string
  label: string
  type: FieldType
  required?: boolean
  options?: string[]
  ref?: string
  bind?: string
  group?: string
  help?: string
  columns?: HrField[]
  readOnly?: boolean
  system?: boolean
}

export interface WorkflowStep { key: string; label: string; role: 'hod' | 'hr' | 'management' }

export interface HrFormat {
  section: string
  version: number
  title: string
  fields: HrField[]
  workflow: WorkflowStep[]
  stages: string[]
  isDefault: boolean
}

export interface HrSectionInfo {
  key: string
  specNo: number
  title: string
  group: string
  kind: 'record' | 'page'
  config: boolean
  effect: string | null
  requires: string[]
  format: HrFormat | null
}

export interface Approval { step: string; role: string; decision: 'approved' | 'rejected'; byName: string; at: string; note?: string; override?: boolean }

export interface HrRecord {
  id: string
  tenantId: string
  section: string
  formVersion: number
  employeeId: string | null
  employee?: { id: string; fullName: string; employeeCode: string } | null
  startDate: string | null
  endDate: string | null
  effectiveDate: string | null
  quantity: number | null
  amountCents: number | null
  refId: string | null
  category: string | null
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled'
  stage: string | null
  currentStep: number
  approvals: Approval[]
  data: Record<string, unknown>
  appliedAt: string | null
  createdAt: string
  label?: string
}

export interface Lookups {
  employees: Array<{ id: string; fullName: string; employeeCode: string; status: string }>
  records: Record<string, Array<{ id: string; label: string }>>
}

export interface OrgData {
  units: Array<{ id: string; kind: string; name: string; code: string | null; isActive: boolean }>
  departments: Array<{ id: string; name: string }>
  locations: Array<{ id: string; name: string }>
  kinds: string[]
}

export const rs = (c: number | null | undefined) =>
  c == null ? '—' : `Rs ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

export const human = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—')

export const STATUS_COLOR: Record<string, string> = {
  draft: 'rgba(255,255,255,0.45)', submitted: '#f59e0b', approved: '#34d399', rejected: '#f87171', cancelled: 'rgba(255,255,255,0.3)',
  active: '#34d399', on_leave: '#60a5fa', resigned: '#f59e0b', terminated: '#f87171', separated: 'rgba(255,255,255,0.4)',
  locked: '#34d399',
}

export const ROLE_LABEL: Record<string, string> = { hod: 'Reporting manager', hr: 'HR', management: 'Management' }

// Shared dark styling, matching the other finance / ops pages.
export const card = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' } as const
export const inp = 'w-full rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-kds-green'
export const btn = 'rounded-lg bg-kds-green px-4 py-2 text-sm font-black text-black disabled:opacity-50'
export const btnGhost = 'rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white disabled:opacity-50'

/** Value a field shows in a list or detail view. */
export function displayValue(f: HrField, v: unknown, lk?: { employees?: Lookups['employees']; records?: Lookups['records']; org?: OrgData }): string {
  if (v === null || v === undefined || v === '') return '—'
  switch (f.type) {
    case 'money': return rs(Number(v))
    case 'date': return day(String(v))
    case 'datetime': return new Date(String(v)).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    case 'boolean': return v ? 'Yes' : 'No'
    case 'percent': return `${v}%`
    case 'select': return human(String(v))
    case 'multiselect': return (v as string[]).map(human).join(', ')
    case 'employee': return lk?.employees?.find((e) => e.id === v)?.fullName ?? String(v).slice(0, 8)
    case 'employees': return (v as string[]).map((id) => lk?.employees?.find((e) => e.id === id)?.fullName ?? id.slice(0, 8)).join(', ')
    case 'location': return lk?.org?.locations.find((x) => x.id === v)?.name ?? String(v).slice(0, 8)
    case 'department': return lk?.org?.departments.find((x) => x.id === v)?.name ?? String(v).slice(0, 8)
    case 'orgunit': return lk?.org?.units.find((x) => x.id === v)?.name ?? String(v).slice(0, 8)
    case 'record': return lk?.records?.[f.ref ?? '']?.find((x) => x.id === v)?.label ?? String(v).slice(0, 8)
    case 'table': return `${(v as unknown[]).length} row(s)`
    case 'file': return String(v).split('/').pop() ?? 'file'
    default: return String(v)
  }
}
