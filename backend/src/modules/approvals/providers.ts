// One provider per approval type. Each reads its module's EXISTING queue
// route (ctx.read — as the signed-in user, so the module's role guard, module
// access and company scope all apply) and shapes the rows into inbox items
// whose buttons call the module's EXISTING approve / reject routes.
//
// approverRoles mirrors the requireAuth list on each module's approve route
// (the file and constant are named beside it). The inbox narrows by it only so
// a type whose queue route is wider than its approve route (the storefront
// list, the payroll register, stock transfers) never shows an item the user
// could not act on; the route itself still decides every click.
//
// Lookups here (a PO's or recipe's company, a few names) are by ids the
// module's own route already returned to this user — never a wider read.

import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ADMIN_ONLY, APPROVERS, MANAGERS } from '../auth/middleware.js'
import { isSelfApprovalExempt } from '../../lib/separation-of-duties.js'
import type { ApprovalItem, ApprovalProvider, ProviderContext } from './types.js'

// ── helpers ──────────────────────────────────────────────────────────────────

export function pkr(cents: number | null | undefined): string {
  const n = Math.round((cents ?? 0) / 100)
  return `PKR ${n.toLocaleString('en-PK')}`
}
const iso = (d: unknown): string | null => {
  if (!d) return null
  const t = new Date(d as string)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}
const ymd = (d: unknown): string => iso(d)?.slice(0, 10) ?? '—'
const human = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ')
const facts = (rows: Array<[string, string | null | undefined]>) =>
  rows.filter(([, v]) => v != null && v !== '').map(([label, value]) => ({ label, value: String(value) }))

async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = Array.from(new Set(ids.filter((x): x is string => !!x)))
  if (want.length === 0) return new Map()
  const rows = await prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, name: true, email: true } })
  return new Map(rows.map((u) => [u.id, u.name ?? u.email ?? 'Unknown']))
}

async function conceptInfo(ids: Array<string | null | undefined>) {
  const want = Array.from(new Set(ids.filter((x): x is string => !!x)))
  if (want.length === 0) return new Map<string, { name: string; tenantId: string | null }>()
  const rows = await prisma.concept.findMany({ where: { id: { in: want } }, select: { id: true, name: true, tenantId: true } })
  return new Map(rows.map((c) => [c.id, { name: c.name, tenantId: c.tenantId }]))
}

// HR request steps (hr/logic.ts canActOnStep): HR_APPROVERS and MGMT_APPROVERS.
const HR_STEP_ROLES = ['hr', 'admin', 'owner', 'management'] as UserRole[]
// hr/routes.ts PAYROLL_APPROVERS.
const PAYROLL_APPROVERS = ['admin', 'owner', 'management'] as UserRole[]

// ── New logins ───────────────────────────────────────────────────────────────
// auth/routes.ts: GET /auth/staff/pending, PATCH /auth/staff/:id/approve|reject
// — requireAuth('admin').
const staffLogins: ApprovalProvider = {
  type: 'staff_login',
  label: 'New logins',
  module: 'role_management',
  link: '/workforce?status=pending',
  approverRoles: ADMIN_ONLY,
  delegable: true,
  async load(ctx) {
    type Row = {
      id: string; name: string | null; email: string | null; phone: string | null; role: string
      signupReason: string | null; createdAt: string; tenantId: string | null; invitedBy: { id: string; name: string | null } | null
    }
    const rows = await ctx.read<Row[]>('/auth/staff/pending')
    if (rows === null) return null
    return rows.map((r): ApprovalItem => ({
      type: 'staff_login',
      id: r.id,
      tenantId: r.tenantId,
      title: r.name ?? r.email ?? r.phone ?? 'New login',
      subtitle: human(r.role),
      facts: facts([
        ['Role', human(r.role)],
        ['Contact', r.email ?? r.phone],
        ['Added by', r.invitedBy?.name ?? (r.invitedBy ? 'A team lead' : 'Self sign-up')],
        ['Reason', r.signupReason],
      ]),
      waitingSince: iso(r.createdAt),
      link: '/workforce?status=pending',
      actions: [
        // A company-less legacy row (the removed self-signup, which let people
        // pick their own role) gets its company on Workforce first — the same
        // rule as that screen's disabled Approve. Reject stays inline.
        { kind: 'approve', label: 'Approve', method: 'PATCH', path: `/auth/staff/${r.id}/approve`, body: {},
          ...(r.tenantId === null && { disabledReason: 'Pick a company for this login on Workforce first' }) },
        { kind: 'reject', label: 'Reject', method: 'PATCH', path: `/auth/staff/${r.id}/reject`, body: {},
          confirm: 'Reject this login? It cannot sign in, and the same email cannot sign up again until the CEO restores it.' },
      ],
    }))
  },
}

// ── Website publishing ───────────────────────────────────────────────────────
// siteLayouts/routes.ts: GET /site-layouts?status=pending (storefront module),
// POST /site-layouts/:slug/approve|reject — CEO = ADMIN_ONLY (decision 41).
const storefrontPublish: ApprovalProvider = {
  type: 'storefront_publish',
  label: 'Website changes',
  module: 'storefront',
  link: '/storefront?tab=approvals',
  approverRoles: ADMIN_ONLY,
  delegable: true,
  async load(ctx) {
    type Row = {
      id: string; slug: string; kind: string; title: string | null; tenantId: string | null
      liveVersion: number; submittedAt: string | null; submittedBy: { id: string; name: string | null } | null; updatedAt: string
    }
    const rows = await ctx.read<Row[]>('/site-layouts?status=pending')
    if (rows === null) return null
    return rows.map((r): ApprovalItem => {
      const path = `/site-layouts/${encodeURIComponent(r.slug)}`
      return {
        type: 'storefront_publish',
        id: r.id,
        tenantId: r.tenantId,
        title: r.title || r.slug,
        subtitle: r.slug,
        facts: facts([
          ['Page', r.slug],
          ['Kind', human(r.kind)],
          ['Submitted by', r.submittedBy?.name ?? null],
          ['Live now', r.liveVersion > 0 ? `version ${r.liveVersion}` : 'Not published yet'],
        ]),
        waitingSince: iso(r.submittedAt ?? r.updatedAt),
        link: '/storefront?tab=approvals',
        actions: [
          { kind: 'approve', label: 'Publish now', method: 'POST', path: `${path}/approve`, body: {},
            confirm: 'Publish this draft to the live site now? To preview it or schedule it, open the Storefront.' },
          { kind: 'reject', label: 'Send back', method: 'POST', path: `${path}/reject`, body: {},
            input: { field: 'note', label: 'What needs to change', required: true } },
        ],
      }
    })
  },
}

// ── Purchase orders over the company's threshold ─────────────────────────────
// procurement/routes.ts: GET /procurement/approvals, POST
// /procurement/purchase-orders/:id/approve|reject — ADMIN_ONLY.
const purchaseOrders: ApprovalProvider = {
  type: 'purchase_order',
  label: 'Purchase orders',
  module: 'procurement',
  link: '/procurement',
  approverRoles: ADMIN_ONLY,
  delegable: true,
  async load(ctx) {
    type Row = {
      id: string; supplierId: string; totalCents: number; reference: string | null; notes: string | null
      createdBy: string | null; createdAt: string; orderDate: string; expectedDate: string | null
      supplier: { name: string } | null; lines: unknown[]
    }
    const rows = await ctx.read<Row[]>('/procurement/approvals')
    if (rows === null) return null
    if (rows.length === 0) return []
    const [companies, names] = await Promise.all([
      prisma.purchaseOrder.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, supplier: { select: { tenantId: true } } } }),
      userNames(rows.map((r) => r.createdBy)),
    ])
    const tenantOf = new Map(companies.map((p) => [p.id, p.supplier.tenantId]))
    return rows.map((r): ApprovalItem => ({
      type: 'purchase_order',
      id: r.id,
      tenantId: tenantOf.get(r.id) ?? null,
      title: `${r.supplier?.name ?? 'Supplier'} — ${pkr(r.totalCents)}`,
      subtitle: r.reference,
      facts: facts([
        ['Supplier', r.supplier?.name],
        ['Total', pkr(r.totalCents)],
        ['Lines', String(r.lines?.length ?? 0)],
        ['Raised by', r.createdBy ? names.get(r.createdBy) : null],
        ['Expected', r.expectedDate ? ymd(r.expectedDate) : null],
        ['Notes', r.notes],
      ]),
      amountCents: r.totalCents,
      waitingSince: iso(r.createdAt),
      link: '/procurement',
      actions: [
        { kind: 'approve', label: 'Approve', method: 'POST', path: `/procurement/purchase-orders/${r.id}/approve`, body: {} },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/procurement/purchase-orders/${r.id}/reject`, body: {},
          input: { field: 'reason', label: 'Reason', required: true } },
      ],
    }))
  },
}

// ── Recipe sign-off ──────────────────────────────────────────────────────────
// recipes/routes.ts: GET /recipes/pending-approval, POST /recipes/:id/approve|
// reject — APPROVERS (admin, owner), and assertNotSelfApproval: an owner never
// signs off a recipe they submitted (the CEO may).
const recipes: ApprovalProvider = {
  type: 'recipe',
  label: 'Recipes',
  module: 'recipes',
  link: '/accounting/recipes/approvals',
  approverRoles: APPROVERS,
  delegable: true,
  async load(ctx) {
    type Row = { id: string; kind: string; name: string; brand: string | null; submittedById: string | null; submittedAt: string | null }
    const all = await ctx.read<Row[]>('/recipes/pending-approval')
    if (all === null) return null
    const rows = all.filter((r) => isSelfApprovalExempt(ctx.user) || !r.submittedById || r.submittedById !== ctx.user.id)
    if (rows.length === 0) return []
    const [found, names] = await Promise.all([
      prisma.recipe.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        select: { id: true, pendingMenuItem: true, menuItem: { select: { conceptId: true } } },
      }),
      userNames(rows.map((r) => r.submittedById)),
    ])
    const conceptOf = new Map(found.map((r) => [r.id, r.menuItem?.conceptId ?? (r.pendingMenuItem as { conceptId?: string } | null)?.conceptId ?? null]))
    const concepts = await conceptInfo([...conceptOf.values()])
    return rows.map((r): ApprovalItem => {
      const cid = conceptOf.get(r.id)
      return {
        type: 'recipe',
        id: r.id,
        // A component recipe has no brand of its own; its company follows the
        // plates that use it (the module scoped it already).
        tenantId: cid ? (concepts.get(cid)?.tenantId ?? null) : null,
        title: r.name,
        subtitle: r.brand,
        facts: facts([
          ['Brand', r.brand],
          ['Kind', r.kind === 'component' ? 'Component (sub-recipe)' : 'Plate'],
          ['Submitted by', r.submittedById ? names.get(r.submittedById) : null],
        ]),
        waitingSince: iso(r.submittedAt),
        link: '/accounting/recipes/approvals',
        actions: [
          { kind: 'approve', label: 'Approve', method: 'POST', path: `/recipes/${r.id}/approve`, body: {},
            confirm: 'Approve this recipe? It goes into production and sets the live menu price.' },
          { kind: 'reject', label: 'Send back', method: 'POST', path: `/recipes/${r.id}/reject`, body: {},
            input: { field: 'reason', label: 'Reason (optional)', required: false } },
        ],
      }
    })
  },
}

// ── HR requests (leave, overtime, corrections, swaps, loans, …) ──────────────
// hr/routes.ts: GET /hr/approvals (the ONE "what is waiting on me" resolver —
// canActOnStep per record: reporting manager, HR, or management), POST
// /hr/records/:section/:id/decide. Open to every login; the step decides.
const hrRequests: ApprovalProvider = {
  type: 'hr_request',
  label: 'HR requests',
  module: 'staff_hr',
  link: '/ceo/approvals?type=hr_request',
  approverRoles: null,
  alwaysListFor: HR_STEP_ROLES,
  // /hr/approvals spans every company the user belongs to on purpose (a
  // head-office HOD's steps in each company), and /hr/team's "waiting on you"
  // count is the same list — the inbox keeps them all, labelled by company.
  spansMemberCompanies: true,
  delegable: true,
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; section: string; label: string; sectionTitle: string
      createdAt: string; startDate: string | null; endDate: string | null; quantity: number | null
      employee: { id: string; fullName: string; employeeCode: string } | null
      step: { key: string; label: string; role: string }
      waitingOnPartner?: boolean
      data?: Record<string, unknown> | null
      currentStep?: number
      format?: { workflow?: unknown[] } | null
    }
    const rows = await ctx.read<Row[]>('/hr/approvals')
    if (rows === null) return null
    return rows.map((r): ApprovalItem => {
      const base = `/hr/records/${encodeURIComponent(r.section)}/${r.id}/decide`
      // A loan's last approval pays it out: where from (bank account or
      // cash) is picked on the request itself, which the inbox cannot do.
      const lastStep = r.format?.workflow ? r.currentStep === r.format.workflow.length - 1 : false
      const d = r.data ?? {}
      const loanNeedsSource = r.section === 'loan' && lastStep
        && !(d['paidFrom'] === 'cash' || (typeof d['bankAccount'] === 'string' && d['bankAccount']))
      return {
        type: 'hr_request',
        id: r.id,
        tenantId: r.tenantId,
        title: `${r.sectionTitle} — ${r.employee?.fullName ?? r.label}`,
        subtitle: r.label,
        facts: facts([
          ['Step', r.step?.label],
          ['Employee', r.employee ? `${r.employee.fullName} (${r.employee.employeeCode})` : null],
          ['Dates', r.startDate ? (r.endDate && ymd(r.endDate) !== ymd(r.startDate) ? `${ymd(r.startDate)} to ${ymd(r.endDate)}` : ymd(r.startDate)) : null],
          ['Quantity', r.quantity != null ? String(r.quantity) : null],
        ]),
        waitingSince: iso(r.createdAt),
        link: loanNeedsSource ? `/hr/s/loan` : null,
        record: r,
        actions: [
          { kind: 'approve', label: 'Approve', method: 'POST', path: base, body: { decision: 'approved' },
            ...(r.waitingOnPartner && { disabledReason: 'Waiting for the colleague to accept the swap' }),
            ...(loanNeedsSource && { disabledReason: 'Open the request to pick the bank account (or cash) the loan is paid from' }),
            ...(r.section === 'overtime' && { confirm: 'Approve the hours as claimed? To change the hours, open the request.' }) },
          { kind: 'reject', label: 'Reject', method: 'POST', path: base, body: { decision: 'rejected' },
            input: { field: 'note', label: 'Note (optional)', required: false } },
        ],
      }
    })
  },
}

// ── Payroll runs ─────────────────────────────────────────────────────────────
// hr/routes.ts: GET /hr/payroll/runs (the register), POST
// /hr/payroll/runs/:id/approve — PAYROLL_APPROVERS, never by whoever prepared
// it (created, recalculated or edited a payslip), the CEO excepted.
const payrollRuns: ApprovalProvider = {
  type: 'payroll_run',
  label: 'Payroll',
  module: 'staff_hr',
  link: '/hr/payroll',
  approverRoles: PAYROLL_APPROVERS,
  delegable: true,
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; period: string; status: string; createdById: string | null; preparedByIds: string[]
      createdAt: string; updatedAt: string
      totals: { employees?: number; grossCents?: number; netCents?: number; warnings?: string[] } | null
    }
    const rows = await ctx.read<Row[]>('/hr/payroll/runs')
    if (rows === null) return null
    const me = ctx.user.id
    return rows
      .filter((r) => r.status === 'draft')
      .filter((r) => ctx.user.role === 'admin' || (r.createdById !== me && !(r.preparedByIds ?? []).includes(me)))
      .map((r): ApprovalItem => {
        const t = r.totals ?? {}
        return {
          type: 'payroll_run',
          id: r.id,
          tenantId: r.tenantId,
          title: `Payroll ${r.period}`,
          subtitle: t.employees != null ? `${t.employees} employees` : null,
          facts: facts([
            ['Period', r.period],
            ['Employees', t.employees != null ? String(t.employees) : null],
            ['Gross', t.grossCents != null ? pkr(t.grossCents) : null],
            ['Net pay', t.netCents != null ? pkr(t.netCents) : null],
            ['Warnings', t.warnings?.length ? String(t.warnings.length) : null],
          ]),
          amountCents: t.netCents ?? null,
          waitingSince: iso(r.updatedAt ?? r.createdAt),
          link: `/hr/payroll/${r.id}`,
          actions: [
            { kind: 'approve', label: 'Approve', method: 'POST', path: `/hr/payroll/runs/${r.id}/approve`, body: {},
              confirm: 'Approve this payroll? Check the payslips first on the payroll screen.' },
          ],
        }
      })
  },
}

// ── Tip pools ────────────────────────────────────────────────────────────────
// tipPools/routes.ts: GET /tip-pools, POST /tip-pools/:id/post and /:id/pay —
// APPROVERS. Posting reviews the hours and may need kiosk staff left out by
// name, so these open the Tip pools screen rather than act inline.
const tipPools: ApprovalProvider = {
  type: 'tip_pool',
  label: 'Tip pools',
  module: 'payroll',
  link: '/tip-pools',
  approverRoles: APPROVERS,
  delegable: true,
  async load(ctx) {
    type Row = {
      id: string; conceptId: string | null; name: string; periodStart: string; periodEnd: string
      totalTipsCents: number; status: string; createdAt: string; postedAt?: string | null
      _count?: { members: number }
    }
    const rows = await ctx.read<Row[]>('/tip-pools')
    if (rows === null) return null
    const now = Date.now()
    // A draft can be posted once its window is over; a posted pool is paid out.
    const waiting = rows.filter((r) => (r.status === 'draft' && new Date(r.periodEnd).getTime() <= now) || r.status === 'posted')
    const concepts = await conceptInfo(waiting.map((r) => r.conceptId))
    return waiting.map((r): ApprovalItem => {
      const c = r.conceptId ? concepts.get(r.conceptId) : undefined
      return {
        type: 'tip_pool',
        id: r.id,
        tenantId: c?.tenantId ?? null,
        title: `${r.name} — ${pkr(r.totalTipsCents)}`,
        subtitle: r.status === 'draft' ? 'Ready to post' : 'Posted — ready to pay out',
        facts: facts([
          ['Brand', c?.name],
          ['Window', `${ymd(r.periodStart)} to ${ymd(r.periodEnd)}`],
          ['Tips', pkr(r.totalTipsCents)],
          ['Staff', r._count ? String(r._count.members) : null],
          ['Next step', r.status === 'draft' ? 'Post the split' : 'Pay out'],
        ]),
        amountCents: r.totalTipsCents,
        waitingSince: iso(r.status === 'draft' ? r.periodEnd : (r.postedAt ?? r.createdAt)),
        link: '/tip-pools',
        actions: [],
      }
    })
  },
}

// ── Stock transfers ──────────────────────────────────────────────────────────
// stockTransfers/routes.ts: GET /stock-transfers?status=requested, PATCH
// /stock-transfers/:id/approve and /:id/cancel — MANAGERS. F&B work: this is
// the F&B manager's queue as much as the CEO's.
const stockTransfers: ApprovalProvider = {
  type: 'stock_transfer',
  label: 'Stock transfers',
  module: 'inventory',
  // No admin screen lists transfers yet: the inbox is their screen.
  link: '/ceo/approvals?type=stock_transfer',
  approverRoles: MANAGERS,
  delegable: false,
  async load(ctx) {
    type Row = {
      id: string; quantity: number; unit: string; reason: string | null; notes: string | null
      fromLocationId: string; toLocationId: string; requestedById: string | null; requestedAt: string
      inventoryItem: { name: string } | null; fromLocation: { name: string } | null; toLocation: { name: string } | null
    }
    const rows = await ctx.read<Row[]>('/stock-transfers?status=requested&limit=200')
    if (rows === null) return null
    if (rows.length === 0) return []
    const [locs, names] = await Promise.all([
      prisma.location.findMany({ where: { id: { in: Array.from(new Set(rows.map((r) => r.fromLocationId))) } }, select: { id: true, tenantId: true } }),
      userNames(rows.map((r) => r.requestedById)),
    ])
    const tenantOf = new Map(locs.map((l) => [l.id, l.tenantId]))
    return rows.map((r): ApprovalItem => ({
      type: 'stock_transfer',
      id: r.id,
      tenantId: tenantOf.get(r.fromLocationId) ?? null,
      title: `${r.inventoryItem?.name ?? 'Item'} — ${r.quantity} ${r.unit}`,
      subtitle: `${r.fromLocation?.name ?? '?'} → ${r.toLocation?.name ?? '?'}`,
      facts: facts([
        ['From', r.fromLocation?.name],
        ['To', r.toLocation?.name],
        ['Quantity', `${r.quantity} ${r.unit}`],
        ['Requested by', r.requestedById ? names.get(r.requestedById) : null],
        ['Reason', r.reason],
      ]),
      waitingSince: iso(r.requestedAt),
      link: null,
      actions: [
        { kind: 'approve', label: 'Approve', method: 'PATCH', path: `/stock-transfers/${r.id}/approve`, body: {} },
        { kind: 'reject', label: 'Cancel transfer', method: 'PATCH', path: `/stock-transfers/${r.id}/cancel`, body: {},
          input: { field: 'reason', label: 'Reason (optional)', required: false } },
      ],
    }))
  },
}

// ── Cash vouchers waiting for the director ───────────────────────────────────
// trustops/cashVouchers.ts: GET /trustops/cash-vouchers?status=hod_signed
// (CASH_GUARD), POST /trustops/cash-vouchers/:id/approve|reject — ADMIN_ONLY
// (the director). Never the login that signed as HOD (409 SAME_SIGNER): such
// an item is listed with Approve disabled, Reject stays.
const cashVouchers: ApprovalProvider = {
  type: 'cash_voucher',
  label: 'Cash vouchers',
  module: 'accounting',
  link: '/finance/cash-vouchers',
  approverRoles: ADMIN_ONLY,
  delegable: true,
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; number: string; voucherDate: string; payeeName: string; purpose: string
      amountCents: number; category: string | null; department: string | null; conceptName: string | null
      boxName: string; preparedByName: string | null; hodSignedById: string | null; hodSignedByName: string | null
      hodSignedAt: string | null; createdAt: string
    }
    const res = await ctx.read<{ items: Row[] }>('/trustops/cash-vouchers?status=hod_signed&limit=200')
    if (res === null) return null
    return res.items.map((r): ApprovalItem => {
      const base = `/trustops/cash-vouchers/${r.id}`
      return {
        type: 'cash_voucher',
        id: r.id,
        tenantId: r.tenantId,
        title: `${r.number} — ${r.payeeName} — ${pkr(r.amountCents)}`,
        subtitle: r.purpose,
        facts: facts([
          ['Voucher', r.number],
          ['Pay to', r.payeeName],
          ['Amount', pkr(r.amountCents)],
          ['Purpose', r.purpose],
          ['Date', ymd(r.voucherDate)],
          ['Brand', r.conceptName],
          ['Department', r.department],
          ['Paid from', r.boxName],
          ['Prepared by', r.preparedByName],
          ['HOD signed by', r.hodSignedByName],
        ]),
        amountCents: r.amountCents,
        waitingSince: iso(r.hodSignedAt ?? r.createdAt),
        link: `/finance/cash-vouchers?id=${encodeURIComponent(r.id)}`,
        actions: [
          { kind: 'approve', label: 'Sign as director', method: 'POST', path: `${base}/approve`, body: {},
            confirm: 'Sign this voucher as director? The cashier pays it against the signed paper; nothing leaves the cash box until the photo of that paper is uploaded.',
            ...(r.hodSignedById === ctx.user.id && { disabledReason: 'You signed this as HOD — a different person must sign as director' }) },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}

/** Every approval type, in the order the inbox shows them. */
export const APPROVAL_PROVIDERS: readonly ApprovalProvider[] = [
  staffLogins,
  storefrontPublish,
  purchaseOrders,
  recipes,
  hrRequests,
  payrollRuns,
  tipPools,
  stockTransfers,
  cashVouchers,
]

export type { ProviderContext }
