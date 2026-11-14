// ── Intern Management (owner, 2026-11-06) in the approvals inbox ────────────
// Three queues, each read AS THE CALLER from the module's own routes, each
// button calling the module's existing route (whose guard decides):
//   intern_enrollment       GET /hr/interns?status=pending_approval   → POST /hr/interns/:id/approve | reject {note}
//   intern_payroll_finance  GET /hr/interns/payroll/runs?status=finance_review  → /finance-pass | /finance-return {note}
//   intern_payroll          GET /hr/interns/payroll/runs?status=finance_checked → /approve | /return {note, to}
// None is ever handed over (lib/approvalRights.ts APPROVAL_RIGHTS).
import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'
import { fmtPkrCents as pkr } from '../../lib/money.js'


interface InternRow {
  id: string; tenantId: string; internCode: string; fullName: string; department: string | null; designation: string | null
  internshipType: string; monthlyStipendCents: number; startDate: string; endDate: string | null; institution: string | null
  supervisor: { fullName: string } | null; createdById: string | null; submittedById: string | null; submittedAt: string | null; createdAt: string
}
interface RunRow {
  id: string; tenantId: string; period: string; status: string; createdById: string | null; preparedByIds: string[]
  sentToFinanceById: string | null; sentToFinanceAt: string | null; financeCheckedAt: string | null; financeNote: string | null
  totals: { interns?: number; baseCents?: number; additionsCents?: number; deductionsCents?: number; netCents?: number } | null
  updatedAt: string
}
const ids = (...v: Array<string | null | undefined | string[]>) => [...new Set(v.flat().filter((x): x is string => !!x))]

const ENROL = APPROVAL_RIGHTS.intern_enrollment
export const internEnrollments: ApprovalProvider = {
  type: 'intern_enrollment',
  label: ENROL.label,
  module: ENROL.queueModule,
  link: '/hr/interns',
  approverRoles: ENROL.roles as readonly UserRole[],
  delegable: ENROL.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: InternRow[] }>('/hr/interns?status=pending_approval')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'intern_enrollment', id: r.id, tenantId: r.tenantId, section: ENROL.section,
      submittedByIds: ids(r.createdById, r.submittedById),
      title: `Intern enrolment — ${r.fullName} (${r.internCode})`,
      subtitle: [r.designation, r.department].filter(Boolean).join(' · ') || null,
      facts: [
        { label: 'Intern', value: `${r.fullName} (${r.internCode})` },
        { label: 'Department', value: r.department ?? '—' },
        { label: 'Supervisor', value: r.supervisor?.fullName ?? '—' },
        { label: 'Institution', value: r.institution ?? '—' },
        { label: 'Internship', value: `${String(r.startDate).slice(0, 10)} to ${r.endDate ? String(r.endDate).slice(0, 10) : 'open'}` },
        { label: 'Stipend', value: r.internshipType === 'paid' ? `${pkr(r.monthlyStipendCents)} a month` : 'Unpaid' },
      ],
      amountCents: r.internshipType === 'paid' ? r.monthlyStipendCents : null,
      waitingSince: r.submittedAt ?? r.createdAt,
      link: `/hr/interns/${r.id}`,
      actions: [
        { kind: 'approve', label: 'Approve', method: 'POST', path: `/hr/interns/${r.id}/approve`, body: {}, confirm: 'Approve this intern enrolment? The internship becomes active.' },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/hr/interns/${r.id}/reject`, body: {}, input: { field: 'note', label: 'Reason (at least 10 characters) — HR can fix and resubmit', required: true } },
      ],
    }))
  },
}

const runFacts = (r: RunRow) => {
  const t = r.totals ?? {}
  return [
    { label: 'Month', value: r.period },
    { label: 'Paid interns', value: String(t.interns ?? 0) },
    { label: 'Prorated stipends', value: pkr(t.baseCents) },
    { label: 'Additions / deductions', value: `${pkr(t.additionsCents)} / ${pkr(t.deductionsCents)}` },
    { label: 'Net payable', value: pkr(t.netCents) },
  ]
}

const FIN = APPROVAL_RIGHTS.intern_payroll_finance
export const internPayrollFinanceReviews: ApprovalProvider = {
  type: 'intern_payroll_finance',
  label: FIN.label,
  module: FIN.queueModule,
  link: '/hr/interns/payroll',
  approverRoles: FIN.roles as readonly UserRole[],
  delegable: FIN.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: RunRow[] }>('/hr/interns/payroll/runs?status=finance_review')
    if (res === null) return null
    const me = ctx.user.id
    return (res.items ?? []).map((r): ApprovalItem => {
      const own = ctx.user.role !== 'admin' && (r.createdById === me || (r.preparedByIds ?? []).includes(me) || r.sentToFinanceById === me)
      const base = `/hr/interns/payroll/runs/${r.id}`
      const disabled = own ? { disabledReason: 'You prepared or sent this stipend payroll — someone else in finance checks it' } : {}
      return {
        type: 'intern_payroll_finance', id: r.id, tenantId: r.tenantId, section: FIN.section,
        submittedByIds: ids(r.createdById, r.preparedByIds ?? [], r.sentToFinanceById),
        title: `Intern stipends ${r.period}`, subtitle: 'Sent by HR', facts: runFacts(r),
        amountCents: r.totals?.netCents ?? null, waitingSince: r.sentToFinanceAt ?? r.updatedAt,
        link: `/hr/interns/payroll/${r.id}`,
        actions: [
          { kind: 'approve', label: 'Pass to CEO', method: 'POST', path: `${base}/finance-pass`, body: {}, confirm: 'Pass this stipend payroll to the CEO?', ...disabled },
          { kind: 'return', label: 'Return to HR', method: 'POST', path: `${base}/finance-return`, body: {}, input: { field: 'note', label: 'What HR needs to correct (at least 10 characters)', required: true }, ...disabled },
        ],
      }
    })
  },
}

const CEO = APPROVAL_RIGHTS.intern_payroll
export const internPayrollRuns: ApprovalProvider = {
  type: 'intern_payroll',
  label: CEO.label,
  module: CEO.queueModule,
  link: '/hr/interns/payroll',
  approverRoles: CEO.roles as readonly UserRole[],
  delegable: CEO.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: RunRow[] }>('/hr/interns/payroll/runs?status=finance_checked')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => {
      const base = `/hr/interns/payroll/runs/${r.id}`
      return {
        type: 'intern_payroll', id: r.id, tenantId: r.tenantId, section: CEO.section,
        submittedByIds: ids(r.createdById, r.preparedByIds ?? [], r.sentToFinanceById),
        title: `Intern stipends ${r.period}`, subtitle: 'Checked by finance',
        facts: [...runFacts(r), ...(r.financeNote ? [{ label: 'Finance note', value: r.financeNote }] : [])],
        amountCents: r.totals?.netCents ?? null, waitingSince: r.financeCheckedAt ?? r.updatedAt,
        link: `/hr/interns/payroll/${r.id}`,
        actions: [
          { kind: 'approve', label: 'Approve', method: 'POST', path: `${base}/approve`, body: {}, confirm: 'Approve these stipends? They are booked to Intern Stipends / Stipends Payable.' },
          { kind: 'return', label: 'Return to finance', method: 'POST', path: `${base}/return`, body: { to: 'finance' }, input: { field: 'note', label: 'What finance needs to correct (at least 10 characters)', required: true } },
          { kind: 'return', label: 'Return to HR', method: 'POST', path: `${base}/return`, body: { to: 'hr' }, input: { field: 'note', label: 'What HR needs to correct (at least 10 characters)', required: true } },
        ],
      }
    })
  },
}
