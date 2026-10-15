// One provider per approval type. Each reads its module's EXISTING queue
// route (ctx.read — as the signed-in user, so the module's role guard, module
// access and company scope all apply) and shapes the rows into inbox items
// whose buttons call the module's EXISTING approve / reject routes.
//
// approverRoles and delegable come from lib/approvalRights.ts APPROVAL_RIGHTS —
// the one copy of each approve route's role list (A23). The inbox narrows by
// it only so a type whose queue route is wider than its approve route (the
// storefront list, the payroll register, stock transfers) never shows an item
// the user could not act on; the route itself still decides every click.
//
// Each item carries submittedByIds (creator / submitter / preparers) so the
// inbox can keep a delegate's own submissions out of their inbox, and the
// through-head-office rule can tell who sent it (A3).
//
// Lookups here (a PO's or recipe's company, a few names) are by ids the
// module's own route already returned to this user — never a wider read.

import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { isSelfApprovalExempt } from '../../lib/separation-of-duties.js'
import { APPROVAL_RIGHTS, sectionOf } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider, ApprovalType, ProviderContext } from './types.js'

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

/**
 * The registry's rights for a provider: approverRoles (null for a per-item
 * type, whose steps' roles are `alwaysListFor`) and delegable.
 */
function rightsOf(type: ApprovalType): Pick<ApprovalProvider, 'approverRoles' | 'delegable' | 'alwaysListFor'> {
  const r = APPROVAL_RIGHTS[type]
  const roles = r.roles as readonly UserRole[]
  return r.perItem
    ? { approverRoles: null, delegable: r.delegable, ...(roles.length ? { alwaysListFor: roles } : {}) }
    : { approverRoles: roles, delegable: r.delegable }
}

const idList = (...xs: Array<string | null | undefined | Array<string | null | undefined>>): string[] =>
  Array.from(new Set(xs.flat().filter((x): x is string => typeof x === 'string' && x.length > 0)))

/** Read a queue that answers a bare array or `{ <key>: [...] }` (new modules, wave 2). */
function rowsOf<T>(res: unknown, ...keys: string[]): T[] {
  if (Array.isArray(res)) return res as T[]
  if (res && typeof res === 'object') {
    for (const k of [...keys, 'items', 'rows']) {
      const v = (res as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}

// ── New logins ───────────────────────────────────────────────────────────────
// auth/routes.ts: GET /auth/staff/pending, PATCH /auth/staff/:id/approve|reject
// — requireAuth('admin').
const staffLogins: ApprovalProvider = {
  type: 'staff_login',
  label: 'New logins',
  module: 'role_management',
  link: '/workforce?status=pending',
  ...rightsOf('staff_login'),
  async load(ctx) {
    type Row = {
      id: string; name: string | null; email: string | null; phone: string | null; role: string
      signupReason: string | null; createdAt: string; tenantId: string | null; invitedBy: { id: string; name: string | null } | null
      viaHeadOfficeId?: string | null
    }
    const rows = await ctx.read<Row[]>('/auth/staff/pending')
    if (rows === null) return null
    return rows.map((r): ApprovalItem => ({
      type: 'staff_login',
      id: r.id,
      tenantId: r.tenantId,
      // A floor login is Operations'; every password login stays the CEO's.
      section: sectionOf('staff_login', { role: r.role, tenantId: r.tenantId }),
      submittedByIds: idList(r.invitedBy?.id),
      viaHeadOfficeId: r.viaHeadOfficeId ?? null,
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
  ...rightsOf('storefront_publish'),
  async load(ctx) {
    type Row = {
      id: string; slug: string; kind: string; title: string | null; label?: string | null; tenantId: string | null
      liveVersion: number; submittedAt: string | null; submittedBy: { id: string; name: string | null } | null; updatedAt: string
      draftUpdatedById?: string | null; viaHeadOfficeId?: string | null
    }
    const rows = await ctx.read<Row[]>('/site-layouts?status=pending')
    if (rows === null) return null
    return rows.map((r): ApprovalItem => {
      const path = `/site-layouts/${encodeURIComponent(r.slug)}`
      // A brand kit (brand:<b>:kit) reads "Brand kit — <Brand>" (the list
      // route's `label`) and opens its kit editor.
      const kitBrand = r.kind === 'kit' ? /^brand:([^:]+):kit$/.exec(r.slug)?.[1] : undefined
      const link = kitBrand ? `/storefront/kit/${encodeURIComponent(kitBrand)}` : '/storefront?tab=approvals'
      return {
        type: 'storefront_publish',
        id: r.id,
        tenantId: r.tenantId,
        section: sectionOf('storefront_publish', { tenantId: r.tenantId }),
        submittedByIds: idList(r.submittedBy?.id, r.draftUpdatedById),
        viaHeadOfficeId: r.viaHeadOfficeId ?? null,
        title: r.label || r.title || r.slug,
        subtitle: r.slug,
        facts: facts([
          ['Page', r.slug],
          ['Kind', kitBrand ? 'Brand kit' : human(r.kind)],
          ['Submitted by', r.submittedBy?.name ?? null],
          ['Live now', r.liveVersion > 0 ? `version ${r.liveVersion}` : 'Not published yet'],
        ]),
        waitingSince: iso(r.submittedAt ?? r.updatedAt),
        link,
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
  ...rightsOf('purchase_order'),
  async load(ctx) {
    type Row = {
      id: string; supplierId: string; totalCents: number; reference: string | null; notes: string | null
      createdBy: string | null; createdAt: string; orderDate: string; expectedDate: string | null
      supplier: { name: string } | null; lines: unknown[]; viaHeadOfficeId?: string | null
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
      submittedByIds: idList(r.createdBy),
      viaHeadOfficeId: r.viaHeadOfficeId ?? null,
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
  ...rightsOf('recipe'),
  async load(ctx) {
    type Row = {
      id: string; kind: string; name: string; brand: string | null; submittedById: string | null; submittedAt: string | null
      createdById?: string | null; editedByIds?: string[]; viaHeadOfficeId?: string | null
    }
    const all = await ctx.read<Row[]>('/recipes/pending-approval')
    if (all === null) return null
    const rows = all.filter((r) => isSelfApprovalExempt(ctx.user) || !r.submittedById || r.submittedById !== ctx.user.id)
    if (rows.length === 0) return []
    const [found, names] = await Promise.all([
      prisma.recipe.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        select: {
          id: true, pendingMenuItem: true, menuItem: { select: { conceptId: true } },
          // An add-on's recipe (kind 'modifier'): modifier → group → dish → brand.
          modifier: { select: { group: { select: { menuItem: { select: { conceptId: true } } } } } },
        },
      }),
      userNames(rows.map((r) => r.submittedById)),
    ])
    const conceptOf = new Map(found.map((r) => [
      r.id,
      r.menuItem?.conceptId
        ?? r.modifier?.group.menuItem.conceptId
        ?? (r.pendingMenuItem as { conceptId?: string } | null)?.conceptId
        ?? null,
    ]))
    const concepts = await conceptInfo([...conceptOf.values()])
    return rows.map((r): ApprovalItem => {
      const cid = conceptOf.get(r.id)
      return {
        type: 'recipe',
        id: r.id,
        // A plate's company is its dish's brand's; an add-on's, its dish's (via
        // the modifier group). A component recipe has no brand of its own; its
        // company follows the plates that use it (the module scoped it already).
        tenantId: cid ? (concepts.get(cid)?.tenantId ?? null) : null,
        submittedByIds: idList(r.submittedById, r.createdById, r.editedByIds ?? []),
        viaHeadOfficeId: r.viaHeadOfficeId ?? null,
        title: r.name,
        subtitle: r.brand,
        facts: facts([
          ['Brand', r.brand],
          ['Kind', r.kind === 'component' ? 'Component (sub-recipe)' : r.kind === 'modifier' ? 'Add-on' : 'Plate'],
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
  ...rightsOf('hr_request'),
  // /hr/approvals spans every company the user belongs to on purpose (a
  // head-office HOD's steps in each company), and /hr/team's "waiting on you"
  // count is the same list — the inbox keeps them all, labelled by company.
  spansMemberCompanies: true,
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
      createdById?: string | null; viaHeadOfficeId?: string | null
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
        submittedByIds: idList(r.createdById),
        viaHeadOfficeId: r.viaHeadOfficeId ?? null,
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
  ...rightsOf('payroll_run'),
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; period: string; status: string; createdById: string | null; preparedByIds: string[]
      createdAt: string; updatedAt: string
      totals: { employees?: number; grossCents?: number; netCents?: number; warnings?: string[] } | null
      viaHeadOfficeId?: string | null
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
          submittedByIds: idList(r.createdById, r.preparedByIds ?? []),
          viaHeadOfficeId: r.viaHeadOfficeId ?? null,
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
  ...rightsOf('tip_pool'),
  async load(ctx) {
    type Row = {
      id: string; conceptId: string | null; name: string; periodStart: string; periodEnd: string
      totalTipsCents: number; status: string; createdAt: string; postedAt?: string | null
      _count?: { members: number }
      createdById?: string | null
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
        submittedByIds: idList(r.createdById),
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
  ...rightsOf('stock_transfer'),
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
      submittedByIds: idList(r.requestedById),
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

// ── Cash requests ────────────────────────────────────────────────────────────
// trustops/cashVouchers.ts (the cash_vouchers table IS the cash request; H3:
// the pay is booked to the request's category). Two steps reach the inbox:
//
//  • waiting for the director: GET /trustops/cash-vouchers?status=hod_signed
//    (ALL_STAFF; the module's own visibility), POST /:id/approve — ADMIN_ONLY,
//    never the login that signed as HOD (409 SAME_SIGNER: listed with Approve
//    disabled, Reject stays) — and /:id/reject (note).
//  • waiting for the HOD: GET /trustops/cash-vouchers?view=hod (drafts this
//    login may sign — the holder's reporting manager, or a cash keeper), POST
//    /:id/sign-hod and /:id/reject (note). Per item: the route decides who
//    signs (canSignHod), so there are no approver roles.

type CashRequestRow = {
  id: string; tenantId: string; number: string; voucherDate: string; payeeName: string; purpose: string
  amountCents: number; category: string | null; categoryKey: string | null; categoryAccountCode: string | null
  department: string | null; conceptName: string | null; boxName: string | null
  holderName: string | null; preparedByName: string | null
  hodSignedById: string | null; hodSignedByName: string | null; hodSignedAt: string | null; createdAt: string
  canSignHod?: boolean; canApprove?: boolean
  preparedById?: string | null
}

const cashRequestTitle = (r: CashRequestRow) => `${r.number} — ${r.holderName ?? r.payeeName} — ${pkr(r.amountCents)}`
const cashRequestCategory = (r: CashRequestRow) =>
  (r.categoryKey ? human(r.categoryKey) : null) ?? (r.categoryAccountCode ? `Account ${r.categoryAccountCode}` : null) ?? r.category

const cashVouchers: ApprovalProvider = {
  type: 'cash_voucher',
  label: 'Cash requests',
  module: 'accounting',
  link: '/finance/cash-vouchers',
  ...rightsOf('cash_voucher'),
  async load(ctx) {
    const res = await ctx.read<{ items: CashRequestRow[] }>('/trustops/cash-vouchers?status=hod_signed&limit=200')
    if (res === null) return null
    return res.items.map((r): ApprovalItem => {
      const base = `/trustops/cash-vouchers/${r.id}`
      return {
        type: 'cash_voucher',
        id: r.id,
        tenantId: r.tenantId,
        submittedByIds: idList(r.preparedById),
        title: cashRequestTitle(r),
        subtitle: r.purpose,
        facts: facts([
          ['Request', r.number],
          ['Holder', r.holderName ?? r.payeeName],
          ['Amount', pkr(r.amountCents)],
          ['For', r.purpose],
          ['Category', cashRequestCategory(r)],
          ['Brand', r.conceptName],
          ['Department', r.department],
          ['Paid from', r.boxName],
          ['Raised by', r.preparedByName],
          ['HOD signed by', r.hodSignedByName],
        ]),
        amountCents: r.amountCents,
        waitingSince: iso(r.hodSignedAt ?? r.createdAt),
        link: `/finance/cash-vouchers?id=${encodeURIComponent(r.id)}`,
        actions: [
          { kind: 'approve', label: 'Approve as director', method: 'POST', path: `${base}/approve`, body: {},
            confirm: 'Approve this cash request? The cashier may then pay it; it is booked to its category when paid.',
            ...(r.hodSignedById === ctx.user.id && { disabledReason: 'You signed this as HOD — a different person must sign as director' }) },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}

const cashRequestsHod: ApprovalProvider = {
  type: 'cash_request_hod',
  label: 'Cash requests to sign (HOD)',
  module: 'accounting',
  link: '/finance/cash-vouchers?view=hod',
  ...rightsOf('cash_request_hod'),
  async load(ctx) {
    const res = await ctx.read<{ items: CashRequestRow[] }>('/trustops/cash-vouchers?view=hod&limit=200')
    if (res === null) return null
    return res.items.filter((r) => r.canSignHod).map((r): ApprovalItem => {
      const base = `/trustops/cash-vouchers/${r.id}`
      return {
        type: 'cash_request_hod',
        id: r.id,
        tenantId: r.tenantId,
        submittedByIds: idList(r.preparedById),
        title: cashRequestTitle(r),
        subtitle: r.purpose,
        facts: facts([
          ['Request', r.number],
          ['Holder', r.holderName ?? r.payeeName],
          ['Amount', pkr(r.amountCents)],
          ['For', r.purpose],
          ['Category', cashRequestCategory(r)],
          ['Brand', r.conceptName],
          ['Department', r.department],
          ['Raised by', r.preparedByName],
        ]),
        amountCents: r.amountCents,
        waitingSince: iso(r.createdAt),
        link: `/finance/cash-vouchers?id=${encodeURIComponent(r.id)}`,
        actions: [
          { kind: 'approve', label: 'Sign as HOD', method: 'POST', path: `${base}/sign-hod`, body: {},
            confirm: 'Sign this cash request as HOD? It then goes to the director.' },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}

// ── Fixed-asset requests (disposal, scrap, write-down, capitalisation, …) ────
// fixedAssets/requests.ts: GET /accounting/fixed-assets/requests?status=pending
// (FINANCIALS_VIEWERS; finance raises them), POST /requests/:id/approve |
// reject (note) — ADMIN_ONLY. Not delegable: events.applyEvent re-checks role
// admin.
const fixedAssetRequests: ApprovalProvider = {
  type: 'fixed_asset_request',
  label: 'Fixed assets',
  module: 'accounting',
  link: '/accounting/fixed-assets/requests',
  ...rightsOf('fixed_asset_request'),
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; kind: string; kindLabel: string; effectiveDate: string; amountCents: number | null
      reason: string; requestedByName: string | null; requestedAt: string; errorMessage: string | null; canDecide?: boolean
      asset: { id: string; assetTag: string | null; name: string } | null
      pool: { label: string } | null
      capexLine: { item: string; projectName: string } | null
      requestedById?: string | null
    }
    const res = await ctx.read<{ requests: Row[] }>('/accounting/fixed-assets/requests?status=pending&limit=200')
    if (res === null) return null
    return res.requests.map((r): ApprovalItem => {
      const base = `/accounting/fixed-assets/requests/${r.id}`
      const subject = r.asset
        ? `${r.asset.assetTag ? `${r.asset.assetTag} ` : ''}${r.asset.name}`
        : r.pool?.label ?? (r.capexLine ? `${r.capexLine.projectName}: ${r.capexLine.item}` : '')
      return {
        type: 'fixed_asset_request',
        id: r.id,
        tenantId: r.tenantId,
        submittedByIds: idList(r.requestedById),
        title: subject ? `${r.kindLabel} — ${subject}` : r.kindLabel,
        subtitle: r.reason,
        facts: facts([
          ['Request', r.kindLabel],
          ['Asset', subject],
          ['Amount', r.amountCents ? pkr(r.amountCents) : null],
          ['Effective', ymd(r.effectiveDate)],
          ['Reason', r.reason],
          ['Asked by', r.requestedByName],
          ['Last error', r.errorMessage],
        ]),
        ...(r.amountCents ? { amountCents: r.amountCents } : {}),
        waitingSince: iso(r.requestedAt),
        link: r.asset ? `/accounting/fixed-assets/${r.asset.id}` : '/accounting/fixed-assets/requests',
        actions: [
          { kind: 'approve', label: 'Approve', method: 'POST', path: `${base}/approve`, body: {},
            confirm: 'Approve this request? It posts now (a closed month posts into the open month with a note).' },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}

// ── Inter-company transfers ──────────────────────────────────────────────────
// intercompany/routes.ts: GET /accounting/intercompany/transfers?status=
// submitted (FINANCIALS_VIEWERS; rows where either company is in view), POST
// /transfers/:id/approve | reject (note) — ADMIN_ONLY and a member of BOTH
// companies (403 NOT_IN_BOTH_COMPANIES): listed with the buttons disabled.
// The item sits in whichever of its two companies is in view (the debtor
// when both are), so either company's view shows it.
const intercompanyTransfers: ApprovalProvider = {
  type: 'intercompany_transfer',
  label: 'Inter-company transfers',
  module: 'accounting',
  link: '/accounting/intercompany?tab=transfers',
  ...rightsOf('intercompany_transfer'),
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; counterpartyTenantId: string; debtorName: string | null; creditorName: string | null
      kind: string; amountCents: number; entryDate: string; memo: string | null
      preparedByName: string | null; preparedAt: string; memberOfBoth: boolean
      preparedById?: string | null; canApprove?: boolean
    }
    const res = await ctx.read<{ items: Row[] }>('/accounting/intercompany/transfers?status=submitted&limit=200')
    if (res === null) return null
    const inView = new Set(ctx.tenantIds)
    return res.items.map((r): ApprovalItem => {
      const base = `/accounting/intercompany/transfers/${r.id}`
      // The module answers canApprove per row once head-office pairs exist
      // (a delegate of the pair's head office); until then: a member of both.
      const may = r.canApprove ?? r.memberOfBoth
      const notBoth = may ? {} : { disabledReason: r.memberOfBoth ? 'This needs the CEO' : 'You are not a member of both companies' }
      return {
        type: 'intercompany_transfer',
        id: r.id,
        tenantId: inView.has(r.tenantId) || !inView.has(r.counterpartyTenantId) ? r.tenantId : r.counterpartyTenantId,
        touchesTenantIds: [r.tenantId, r.counterpartyTenantId],
        submittedByIds: idList(r.preparedById),
        title: `${human(r.kind)}: ${r.debtorName ?? 'Company'} owes ${r.creditorName ?? 'company'} — ${pkr(r.amountCents)}`,
        subtitle: r.memo,
        facts: facts([
          ['Kind', human(r.kind)],
          ['Owed by', r.debtorName],
          ['Owed to', r.creditorName],
          ['Amount', pkr(r.amountCents)],
          ['Date', ymd(r.entryDate)],
          ['Memo', r.memo],
          ['Prepared by', r.preparedByName],
        ]),
        amountCents: r.amountCents,
        waitingSince: iso(r.preparedAt),
        link: '/accounting/intercompany?tab=transfers',
        actions: [
          { kind: 'approve', label: 'Approve and post', method: 'POST', path: `${base}/approve`, body: {},
            confirm: 'Approve this transfer? It posts in both companies\' books now.', ...notBoth },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true }, ...notBoth },
        ],
      }
    })
  },
}

// ── Bad-debt write-offs (G12 / H15) ──────────────────────────────────────────
// receivables/writeOffs.ts: GET /accounting/receivables/write-offs?status=
// requested (FINANCIALS_VIEWERS), POST /write-offs/:id/approve | reject (note)
// — ADMIN_ONLY: the CEO approves every one. No requester-based disabled
// button: the CEO is exempt from self-approval (decision 27) and the route's
// assertNotSelfApproval decides.
const badDebts: ApprovalProvider = {
  type: 'bad_debt',
  label: 'Bad-debt write-offs',
  module: 'accounting',
  link: '/accounting/receivables',
  ...rightsOf('bad_debt'),
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; invoiceId: string; invoiceNumber: string | null; customerName: string | null
      conceptName: string | null; amountCents: number; reason: string; requestedAt: string; requestedByName: string | null
      attachments?: Array<{ id: string }>; invoice: { totalCents: number; balanceCents: number } | null
      requestedById?: string | null
    }
    const res = await ctx.read<{ items: Row[] }>('/accounting/receivables/write-offs?status=requested&limit=200')
    if (res === null) return null
    return res.items.map((r): ApprovalItem => {
      const base = `/accounting/receivables/write-offs/${r.id}`
      const files = r.attachments?.length ?? 0
      return {
        type: 'bad_debt',
        id: r.id,
        tenantId: r.tenantId,
        submittedByIds: idList(r.requestedById),
        title: `${r.invoiceNumber ?? 'Invoice'}${r.customerName ? ` — ${r.customerName}` : ''} — write off ${pkr(r.amountCents)}`,
        subtitle: r.reason,
        facts: facts([
          ['Invoice', r.invoiceNumber],
          ['Customer', r.customerName],
          ['Brand', r.conceptName],
          ['Write off', pkr(r.amountCents)],
          ['Still owed', r.invoice ? pkr(r.invoice.balanceCents) : null],
          ['Reason', r.reason],
          ['Evidence', `${files} file${files === 1 ? '' : 's'}`],
          ['Asked by', r.requestedByName],
        ]),
        amountCents: r.amountCents,
        waitingSince: iso(r.requestedAt),
        link: `/accounting/receivables?writeOff=${encodeURIComponent(r.id)}`,
        actions: [
          { kind: 'approve', label: 'Write off', method: 'POST', path: `${base}/approve`, body: {},
            confirm: 'Write this off as a bad debt? Dr 6160 Bad Debts / Cr 1110 today, tax included. Open the invoice to see the evidence first.' },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}

// ── Raast "void, never booked" (RV-MONEY-1) ──────────────────────────────────
// reconciliation/raastRoutes.ts: GET /reconciliation/raast/receipts?
// voidRequested=1 (FINANCE_TEAM — finance asked), POST /receipts/:id/void
// {reason ≥ 10} and /receipts/:id/void-request/reject {note} — ADMIN_ONLY. A
// receipt the CEO can no longer void (its bill moved on) is listed with the
// route's own reason on a disabled button; send-back stays.
const raastVoids: ApprovalProvider = {
  type: 'raast_void',
  label: 'Raast voids',
  module: 'reconciliation',
  link: '/reconciliation?tab=raast',
  ...rightsOf('raast_void'),
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; orderRef: string; brand: string | null; amountCents: number; bankRef: string | null
      orderStatus: string; createdAt: string; bankAccount: { name: string; bankName: string | null; last4: string | null } | null
      voidRequest: { at: string; by: { name: string | null } | null; reason: string | null; pending: boolean } | null
      canVoid?: boolean; canRejectVoidRequest?: boolean; voidBlockedReason: string | null
    }
    const res = await ctx.read<{ receipts: Row[] }>('/reconciliation/raast/receipts?voidRequested=1&limit=200')
    if (res === null) return null
    return res.receipts.filter((r) => r.voidRequest?.pending !== false).map((r): ApprovalItem => {
      const base = `/reconciliation/raast/receipts/${r.id}`
      return {
        type: 'raast_void',
        id: r.id,
        tenantId: r.tenantId,
        title: `Raast ${pkr(r.amountCents)} — order ${r.orderRef}${r.brand ? ` (${r.brand})` : ''}`,
        subtitle: r.voidRequest?.reason ?? null,
        facts: facts([
          ['Order', r.orderRef],
          ['Brand', r.brand],
          ['Amount', pkr(r.amountCents)],
          ['Bank reference', r.bankRef],
          ['Account', r.bankAccount ? `${r.bankAccount.name}${r.bankAccount.last4 ? ` ••${r.bankAccount.last4}` : ''}` : null],
          ['Bill', human(r.orderStatus)],
          ['Why void it', r.voidRequest?.reason],
          ['Asked by', r.voidRequest?.by?.name],
        ]),
        amountCents: r.amountCents,
        waitingSince: iso(r.voidRequest?.at ?? r.createdAt),
        link: '/reconciliation?tab=raast',
        actions: [
          { kind: 'approve', label: 'Void — never booked', method: 'POST', path: `${base}/void`, body: {},
            input: { field: 'reason', label: 'Why void it (at least 10 characters)', required: true },
            confirm: 'Void this receipt? No ledger entry is made and its bank reference stays used.',
            ...(r.canVoid === false && { disabledReason: r.voidBlockedReason ?? 'This receipt can no longer be voided — open Raast reconciliation' }) },
          { kind: 'reject', label: 'Send back', method: 'POST', path: `${base}/void-request/reject`, body: {},
            input: { field: 'note', label: 'Why not', required: true } },
        ],
      }
    })
  },
}

// ── Goods received, never billed — write-offs (H17) ──────────────────────────
// procurement/grniRoutes.ts: GET /procurement/grni?writeOffRequested=1
// (procurement + finance; module procurement or accounting), POST
// /procurement/grni/:receiptLineId/write-off/approve | reject (note) —
// ADMIN_ONLY.
const grniWriteOffs: ApprovalProvider = {
  type: 'grni_writeoff',
  label: 'Received, never billed',
  module: 'procurement',
  link: '/procurement/grni',
  ...rightsOf('grni_writeoff'),
  async load(ctx) {
    type Row = {
      receiptLineId: string; tenantId: string | null; supplierName: string | null; description: string
      openQty: number; unit: string | null; openValueCents: number; receivedAt: string
      writeOffRequest: { requestedAt: string; requestedById: string | null; reason: string | null } | null
    }
    const res = await ctx.read<{ lines: Row[] }>('/procurement/grni?writeOffRequested=1')
    if (res === null) return null
    const rows = res.lines.filter((l) => l.writeOffRequest)
    if (rows.length === 0) return []
    const names = await userNames(rows.map((r) => r.writeOffRequest?.requestedById))
    return rows.map((r): ApprovalItem => {
      const base = `/procurement/grni/${r.receiptLineId}/write-off`
      const asker = r.writeOffRequest?.requestedById
      return {
        type: 'grni_writeoff',
        id: r.receiptLineId,
        tenantId: r.tenantId,
        submittedByIds: idList(asker),
        title: `${r.supplierName ?? 'Supplier'} — ${r.description} — ${pkr(r.openValueCents)}`,
        subtitle: r.writeOffRequest?.reason ?? null,
        facts: facts([
          ['Supplier', r.supplierName],
          ['Item', r.description],
          ['Not billed', `${r.openQty}${r.unit ? ` ${r.unit}` : ''}`],
          ['Value', pkr(r.openValueCents)],
          ['Received', ymd(r.receivedAt)],
          ['Reason', r.writeOffRequest?.reason],
          ['Asked by', asker ? names.get(asker) : null],
        ]),
        amountCents: r.openValueCents,
        waitingSince: iso(r.writeOffRequest?.requestedAt ?? r.receivedAt),
        link: '/procurement/grni',
        actions: [
          { kind: 'approve', label: 'Write off', method: 'POST', path: `${base}/approve`, body: {},
            confirm: 'Write this off? The supplier will never bill it: Dr 2015 GRNI / Cr 5060 today.' },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}

// ── Stock differences in suspense (H20, owner 2026-10-14) ────────────────────
// Waste and count differences wait in 1290 Stock Differences Suspense until
// the CEO approves them into cost of sales. accounting (w4-answers):
// GET /accounting/stock-differences?status=pending (one row per suspense
// journal line), POST /accounting/stock-differences/approve { lineIds },
// POST /accounting/stock-differences/:id/query { note } (send back) — CEO
// only. If the read fails (ctx.read → null) the type is simply not listed.
//

const stockDifferences: ApprovalProvider = {
  type: 'stock_difference',
  label: 'Stock differences',
  module: 'accounting',
  link: '/finance/stock-differences',
  ...rightsOf('stock_difference'),
  async load(ctx) {
    // GET /accounting/stock-differences (stockDifferences/routes.ts): { rows: StockDifferenceRow[] }.
    type Row = {
      lineId: string; tenantId: string; itemName: string | null; locationName: string | null; conceptName: string | null
      kind: 'waste' | 'count' | 'void_waste' | string; reason: string | null; valueCents: number; entryDate: string; recordedByName: string | null
    }
    const res = await ctx.read<{ rows: Row[] }>('/accounting/stock-differences?status=pending&limit=500')
    if (res === null) return null
    const KIND: Record<string, string> = { waste: 'Waste', count: 'Count difference', void_waste: 'Sold line wasted' }
    return (res.rows ?? []).map((r): ApprovalItem => ({
      type: 'stock_difference',
      id: r.lineId,
      tenantId: r.tenantId,
      title: `${KIND[r.kind] ?? human(r.kind)} — ${r.itemName ?? 'Item'} — ${pkr(Math.abs(r.valueCents))}${r.valueCents < 0 ? ' over' : ''}`,
      subtitle: r.reason,
      facts: facts([
        ['Kind', KIND[r.kind] ?? human(r.kind)],
        ['Item', r.itemName],
        ['Outlet', r.locationName],
        ['Brand', r.conceptName],
        ['Value', pkr(Math.abs(r.valueCents))],
        ['Reason', r.reason],
        ['Date', ymd(r.entryDate)],
        ['By', r.recordedByName],
      ]),
      amountCents: r.valueCents,
      waitingSince: iso(r.entryDate),
      link: '/finance/stock-differences',
      actions: [
        { kind: 'approve', label: 'Approve into cost of sales', method: 'POST', path: '/accounting/stock-differences/approve', body: { lineIds: [r.lineId] },
          confirm: 'Approve this difference? It moves out of 1290 suspense into cost of sales.' },
        { kind: 'reject', label: 'Send back', method: 'POST', path: `/accounting/stock-differences/${encodeURIComponent(r.lineId)}/query`, body: {},
          input: { field: 'note', label: 'What needs checking', required: true } },
      ],
    }))
  },
}

// ── Manual journal requests (head office D1/D3) ──────────────────────────────
// accounting/journalRequestRoutes.ts (wave 2): GET /accounting/journal-requests?
// status=submitted, POST /accounting/journal-requests/:id/approve | reject
// (note). Kind post is Finance's (hand-over locked until the owner confirms,
// A22); kind reverse is the CEO's alone. Until the route exists it answers 404
// and the type is not listed.
const journalRequests: ApprovalProvider = {
  type: 'journal_request',
  label: APPROVAL_RIGHTS.journal_request.label,
  module: 'accounting',
  link: '/accounting/journal?tab=requests',
  ...rightsOf('journal_request'),
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; kind: string; status: string; description: string; reference: string | null
      entryDate: string | null; totalCents: number; preparedById: string; preparedByIds?: string[]; preparedByName?: string | null
      submittedById?: string | null; submittedAt: string | null; preparedAt?: string; viaHeadOfficeId?: string | null; reason?: string | null
      lines?: unknown[]
    }
    const res = await ctx.read<unknown>('/accounting/journal-requests?status=submitted&limit=200')
    if (res === null) return null
    return rowsOf<Row>(res, 'requests').filter((r) => r.status === 'submitted').map((r): ApprovalItem => {
      const base = `/accounting/journal-requests/${r.id}`
      const reverse = r.kind === 'reverse'
      return {
        type: 'journal_request',
        id: r.id,
        tenantId: r.tenantId,
        section: sectionOf('journal_request', { tenantId: r.tenantId, kind: r.kind }),
        submittedByIds: idList(r.preparedById, r.submittedById, r.preparedByIds ?? []),
        viaHeadOfficeId: r.viaHeadOfficeId ?? null,
        title: `${reverse ? 'Reverse' : 'Journal'}: ${r.description} — ${pkr(r.totalCents)}`,
        subtitle: r.reference,
        facts: facts([
          ['Kind', reverse ? 'Reversal' : 'Manual journal'],
          ['Amount', pkr(r.totalCents)],
          ['Date', r.entryDate ? ymd(r.entryDate) : null],
          ['Lines', r.lines ? String(r.lines.length) : null],
          ['Reason', r.reason],
          ['Prepared by', r.preparedByName],
        ]),
        amountCents: r.totalCents,
        waitingSince: iso(r.submittedAt ?? r.preparedAt),
        link: `/accounting/journal?tab=requests&id=${encodeURIComponent(r.id)}`,
        actions: [
          { kind: 'approve', label: reverse ? 'Approve reversal' : 'Approve and post', method: 'POST', path: `${base}/approve`, body: {},
            confirm: reverse ? 'Reverse this journal entry now?' : 'Post this journal to the books now?' },
          { kind: 'reject', label: 'Send back', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'What needs to change', required: true } },
        ],
      }
    })
  },
}

// ── Head-office recharge runs (D1) ───────────────────────────────────────────
// headOffices/runRoutes.ts (wave 2), mounted at /accounting/intercompany/
// recharge-runs: GET ?status=submitted, POST /:id/approve {postInOpenPeriod?,
// acknowledgeWarnings?} | /:id/reject (note). Owned by the head office:
// handed over head-office-wide only. Until the route exists it answers 404 and
// the type is not listed.
const rechargeRuns: ApprovalProvider = {
  type: 'ho_recharge',
  label: APPROVAL_RIGHTS.ho_recharge.label,
  module: 'accounting',
  link: '/accounting/intercompany?tab=recharges',
  ...rightsOf('ho_recharge'),
  async load(ctx) {
    type Line = { companyTenantId: string; companyName?: string | null; amountCents: number; shareBps?: number }
    type Row = {
      id: string; tenantId: string; headOfficeName?: string | null; period: string; kind: string; status: string
      baseCents: number; rechargedCents: number; retainedCents: number; warnings?: string[]; stale?: boolean
      preparedById?: string | null; preparedByIds?: string[]; submittedById?: string | null; submittedAt: string | null; preparedAt?: string
      lines?: Line[]
    }
    const res = await ctx.read<unknown>('/accounting/intercompany/recharge-runs?status=submitted')
    if (res === null) return null
    return rowsOf<Row>(res, 'runs').filter((r) => r.status === 'submitted').map((r): ApprovalItem => {
      const base = `/accounting/intercompany/recharge-runs/${r.id}`
      const warnings = r.warnings ?? []
      const lines = r.lines ?? []
      return {
        type: 'ho_recharge',
        id: r.id,
        tenantId: r.tenantId,
        ownerTenantId: r.tenantId,
        touchesTenantIds: idList(r.tenantId, lines.map((l) => l.companyTenantId)),
        submittedByIds: idList(r.preparedById, r.submittedById, r.preparedByIds ?? []),
        title: `${r.headOfficeName ?? 'Head office'} — ${r.kind === 'true_up' ? 'true-up' : 'recharge'} ${r.period} — ${pkr(r.rechargedCents)}`,
        subtitle: lines.map((l) => `${l.companyName ?? 'Company'} ${pkr(l.amountCents)}`).join(' · ') || null,
        facts: facts([
          ['Period', r.period],
          ['Kind', r.kind === 'true_up' ? 'True-up' : 'Monthly'],
          ['Head-office cost', pkr(r.baseCents)],
          ['Recharged', pkr(r.rechargedCents)],
          ['Kept by the head office', pkr(r.retainedCents)],
          ['Warnings', warnings.length ? warnings.join('; ') : null],
        ]),
        amountCents: r.rechargedCents,
        waitingSince: iso(r.submittedAt ?? r.preparedAt),
        link: `/accounting/intercompany?tab=recharges&run=${encodeURIComponent(r.id)}`,
        actions: [
          { kind: 'approve', label: 'Approve and post', method: 'POST', path: `${base}/approve`, body: {},
            confirm: 'Approve this recharge? It posts in the head office\'s and each company\'s books now.',
            options: [
              { field: 'postInOpenPeriod', label: 'If a month is closed, post into the first open month', kind: 'checkbox' },
              ...(warnings.length ? [{ field: 'acknowledgeWarnings', label: 'I have read the warnings', kind: 'checkbox' as const }] : []),
            ],
            ...(r.stale && { disabledReason: 'The costs moved since it was prepared — refresh it first' }) },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}

// ── POS connector change requests (Dev, D3) ──────────────────────────────────
// connectors/changeRequests.ts (wave 2): GET /connectors/change-requests?
// status=submitted, POST /connectors/change-requests/:id/approve | reject
// (note). Secrets are never returned. Until the route exists it answers 404
// and the type is not listed.
const connectorChanges: ApprovalProvider = {
  type: 'connector_change',
  label: APPROVAL_RIGHTS.connector_change.label,
  module: 'api_pos',
  link: '/connectors/pos?tab=changes',
  ...rightsOf('connector_change'),
  async load(ctx) {
    type Row = {
      id: string; tenantId: string; kind: string; status: string; patch?: Record<string, unknown> | null
      preparedById: string; preparedByIds?: string[]; preparedByName?: string | null; preparedAt: string
      viaHeadOfficeId?: string | null; secretsIncluded?: boolean
    }
    const res = await ctx.read<unknown>('/connectors/change-requests?status=submitted')
    if (res === null) return null
    return rowsOf<Row>(res, 'changes', 'requests').filter((r) => r.status === 'submitted').map((r): ApprovalItem => {
      const base = `/connectors/change-requests/${r.id}`
      const changed = Object.keys(r.patch ?? {})
      return {
        type: 'connector_change',
        id: r.id,
        tenantId: r.tenantId,
        submittedByIds: idList(r.preparedById, r.preparedByIds ?? []),
        viaHeadOfficeId: r.viaHeadOfficeId ?? null,
        title: `${r.kind === 'fiscal' ? 'Fiscal POS' : r.kind === 'terminal' ? 'Card machine' : human(r.kind)} settings`,
        subtitle: changed.length ? `Changes: ${changed.join(', ')}` : null,
        facts: facts([
          ['Connector', human(r.kind)],
          ['Changes', changed.join(', ') || null],
          ['New keys', r.secretsIncluded ? 'Yes (sealed)' : null],
          ['Asked by', r.preparedByName],
        ]),
        waitingSince: iso(r.preparedAt),
        link: '/connectors/pos?tab=changes',
        actions: [
          { kind: 'approve', label: 'Apply', method: 'POST', path: `${base}/approve`, body: {},
            confirm: 'Apply these connector settings now?' },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `${base}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}

// ── On-account clients — PARKED (owner, 2026-10-13) ──────────────────────────
// APPROVAL_TYPES still lists 'on_account_client' (w0), but the feature and its
// route are parked: no provider calls /accounting/customer-accounts. Nothing
// requires a provider per type (the inbox lists only registered providers), so
// none is registered; the resume adds it here (OA-clients, wave 2), taking
// approverRoles / delegable from the registry with ...rightsOf('on_account_client').

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
  cashRequestsHod,
  cashVouchers,
  fixedAssetRequests,
  intercompanyTransfers,
  rechargeRuns,
  journalRequests,
  badDebts,
  raastVoids,
  grniWriteOffs,
  stockDifferences,
  connectorChanges,
]

export type { ProviderContext }
