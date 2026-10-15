// Trash — the F1–F5 money records (stream B7 registers them; stream B6's routes
// WRITE them with moveToTrash + takeSnapshot in the reversal's transaction).
// Before the Trash these rows were simply erased; now each is kept for ever as
// a snapshot: NEVER restored (the books were reversed — putting the row back
// would disagree with them), NEVER erased (money / tax), only viewed, archived
// by the CEO, and — for two of them — recovered as a copy.
//
//   sales_tax_payment    F1  a voided tax payment. Copy = PREFILL of the
//                            tax-payments register: authority, period,
//                            set-offs, amount. Never: the CPR #, the bank, the
//                            link, the posting.
//   card_settlement      F2  an undone card payout. Not copyable: rematch it in
//                            Finance → Reconciliation (its days are free again).
//   capex_payment        F3  a deleted CapEx instalment. Copy = PREFILL of the
//                            instalment on its line (while the line exists):
//                            label, amount, due date, prepaid term. Never: the
//                            paid state, WHT snapshot, reference, posting.
//   period_lock          F4  a reopened month close (CEO only). Not copyable:
//                            close the month again (CLOSE_CHECKS).
//   payment_application  F5  an unapplied supplier payment / credit allocation.
//                            Not copyable: allocate it again on the payment.
//
// These types are entry-backed (strategy 'snapshot'), so the core lists them
// from trash_entries with the entry's company scope; kind 'transaction' makes
// the core refuse restore (NOT_RESTORABLE) and purge (NOT_ERASABLE).

import type { TrashEntry, UserRole } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { AppError, NotFoundError } from '../../../../lib/errors.js'
import { ADMIN_ONLY, FINANCE_TEAM, FINANCIALS_VIEWERS, MANAGERS } from '../../../auth/middleware.js'
import { TAX_PAYER_ROLES } from '../../../accounting/taxPayments.js'
import { CAPITAL_WRITERS } from '../../../financePlanning/routes.js'
import type { Snapshot } from '../../snapshot.js'
import type { TrashCtx, TrashProvider } from '../../types.js'
import { n, pktDate, prefill, roles, scopeIds } from './common.js'

export const TRASH_MONEY = {
  sales_tax_payment: 'sales_tax_payment',
  card_settlement: 'card_settlement',
  capex_payment: 'capex_payment',
  period_lock: 'period_lock',
  payment_application: 'payment_application',
} as const

const FIN_VIEW = roles(FINANCIALS_VIEWERS)
const TAX_PAY = roles(TAX_PAYER_ROLES)
const RECON = roles(FINANCE_TEAM)
const CAPITAL = roles(CAPITAL_WRITERS)
const CEO = roles(ADMIN_ONLY)
const MGR = roles(MANAGERS)

const base = {
  kind: 'transaction',
  strategy: 'snapshot',
  auditCategory: 'accounting',
  restorable: false,
  erasable: () => false,
} as const

/** The latest entry of this type for `id`, in the caller's read scope (CEO: company-less too), with its snapshot row. */
async function snapshotRow(ctx: TrashCtx, type: string, id: string): Promise<{ entry: TrashEntry; row: Record<string, unknown> }> {
  const ids = scopeIds(ctx.readScope)
  const entry = await db.trashEntry.findFirst({
    where: { entityType: type, entityId: id, ...(ctx.isCeo ? { OR: [{ tenantId: { in: ids } }, { tenantId: null }] } : { tenantId: { in: ids } }) },
    orderBy: { createdAt: 'desc' },
  })
  if (!entry) throw new NotFoundError('Trash item', id)
  const snap = entry.snapshot as unknown as Snapshot | null
  if (!snap?.row) throw new AppError('PURGED', 'This record was erased — nothing is left to copy', 409)
  return { entry, row: snap.row }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

const salesTaxPayment: TrashProvider = {
  ...base,
  key: TRASH_MONEY.sales_tax_payment,
  label: 'Voided tax payment',
  moduleId: 'accounting',
  roles: { list: FIN_VIEW, restore: TAX_PAY, copy: TAX_PAY },
  linkOf: () => '/accounting/sales-tax-return',
  async copy(ctx, id) {
    const { row } = await snapshotRow(ctx, TRASH_MONEY.sales_tax_payment, id)
    // Never: cprNumber, bankAccountId, journalEntryId, linked, paidAt.
    return prefill('/accounting/sales-tax-return', {
      authority: str(row.authority),
      periodFrom: pktDate(str(row.periodFrom)),
      periodTo: pktDate(str(row.periodTo)),
      paidCents: n(row.paidCents),
      outputSetOffCents: n(row.outputSetOffCents),
      inputSetOffCents: n(row.inputSetOffCents),
      customerWithheldSetOffCents: n(row.customerWithheldSetOffCents),
      notes: str(row.notes),
    })
  },
}

const cardSettlement: TrashProvider = {
  ...base,
  key: TRASH_MONEY.card_settlement,
  label: 'Undone card payout',
  moduleId: 'reconciliation',
  roles: { list: RECON, restore: RECON },
  linkOf: () => '/reconciliation',
  notCopyableReason: 'Match the payout again in Finance → Reconciliation — its days are free again',
}

const capexPayment: TrashProvider = {
  ...base,
  key: TRASH_MONEY.capex_payment,
  label: 'Deleted CapEx instalment',
  moduleId: 'capital',
  roles: { list: CAPITAL, restore: CAPITAL, copy: CAPITAL },
  linkOf: () => '/finance/capex',
  parentOf: (e) => (e.parentType && e.parentId ? { type: e.parentType, id: e.parentId } : null),
  async copy(ctx, id) {
    const { entry, row } = await snapshotRow(ctx, TRASH_MONEY.capex_payment, id)
    const lineId = str(row.lineId) ?? entry.parentId
    const line = lineId
      ? await db.capexLine.findFirst({ where: { id: lineId, project: { tenantId: entry.tenantId, deletedAt: null } }, select: { id: true, projectId: true } })
      : null
    if (!line) throw new AppError('LINE_GONE', 'The CapEx line of this instalment no longer exists — restore the line first, or add the instalment to another', 422)
    // Never: paid state / amount, WHT snapshot, reference, bank account, deposit returns, the posting.
    return prefill('/finance/capex', {
      projectId: line.projectId,
      lineId: line.id,
      capexLineId: line.id,
      label: str(row.label),
      amountCents: n(row.amountCents),
      dueDate: pktDate(str(row.dueDate)),
      coversFrom: str(row.coversFrom),
      coversMonths: typeof row.coversMonths === 'number' ? row.coversMonths : null,
      notes: str(row.notes),
    })
  },
}

const periodLock: TrashProvider = {
  ...base,
  key: TRASH_MONEY.period_lock,
  label: 'Reopened month close',
  moduleId: 'accounting',
  roles: { list: CEO, restore: CEO },
  ceoOnly: true,
  linkOf: () => '/accounting/period-close',
  notCopyableReason: 'Close the month again on Period close — the checklist runs again',
}

const paymentApplication: TrashProvider = {
  ...base,
  key: TRASH_MONEY.payment_application,
  label: 'Unapplied supplier allocation',
  moduleId: 'procurement',
  roles: { list: MGR, restore: MGR },
  linkOf: () => '/procurement',
  notCopyableReason: 'Allocate the payment or credit note to the bill again on Procurement',
}

export const MONEY_SNAPSHOT_TRASH_PROVIDERS: readonly TrashProvider[] = [
  salesTaxPayment, cardSettlement, capexPayment, periodLock, paymentApplication,
]

/** Exported for tests / the finance stream: the roles each money record is shown to. */
export const MONEY_SNAPSHOT_ROLES: Record<string, readonly UserRole[]> = {
  sales_tax_payment: FIN_VIEW, card_settlement: RECON, capex_payment: CAPITAL, period_lock: CEO, payment_application: MGR,
}
