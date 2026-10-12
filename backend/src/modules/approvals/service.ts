// The approvals inbox: run every provider the user may approve, keep only the
// companies in view, and count per type. Read-only — see README.md.

import { prisma } from '../../lib/prisma.js'
import { APPROVAL_PROVIDERS } from './providers.js'
import { NO_DELEGATIONS, type ApprovalDelegations } from './delegations.js'
import type { ApprovalInbox, ApprovalItem, ApprovalProvider, ApprovalType, ApprovalTypeSummary, ProviderContext } from './types.js'

/**
 * May this user approve this type at all? The module's own approver roles —
 * or, later, a live delegation of the type (delegations.ts). Per-item types
 * (HR steps) are always asked: the module decides each row.
 */
export function mayApprove(p: ApprovalProvider, role: string, delegated: ReadonlySet<ApprovalType>): boolean {
  if (p.approverRoles === null) return true
  return (p.approverRoles as readonly string[]).includes(role) || delegated.has(p.type)
}

export interface CollectOptions {
  /** Only this type (the page's filter). Counts still cover every type. */
  only?: ApprovalType
  delegations?: ApprovalDelegations
  providers?: readonly ApprovalProvider[]
}

export async function collectApprovals(ctx: ProviderContext, opts: CollectOptions = {}): Promise<ApprovalInbox> {
  const providers = opts.providers ?? APPROVAL_PROVIDERS
  const delegated = await (opts.delegations ?? NO_DELEGATIONS).typesFor(ctx.user.id, ctx.tenantIds)
  const inView = new Set(ctx.tenantIds)
  const member = new Set(ctx.memberTenantIds)
  const eligible = providers.filter((p) => mayApprove(p, ctx.user.role, delegated))

  const results = await Promise.all(eligible.map(async (p) => {
    try {
      const rows = await p.load(ctx)
      // The module's queue route refused this user (their role, or the CEO's
      // Module Access switch): not one of their types.
      if (rows === null) return { p, items: [] as ApprovalItem[], elsewhere: 0, error: false, refused: true }
      // Counts are per company in view — except a type whose module's queue
      // spans every company the user belongs to (HR steps), which stays
      // bounded by membership. A row with no company is the module's own
      // legacy case (a company-less signup, an orphan supplier, a shared site
      // page) that its queue route already chose to show.
      const keep = (id: string) => (p.spansMemberCompanies ? member.has(id) || inView.has(id) : inView.has(id))
      const items = rows.filter((i) => i.tenantId === null || keep(i.tenantId))
      // Other companies of the user's own: counted (never listed) so the page
      // can point at "All companies".
      const elsewhere = rows.filter((i) => i.tenantId !== null && !keep(i.tenantId) && member.has(i.tenantId)).length
      return { p, items, elsewhere, error: false, refused: false }
    } catch {
      return { p, items: [] as ApprovalItem[], elsewhere: 0, error: true, refused: false }
    }
  }))

  const types: ApprovalTypeSummary[] = []
  const items: ApprovalItem[] = []
  for (const { p, items: rows, elsewhere, error, refused } of results) {
    if (refused) continue
    // A per-item type with nothing for this user is not one of their types —
    // unless their role is one that type's steps name.
    const listed = p.approverRoles !== null || rows.length > 0 || elsewhere > 0 || error
      || (p.alwaysListFor ?? []).includes(ctx.user.role)
    if (!listed) continue
    types.push({
      type: p.type, label: p.label, module: p.module, link: p.link, count: rows.length,
      ...(elsewhere > 0 && { elsewhere }), ...(error && { error: true as const }),
    })
    if (!opts.only || opts.only === p.type) items.push(...rows)
  }

  // Company names, for "All companies" view.
  const ids = Array.from(new Set(items.map((i) => i.tenantId).filter((x): x is string => !!x)))
  if (ids.length) {
    const names = new Map((await prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]))
    for (const i of items) i.companyName = i.tenantId ? (names.get(i.tenantId) ?? null) : null
  }
  // Oldest first within the page: what has waited longest is first.
  items.sort((a, b) => (a.waitingSince ?? '').localeCompare(b.waitingSince ?? ''))

  return {
    total: types.reduce((n, t) => n + t.count, 0),
    elsewhere: types.reduce((n, t) => n + (t.elsewhere ?? 0), 0),
    types,
    items,
  }
}
