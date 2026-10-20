// The bell's approval notices (owner, 2026-10-16): "for Approvals pending at
// CEO's end it should notify CEO for pending approvals; once approved by CEO it
// should notify the user who's waiting for approval".
//
//   approvalWaiting(type, id, { round, actorId })   an item entered a queue →
//       every person who must act next (lib/approvalRights.ts approverIdsFor:
//       the approve route's own rule + the inbox's module; the CEO only for
//       items at the CEO's end, and on a hand-over the delegate AND the CEO).
//   approvalDecided({ … })                          approve / reject / return →
//       the people waiting on it (approvalSubject.submitterIds, + per type).
//       Called once, from lib/approvalRights.ts auditApproval (the one
//       `approval.decide` writer).
//   APPROVAL_NOTIFY                                  one entry per approval type:
//       wording, the decided link, extra recipients, event-less types.
//
// Both are FIRE-AND-FORGET: they queue the work (lib/staffNotify.ts
// queueStaffNotify) and return at once; nothing here can fail the business
// action. Call them AFTER the business transaction has committed — never inside
// a `$transaction(` callback or a function that takes a `tx` (tested). The
// queued job re-reads the item when it runs: an item decided (or rolled back)
// in the meantime is not announced as waiting; a decided item that is gone is
// not announced at all.
//
// `round` is REQUIRED on approvalWaiting and comes from the submit write itself
// (the row's updatedAt, `r<returnCount>`, `limit:<limitRequestedAt>`,
// `step:<key>:<updatedAt>` …): the same submit retried dedupes, a resubmit
// after a reject / return / reopen notifies again. Decided notices dedupe on
// the decision's own timestamp (`decidedAt`).
//
// No secrets or customer PII in titles / bodies: references, amounts, staff
// names and corporate client names only.

import { serviceClient } from '../../lib/prisma.js'
import { queueStaffNotify, notifyStaffMany, type NotifyInput, type NotificationSeverity } from '../../lib/staffNotify.js'
import {
  APPROVAL_RIGHTS, APPROVAL_TYPES, approvalSubject, approverIdsFor, isApprovalType,
  type ApprovalSubject, type ApprovalType,
} from '../../lib/approvalRights.js'
import { orderRefOf } from '../../lib/orderRef.js'

/** What a notice says about one item (read on serviceClient when the job runs). */
export interface ApprovalFacts {
  /** "PO 84213", "Cash request CV-00042", "Payroll 2026-10" … */
  ref: string
  amountCents?: number | null
  companyName?: string | null
  /** A second line (supplier, step, reason …). */
  detail?: string | null
}

export interface ApprovalNotifySpec {
  waitingTitle(s: ApprovalSubject, f: ApprovalFacts): string
  /** The module's own screen for the person waiting on the decision (null = none). */
  decidedLink(id: string): string | null
  /** More people waiting on a decision than approvalSubject's submitters. */
  extraRecipients?(id: string, e: ApprovalDecidedEvent): Promise<string[]>
  /** No submit event (window-over tip pools, postings into 1290): the bell's
   *  live approvals count covers them; no per-item waiting notice. */
  eventless?: true
}

export interface ApprovalDecidedEvent {
  type: ApprovalType
  id: string
  /** The item's company (the audit row's); null = a company-less item (CEO-only). */
  tenantId: string | null
  /** approve | post | pay | reject | return | cancel (anything else — lock, reopen — sends nothing). */
  decision: string
  actorId: string
  note?: string | null
  /** ISO time stamped by the route's own write (the dedupe key). */
  decidedAt: string
  /** false = a step of a multi-step item (an HR step, finance's approval of a cash voucher): more is to come. */
  final?: boolean
  /** storefront_publish: an approval with a publish time is "scheduled", not "published". */
  publishAt?: string | null
  /** Who was waiting, read by the route BEFORE a decision that clears its requester column
   *  (on-account limit increase). When given, it replaces approvalSubject's submitters. */
  waitingUserIds?: string[]
}

// ─── Wording ────────────────────────────────────────────────────────────────

export function formatPkr(cents: number | null | undefined): string | null {
  if (cents == null || !Number.isFinite(Number(cents))) return null
  const rupees = Number(cents) / 100
  const whole = Number.isInteger(rupees)
  return `PKR ${rupees.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`
}

const human = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ').trim()
const short = (id: string) => id.slice(-8).toUpperCase()

function defaultWaitingTitle(_s: ApprovalSubject, f: ApprovalFacts): string {
  const amount = formatPkr(f.amountCents)
  return `${f.ref} waiting for your approval${amount ? ` — ${amount}` : ''}${f.companyName ? ` (${f.companyName})` : ''}`
}

const spec = (decidedLink: (id: string) => string | null, extra: Partial<ApprovalNotifySpec> = {}): ApprovalNotifySpec => ({
  waitingTitle: defaultWaitingTitle, decidedLink, ...extra,
})

/** The employee's own login of an HR record (they are waiting on its outcome too). */
async function hrEmployeeLogin(id: string): Promise<string[]> {
  const rec = await serviceClient.hrRecord.findUnique({ where: { id }, select: { tenantId: true, employeeId: true } })
  if (!rec?.employeeId) return []
  const emp = await serviceClient.hrEmployee.findFirst({ where: { id: rec.employeeId, tenantId: rec.tenantId }, select: { userId: true } })
  return emp?.userId ? [emp.userId] : []
}

/** One entry per approval type (tested: every APPROVAL_TYPES entry has one). */
export const APPROVAL_NOTIFY: Readonly<Record<ApprovalType, ApprovalNotifySpec>> = {
  staff_login: spec(() => '/workforce'),
  storefront_publish: spec(() => '/storefront?tab=approvals'),
  purchase_order: spec(() => '/procurement'),
  recipe: spec((id) => `/accounting/recipes/${encodeURIComponent(id)}`),
  hr_request: spec(() => '/hr/me', {
    // The employee is told the OUTCOME (final approval or a rejection), never each step.
    async extraRecipients(id, e) {
      if (decisionOutcome(e.decision) === 'approved' && e.final === false) return []
      return hrEmployeeLogin(id)
    },
  }),
  payroll_run: spec((id) => `/hr/payroll/${encodeURIComponent(id)}`),
  tip_pool: spec(() => '/tip-pools', { eventless: true }),
  stock_transfer: spec(() => null),
  cash_voucher: spec((id) => `/finance/cash-vouchers?id=${encodeURIComponent(id)}`),
  fixed_asset_request: spec(() => '/accounting/fixed-assets/requests'),
  intercompany_transfer: spec(() => '/accounting/intercompany?tab=transfers'),
  on_account_client: spec(() => '/accounting/receivables'),
  bad_debt: spec((id) => `/accounting/receivables?writeOff=${encodeURIComponent(id)}`),
  raast_void: spec(() => '/reconciliation?tab=raast'),
  grni_writeoff: spec(() => '/procurement/grni'),
  cash_request_hod: spec(() => null, { eventless: true }), // retired 2026-10-15: no hook, no provider
  cash_request_finance: spec((id) => `/finance/cash-vouchers?id=${encodeURIComponent(id)}`, {
    waitingTitle: (_s, f) => {
      const amount = formatPkr(f.amountCents)
      return `${f.ref} needs finance approval${amount ? ` — ${amount}` : ''}${f.companyName ? ` (${f.companyName})` : ''}`
    },
  }),
  stock_difference: spec(() => '/finance/stock-differences', { eventless: true }),
  journal_request: spec((id) => `/accounting/journal?tab=requests&id=${encodeURIComponent(id)}`),
  ho_recharge: spec((id) => `/accounting/intercompany?tab=recharges&run=${encodeURIComponent(id)}`),
  connector_change: spec(() => '/connectors/pos?tab=changes'),
}

/** The inbox, filtered to the type (every login may open it). */
export const waitingLink = (type: ApprovalType) => `/ceo/approvals?type=${type}`

/** The facts of one item (serviceClient). Never throws: falls back to the type's label. */
export async function describeApproval(type: ApprovalType, id: string, s: ApprovalSubject | null): Promise<ApprovalFacts> {
  const label = APPROVAL_RIGHTS[type].label
  let f: ApprovalFacts = { ref: label }
  try {
    f = await describeInner(type, id) ?? f
  } catch { /* the label is enough */ }
  const company = s?.ownerTenantId ?? s?.companyIds[0] ?? null
  if (company) {
    try {
      f.companyName = (await serviceClient.tenant.findUnique({ where: { id: company }, select: { name: true } }))?.name ?? null
    } catch { /* optional */ }
  }
  return f
}

async function describeInner(type: ApprovalType, id: string): Promise<ApprovalFacts | null> {
  const db = serviceClient
  switch (type) {
    case 'staff_login': {
      const u = await db.user.findUnique({ where: { id }, select: { name: true, role: true } })
      return u && { ref: `New login ${u.name ?? ''}`.trim(), detail: `Role: ${human(u.role)}` }
    }
    case 'storefront_publish': {
      const l = await db.siteLayout.findFirst({ where: { OR: [{ id }, { slug: id }] }, select: { title: true, slug: true } })
      return l && { ref: `Website change ${l.title ?? l.slug}` }
    }
    case 'purchase_order': {
      const p = await db.purchaseOrder.findUnique({ where: { id }, select: { reference: true, totalCents: true, supplier: { select: { name: true } } } })
      return p && { ref: `PO ${p.reference ?? short(id)}`, amountCents: Number(p.totalCents), detail: p.supplier?.name ? `Supplier: ${p.supplier.name}` : null }
    }
    case 'recipe': {
      const r = await db.recipe.findUnique({ where: { id }, select: { name: true } })
      return r && { ref: `Recipe ${r.name ?? short(id)}` }
    }
    case 'hr_request': {
      const h = await db.hrRecord.findUnique({ where: { id }, select: { section: true, employeeId: true, tenantId: true } })
      if (!h) return null
      const { sectionByKey } = await import('../hr/forms.js')
      const emp = h.employeeId ? await db.hrEmployee.findFirst({ where: { id: h.employeeId, tenantId: h.tenantId }, select: { fullName: true } }) : null
      const title = sectionByKey(h.section)?.title ?? human(h.section)
      return { ref: `${title}${emp?.fullName ? ` — ${emp.fullName}` : ''}` }
    }
    case 'payroll_run': {
      const p = await db.hrPayrollRun.findUnique({ where: { id }, select: { period: true } })
      return p && { ref: `Payroll ${p.period}` }
    }
    case 'tip_pool': {
      const t = await db.tipPool.findUnique({ where: { id }, select: { name: true } })
      return t && { ref: `Tip pool ${t.name}` }
    }
    case 'stock_transfer': {
      const t = await db.stockTransfer.findUnique({ where: { id }, select: { quantity: true, unit: true, inventoryItem: { select: { name: true } } } })
      return t && { ref: `Stock transfer ${t.quantity} ${t.unit} ${t.inventoryItem?.name ?? ''}`.trim() }
    }
    case 'cash_voucher':
    case 'cash_request_hod':
    case 'cash_request_finance': {
      const c = await db.cashVoucher.findUnique({ where: { id }, select: { number: true, amountCents: true } })
      return c && { ref: `Cash request ${c.number}`, amountCents: c.amountCents }
    }
    case 'fixed_asset_request': {
      const e = await db.fixedAssetEvent.findUnique({ where: { id }, select: { kind: true, amountCents: true } })
      return e && { ref: `Fixed asset ${human(e.kind)}`, amountCents: e.amountCents == null ? null : Number(e.amountCents) }
    }
    case 'intercompany_transfer': {
      const t = await db.intercompanyTransfer.findUnique({ where: { id }, select: { kind: true, amountCents: true } })
      return t && { ref: `Inter-company ${human(t.kind)}`, amountCents: Number(t.amountCents) }
    }
    case 'on_account_client': {
      const c = await db.customerAccount.findUnique({ where: { id }, select: { number: true, legalName: true, status: true, requestedCreditLimitCents: true, creditLimitCents: true } })
      if (!c) return null
      const increase = c.status !== 'pending' && c.requestedCreditLimitCents != null
      return {
        ref: `${increase ? 'Credit limit increase' : 'On-account client'} ${c.number} ${c.legalName}`,
        amountCents: increase ? Number(c.requestedCreditLimitCents) : Number(c.creditLimitCents),
      }
    }
    case 'bad_debt': {
      const w = await db.receivableWriteOff.findUnique({ where: { id }, select: { amountCents: true } })
      return w && { ref: 'Bad-debt write-off', amountCents: Number(w.amountCents) }
    }
    case 'raast_void': {
      const r = await db.raastReceipt.findUnique({ where: { id }, select: { amountCents: true, orderId: true } })
      return r && { ref: `Raast void, order ${orderRefOf(r.orderId)}`, amountCents: r.amountCents }
    }
    case 'grni_writeoff': {
      const l = await db.goodsReceiptLine.findUnique({ where: { id }, select: { description: true, receivedQty: true, unit: true } })
      return l && { ref: `Write-off of received goods: ${l.description}`, detail: `${l.receivedQty} ${l.unit}` }
    }
    case 'stock_difference':
      return { ref: 'Stock difference' }
    case 'journal_request': {
      const j = await db.journalRequest.findUnique({ where: { id }, select: { kind: true, description: true, totalCents: true } })
      return j && { ref: `${j.kind === 'reverse' ? 'Journal reversal' : 'Journal request'}: ${j.description}`, amountCents: j.kind === 'reverse' ? null : Number(j.totalCents) }
    }
    case 'ho_recharge': {
      const r = await db.rechargeRun.findUnique({ where: { id }, select: { period: true, kind: true } })
      return r && { ref: `Head-office recharge ${r.period}${r.kind === 'true_up' ? ' (true-up)' : ''}` }
    }
    case 'connector_change': {
      const c = await db.posConnectorChange.findUnique({ where: { id }, select: { kind: true } })
      return c && { ref: `POS connector change (${human(String(c.kind))})` }
    }
  }
  return null
}

const cutKey = (s: string) => s.slice(0, 200)

// ─── approval.waiting ────────────────────────────────────────────────────────

/**
 * An item entered a queue: tell each person who must decide it now. Queued;
 * returns at once; never throws. Call AFTER the submit's transaction has
 * committed. `round` comes from the submit write (see the header).
 */
export function approvalWaiting(type: ApprovalType, id: string, opts: { round: string; actorId?: string | null }): void {
  try {
    if (!isApprovalType(type) || !id || !opts?.round) {
      console.warn(`[staff-notify] approvalWaiting(${String(type)}) skipped: id and round are required`)
      return
    }
    if (type === 'cash_request_hod') return
    queueStaffNotify(() => sendApprovalWaiting(type, id, opts.round, opts.actorId ?? null))
  } catch (err) {
    console.warn(`[staff-notify] approvalWaiting failed: ${(err as Error)?.message ?? String(err)}`)
  }
}

/** The queued job (exported for tests): re-checks the item, resolves the approvers, inserts. */
export async function sendApprovalWaiting(type: ApprovalType, id: string, round: string, actorId: string | null): Promise<number> {
  const found = await approverIdsFor(type, id)
  if (!found || found.userIds.length === 0) return 0
  const s = found.subject
  const f = await describeApproval(type, id, s)
  const title = APPROVAL_NOTIFY[type].waitingTitle(s, f)
  const tenantId = s.ownerTenantId ?? s.companyIds[0] ?? null
  const rows: NotifyInput[] = found.userIds.map((userId) => ({
    userId, tenantId, kind: 'approval.waiting', severity: 'info', title, body: f.detail ?? null,
    link: waitingLink(type), entityType: type, entityId: id, actorId,
    dedupeKey: cutKey(`approval.waiting:${type}:${id}:${round.slice(0, 100)}`),
  }))
  return notifyStaffMany(rows)
}

// ─── approval.decided ────────────────────────────────────────────────────────

type Outcome = 'approved' | 'rejected' | 'returned' | 'cancelled'

/** approve | post | pay → approved; reject → rejected; return → returned; cancel → cancelled; else nothing. */
export function decisionOutcome(decision: string): Outcome | null {
  switch (decision) {
    case 'approve': case 'approved': case 'post': case 'posted': case 'pay': case 'paid': return 'approved'
    case 'reject': case 'rejected': return 'rejected'
    case 'return': case 'returned': case 'send_back': return 'returned'
    case 'cancel': case 'cancelled': return 'cancelled'
    default: return null
  }
}

/**
 * A decision was made: tell the people waiting on it (never the decider).
 * Queued; never throws. lib/approvalRights.ts auditApproval calls it for every
 * decision — module routes do not call it themselves.
 */
export function approvalDecided(e: ApprovalDecidedEvent): void {
  try {
    if (!e || !isApprovalType(e.type) || !e.id || !e.actorId || !decisionOutcome(e.decision)) return
    const ev: ApprovalDecidedEvent = { ...e, decidedAt: e.decidedAt || new Date().toISOString() }
    queueStaffNotify(() => sendApprovalDecided(ev))
  } catch (err) {
    console.warn(`[staff-notify] approvalDecided failed: ${(err as Error)?.message ?? String(err)}`)
  }
}

const iso = (v: string | null | undefined) => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The queued job (exported for tests). */
export async function sendApprovalDecided(e: ApprovalDecidedEvent): Promise<number> {
  const type = e.type
  const outcome0 = decisionOutcome(e.decision)
  if (!outcome0) return 0
  const s = await approvalSubject(type, e.id)
  if (!s) return 0
  // journal_request: a "reject" sends it back to the preparer, who may resend it.
  const outcome: Outcome = type === 'journal_request' && outcome0 === 'rejected' ? 'returned' : outcome0
  const spec = APPROVAL_NOTIFY[type]

  // A step of a multi-step item: more is to come (the next approver gets approval.waiting).
  let final = e.final
  if (final === undefined && outcome === 'approved') {
    if (type === 'hr_request') final = s.status === 'approved'
    else if (type === 'cash_request_finance') final = false
  }
  const nonFinal = outcome === 'approved' && final === false

  const f = await describeApproval(type, e.id, s)
  let verb: string
  let severity: NotificationSeverity
  let body: string | null = null
  const note = typeof e.note === 'string' && e.note.trim() ? e.note.trim() : null
  switch (outcome) {
    case 'approved': {
      severity = nonFinal ? 'info' : 'success'
      verb = 'approved'
      if (nonFinal) {
        const next = await nextStepLabel(type, e.id)
        verb = type === 'cash_request_finance' ? 'approved by finance' : 'approved at this step'
        body = next ? `Now with ${next}.` : null
      } else if (type === 'storefront_publish') {
        const at = iso(e.publishAt)
        if (at && at.getTime() > Date.parse(e.decidedAt || '') ) {
          verb = 'approved'
          body = `Scheduled to publish at ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
        } else {
          verb = 'approved and published'
        }
      }
      break
    }
    case 'rejected':
      severity = 'warning'; verb = 'rejected'
      body = note ? `Reason: ${note}` : null
      break
    case 'returned':
      severity = 'warning'; verb = 'returned for correction'
      body = `${note ? `Note: ${note}. ` : ''}Edit it and send it again.`
      break
    case 'cancelled':
      severity = 'warning'; verb = 'cancelled'
      body = note ? `Reason: ${note}` : null
      break
  }
  const title = `${f.ref} ${verb}${f.companyName ? ` (${f.companyName})` : ''}`

  const extra = spec.extraRecipients ? await spec.extraRecipients(e.id, { ...e, final }).catch(() => []) : []
  const waiting = Array.isArray(e.waitingUserIds) && e.waitingUserIds.length > 0 ? e.waitingUserIds : s.submitterIds
  const recipients = [...new Set([...waiting, ...extra])].filter((u) => u && u !== e.actorId)
  if (recipients.length === 0) return 0
  const tenantId = e.tenantId ?? s.ownerTenantId ?? s.companyIds[0] ?? null
  const rows: NotifyInput[] = recipients.map((userId) => ({
    userId, tenantId, kind: 'approval.decided', severity, title, body,
    link: spec.decidedLink(e.id), entityType: type, entityId: e.id, actorId: e.actorId,
    dedupeKey: cutKey(`approval.decided:${type}:${e.id}:${e.decision}:${e.decidedAt}`),
  }))
  return notifyStaffMany(rows)
}

/** "HR", "the CEO" … — who a multi-step item is with now. */
async function nextStepLabel(type: ApprovalType, id: string): Promise<string | null> {
  if (type === 'cash_request_finance') return 'the CEO'
  if (type !== 'hr_request') return null
  try {
    const rec = await serviceClient.hrRecord.findUnique({ where: { id }, select: { tenantId: true, section: true, formVersion: true, currentStep: true, status: true } })
    if (!rec || rec.status !== 'submitted') return null
    const { runWithRlsContext } = await import('../../lib/rlsContext.js')
    return await runWithRlsContext({ tenantIds: [rec.tenantId], customerId: null, staffUserId: null }, async () => {
      const { getFormat } = await import('../hr/service.js')
      const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
      const step = fmt.workflow[rec.currentStep]
      if (!step) return null
      return step.role === 'hod' ? 'the reporting manager' : step.role === 'hr' ? 'HR' : step.role === 'ceo' ? 'the CEO' : 'management'
    })
  } catch {
    return null
  }
}

/** Registry check helper (tests): every approval type has an entry. */
export const NOTIFY_TYPES_COVERED = (): boolean => APPROVAL_TYPES.every((t) => !!APPROVAL_NOTIFY[t])
