// Trash providers — finance masters (stream B6; see ../../README.md).
//
//   capex_project         CapexProject          soft      refused while a line is on the books (409
//                                                         PROJECT_HAS_POSTINGS); never erasable once any
//                                                         instalment of it EVER posted (meta.everPosted).
//   capex_line            CapexLine             snapshot  WITH its quotes and (never-live) instalments; parent:
//                                                         its project; never erasable once an instalment of it
//                                                         ever posted (meta.everPosted).
//   capex_quote           CapexQuote            snapshot  parent: its line; comes back as a non-winner when the
//                                                         line has a winner again.
//   opex_category         OpexCategory          soft      restore puts isActive back; never erasable with
//                                                         lines (meta.hadLines).
//   opex_line             OpexLine              status    "delete" = isActive false; parent: its category.
//   cost_allocation_rule  CostAllocationRule    soft      partial unique (tenantId, sourceAccountCode) among live
//                                                         rules → 409 on restore, not renamable; never erasable
//                                                         once it ran (its runs posted to the ledger).
//   tip_pool              TipPool               snapshot  DRAFT pools only, WITH members; every member's login /
//                                                         HR record must still exist.
//   recharge_split        RechargeSplit         snapshot  the CEO's; WITH its lines; restore re-checks the
//                                                         version rules (linked companies, months in use,
//                                                         one version per month → 409 SPLIT_EXISTS).
//   exception_flag        ExceptionFlag         status    "delete" = dismiss; Restore = reopen; never erasable.
//
// The F1–F5 money snapshots (sales_tax_payment, card_settlement,
// capex_payment, period_lock, payment_application) are WRITTEN by this
// stream's routes (in the reversal's transaction) and REGISTERED by the
// transactions stream (providers/transactions/moneySnapshots.ts) — never
// restorable, never erasable.
//
// Roles are the module routes' own guards, imported — never retyped. The
// route files hard-code these keys as string literals (importing this file
// from them would be a cycle); tests/trashFinance.test.ts pins both sides.

import type { TrashEntry, UserRole } from '@prisma/client'
import { AppError } from '../../../../lib/errors.js'
import { ADMIN_ONLY, FINANCE_TEAM } from '../../../auth/middleware.js'
import { CAPITAL_WRITERS } from '../../../financePlanning/routes.js'
import { recalcLinePaid } from '../../../financePlanning/capexPosting.js'
import { OPEX_TEAM } from '../../../opex/routes.js'
import { POOL_TEAM } from '../../../tipPools/routes.js'
import { restoreSplitVersionTx } from '../../../headOffices/splits.js'
import { restoreSnapshot, type Snapshot } from '../../snapshot.js'
import type { TrashProvider, Tx } from '../../types.js'

export const TRASH_FINANCE = {
  capex_project: 'capex_project',
  capex_line: 'capex_line',
  capex_quote: 'capex_quote',
  opex_category: 'opex_category',
  opex_line: 'opex_line',
  cost_allocation_rule: 'cost_allocation_rule',
  tip_pool: 'tip_pool',
  recharge_split: 'recharge_split',
  exception_flag: 'exception_flag',
} as const

/** The F1–F5 money snapshot keys this stream writes (registered in providers/transactions/moneySnapshots.ts). */
export const TRASH_MONEY_SNAPSHOTS = {
  sales_tax_payment: 'sales_tax_payment',
  card_settlement: 'card_settlement',
  capex_payment: 'capex_payment',
  period_lock: 'period_lock',
  payment_application: 'payment_application',
} as const

const metaOf = (e: TrashEntry | null) => (e?.meta ?? {}) as Record<string, unknown>
const snapOf = (e: TrashEntry) => e.snapshot as unknown as Snapshot | null
const rowOf = (e: TrashEntry): Record<string, unknown> => snapOf(e)?.row ?? {}
const brandParent = (e: TrashEntry) => (e.conceptId ? { type: 'brand', id: e.conceptId } : null)
const parentFromEntry = (e: TrashEntry) => (e.parentType && e.parentId ? { type: e.parentType, id: e.parentId } : null)

const CAPITAL_ROLES = CAPITAL_WRITERS as readonly UserRole[]
const OPEX_ROLES = OPEX_TEAM as readonly UserRole[]
const FINANCE_ROLES = FINANCE_TEAM as readonly UserRole[]
const CEO_ROLES = ADMIN_ONLY as readonly UserRole[]
const POOL_ROLES = POOL_TEAM as readonly UserRole[]

async function snapshotRestore(tx: Tx, entry: TrashEntry): Promise<string> {
  const snap = snapOf(entry)
  if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
  return restoreSnapshot(tx, snap, { tenantId: entry.tenantId })
}

/** The project a capex line / quote hangs from must exist (a purged project cannot take its line back). */
async function assertLiveCapexLine(tx: Tx, lineId: string): Promise<void> {
  const line = await tx.capexLine.findFirst({ where: { id: lineId, project: { deletedAt: null } }, select: { id: true } })
  if (!line) throw new AppError('PARENT_GONE', 'The CapEx line this belonged to no longer exists — add it again on the project', 409)
}

// ── CapEx ────────────────────────────────────────────────────────────────────

const capexProject: TrashProvider = {
  key: TRASH_FINANCE.capex_project,
  label: 'CapEx project',
  moduleId: 'capital',
  roles: { list: CAPITAL_ROLES, restore: CAPITAL_ROLES },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'accounting',
  model: 'CapexProject',
  linkOf: () => '/finance/capex',
  parentOf: brandParent,
  async references(tx, entry) {
    const [assets, opexLines] = await Promise.all([
      tx.fixedAsset.count({ where: { capexLine: { projectId: entry.entityId } } }),
      tx.opexLine.count({ where: { projectId: entry.entityId } }),
    ])
    return [
      { label: 'Fixed assets', count: assets },
      { label: 'Running costs linked to it', count: opexLines },
    ].filter((r) => r.count > 0)
  },
  // Anything of it that ever reached the books keeps it for ever.
  erasable: (entry) => metaOf(entry).everPosted !== true,
}

const capexLine: TrashProvider = {
  key: TRASH_FINANCE.capex_line,
  label: 'CapEx line',
  moduleId: 'capital',
  roles: { list: CAPITAL_ROLES, restore: CAPITAL_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'accounting',
  model: 'CapexLine',
  linkOf: () => '/finance/capex',
  parentOf: parentFromEntry,
  async restore(tx, _ctx, entry) {
    const projectId = String(rowOf(entry).projectId ?? '')
    const project = projectId ? await tx.capexProject.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } }) : null
    if (!project) throw new AppError('PARENT_GONE', 'The CapEx project this line belonged to no longer exists', 409)
    const id = await snapshotRestore(tx, entry)
    // Exactly the rows it had (quotes, instalments that never stayed on the
    // books): nothing posts; the line's paid total is recomputed from them.
    await recalcLinePaid(id, tx)
    return { id, link: '/finance/capex' }
  },
  erasable: (entry) => metaOf(entry).everPosted !== true,
}

const capexQuote: TrashProvider = {
  key: TRASH_FINANCE.capex_quote,
  label: 'CapEx quote',
  moduleId: 'capital',
  roles: { list: CAPITAL_ROLES, restore: CAPITAL_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'accounting',
  model: 'CapexQuote',
  linkOf: () => '/finance/capex',
  parentOf: parentFromEntry,
  async restore(tx, _ctx, entry) {
    const snap = snapOf(entry)
    if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
    const lineId = String(snap.row.lineId ?? '')
    await assertLiveCapexLine(tx, lineId)
    // The winner is chosen on the line; a returning quote never takes it back.
    const id = await restoreSnapshot(tx, snap, { tenantId: entry.tenantId, override: { isWinner: false } })
    return { id, link: '/finance/capex' }
  },
  erasable: () => true,
}

// ── OpEx ─────────────────────────────────────────────────────────────────────

const opexCategory: TrashProvider = {
  key: TRASH_FINANCE.opex_category,
  label: 'Running-cost category',
  moduleId: 'capital',
  roles: { list: OPEX_ROLES, restore: OPEX_ROLES },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'accounting',
  model: 'OpexCategory',
  linkOf: () => '/finance/opex',
  parentOf: brandParent,
  async restore(tx, _ctx, entry) {
    const prev = (metaOf(entry).previous ?? {}) as { isActive?: boolean }
    await tx.opexCategory.update({
      where: { id: entry.entityId },
      data: { deletedAt: null, isActive: prev.isActive ?? true },
    })
    return { id: entry.entityId, link: '/finance/opex' }
  },
  async references(tx, entry) {
    const lines = await tx.opexLine.count({ where: { categoryId: entry.entityId } })
    return lines ? [{ label: 'Running-cost lines', count: lines }] : []
  },
  erasable: (entry) => metaOf(entry).hadLines !== true,
}

const opexLine: TrashProvider = {
  key: TRASH_FINANCE.opex_line,
  label: 'Running-cost line',
  moduleId: 'capital',
  roles: { list: OPEX_ROLES, restore: OPEX_ROLES },
  kind: 'master',
  strategy: 'status',
  auditCategory: 'accounting',
  model: 'OpexLine',
  linkOf: () => '/finance/opex',
  parentOf: parentFromEntry,
  erasable: () => false,
}

// ── Cost allocation rule ─────────────────────────────────────────────────────

const costAllocationRule: TrashProvider = {
  key: TRASH_FINANCE.cost_allocation_rule,
  label: 'Cost allocation rule',
  moduleId: 'accounting',
  roles: { list: FINANCE_ROLES, restore: CEO_ROLES },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'accounting',
  model: 'CostAllocationRule',
  linkOf: () => '/allocations',
  async clashOf(tx, entry) {
    const rule = await tx.costAllocationRule.findUnique({ where: { id: entry.entityId }, select: { tenantId: true, sourceAccountCode: true } })
    if (!rule) return null
    const live = await tx.costAllocationRule.findFirst({
      where: { tenantId: rule.tenantId, sourceAccountCode: rule.sourceAccountCode, deletedAt: null, id: { not: entry.entityId } },
      select: { id: true },
    })
    return live
      ? {
          field: 'sourceAccountCode', value: rule.sourceAccountCode, renamable: false,
          message: `A live rule already splits ${rule.sourceAccountCode} — edit the live rule for ${rule.sourceAccountCode} instead`,
        }
      : null
  },
  async restore(tx, _ctx, entry) {
    const prev = (metaOf(entry).previous ?? {}) as { isActive?: boolean }
    await tx.costAllocationRule.update({
      where: { id: entry.entityId },
      data: { deletedAt: null, isActive: prev.isActive ?? true },
    })
    return { id: entry.entityId, link: '/allocations' }
  },
  async references(tx, entry) {
    const runs = await tx.costAllocationRun.count({ where: { ruleId: entry.entityId } })
    return runs ? [{ label: 'Allocation runs on the books', count: runs }] : []
  },
  // A rule that ran posted to the ledger: kept for ever.
  erasable: (entry) => metaOf(entry).hasRuns !== true,
}

// ── Tip pool (draft) ─────────────────────────────────────────────────────────

const tipPool: TrashProvider = {
  key: TRASH_FINANCE.tip_pool,
  label: 'Tip pool draft',
  moduleId: 'payroll',
  roles: { list: POOL_ROLES, restore: POOL_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'accounting',
  model: 'TipPool',
  linkOf: () => '/tip-pools',
  parentOf: brandParent,
  async restore(tx, _ctx, entry) {
    const members = snapOf(entry)?.children?.TipPoolMember ?? []
    const userIds = [...new Set(members.map((m) => m.userId).filter((v): v is string => typeof v === 'string'))]
    const empIds = [...new Set(members.map((m) => m.employeeId).filter((v): v is string => typeof v === 'string'))]
    const [users, emps] = await Promise.all([
      userIds.length ? tx.user.count({ where: { id: { in: userIds } } }) : 0,
      empIds.length ? tx.hrEmployee.count({ where: { id: { in: empIds } } }) : 0,
    ])
    if (users !== userIds.length || emps !== empIds.length) {
      throw new AppError('MEMBER_GONE', 'Someone in this pool no longer exists — compute the pool again instead', 409)
    }
    const id = await snapshotRestore(tx, entry)
    return { id, link: '/tip-pools' }
  },
  erasable: () => true,
}

// ── Head-office % table ──────────────────────────────────────────────────────

const rechargeSplit: TrashProvider = {
  key: TRASH_FINANCE.recharge_split,
  label: 'Head-office % table',
  moduleId: 'tenants',
  roles: { list: CEO_ROLES, restore: CEO_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'accounting',
  ceoOnly: true,
  model: 'RechargeSplit',
  linkOf: (_id, entry) => (entry?.tenantId ? `/ceo/head-offices/${entry.tenantId}` : '/ceo/head-offices'),
  async clashOf(tx, entry) {
    const from = String(rowOf(entry).effectiveFrom ?? '')
    if (!from || !entry.tenantId) return null
    const live = await tx.rechargeSplit.findUnique({
      where: { tenantId_effectiveFrom: { tenantId: entry.tenantId, effectiveFrom: from } },
      select: { id: true },
    })
    return live
      ? { field: 'effectiveFrom', value: from, renamable: false, code: 'SPLIT_EXISTS', message: `A % table already starts in ${from} — delete it first, then restore this one` }
      : null
  },
  async restore(tx, _ctx, entry) {
    const snap = snapOf(entry)
    if (!snap || !entry.tenantId) throw new AppError('PURGED', 'This item was deleted forever', 409)
    const id = await restoreSplitVersionTx(tx, { hoId: entry.tenantId, snapshot: snap })
    return { id, link: `/ceo/head-offices/${entry.tenantId}` }
  },
  erasable: () => true,
}

// ── Exception flag (dismissed) ───────────────────────────────────────────────

const exceptionFlag: TrashProvider = {
  key: TRASH_FINANCE.exception_flag,
  label: 'Dismissed exception',
  moduleId: 'exceptions',
  roles: { list: FINANCE_ROLES, restore: CEO_ROLES },
  kind: 'master',
  strategy: 'status',
  auditCategory: 'accounting',
  model: 'ExceptionFlag',
  linkOf: () => '/exceptions',
  erasable: () => false,
}

export const FINANCE_TRASH_PROVIDERS: TrashProvider[] = [
  capexProject,
  capexLine,
  capexQuote,
  opexCategory,
  opexLine,
  costAllocationRule,
  tipPool,
  rechargeSplit,
  exceptionFlag,
]
