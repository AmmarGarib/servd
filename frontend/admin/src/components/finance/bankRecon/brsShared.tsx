'use client'
// Shared types and small parts of Finance → Bank reconciliation (the list page
// and the workspace). The API is backend reconciliation/brsRoutes.ts, mounted
// at /reconciliation/brs; money is integer paisa, dates YYYY-MM-DD.
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../../../store/auth'
import { api, ApiError } from '../../../lib/api'

export const BRS = '/reconciliation/brs'

export type BrsStatus = 'draft' | 'submitted' | 'approved'
export type PeriodKind = 'month' | 'quarter' | 'custom'

export interface BrsTotals {
  depositsCents: number; chequesCents: number; bankCreditsCents: number; bankDebitsCents: number
  bankAdjustmentsCents: number; bookAdjustmentsCents: number
  adjustedBankCents: number | null; adjustedBookCents: number; differenceCents: number | null
  expectedBankCents: number; matchedCount: number; underReviewCount: number
}

export interface BrsRow {
  id: string; tenantId: string; bankAccountId: string; accountCode: string
  periodFrom: string; periodTo: string; bankClosingCents: number | null; periodKind: PeriodKind
  status: BrsStatus
  preparedBy: string | null; preparedAt: string | null
  submittedBy: string | null; submittedAt: string | null
  approvedBy: string | null; approvedAt: string | null
  returnedBy: string | null; returnNote: string | null
  reopenedBy: string | null; reopenReason: string | null; reopenCount: number
  bank: { name: string; bankName: string | null; accountNumber: string | null }
  totals: BrsTotals | null
  bookClosingCents: number | null
}

export interface BookItem {
  journalLineId: string; entryId: string; date: string; voucherNo: string | null; reference: string | null
  chequeRef: string | null; party: string | null; description: string; amountCents: number
  underReview: boolean; reviewNote: string | null; clearedOn: string | null; raast?: boolean
}
export interface BankItem {
  statementLineId: string; date: string; reference: string | null; description: string; amountCents: number
  underReview: boolean; recordedOn: string | null; matchStatus: string
}
export interface AdjItem {
  id: string; side: 'bank' | 'book'; kind: string; kindLabel: string; amountCents: number
  narration: string; reference: string; createdAt: string
}
export interface BrsStatement {
  bank: { id: string; name: string; bankName: string | null; accountNumber: string | null; accountCode: string; accountName: string | null }
  periodFrom: string; periodTo: string; financialYear: string
  book: { openingCents: number; receiptsCents: number; paymentsCents: number; closingCents: number }
  bankClosingCents: number | null
  deposits: BookItem[]; cheques: BookItem[]; bankCredits: BankItem[]; bankDebits: BankItem[]; adjustments: AdjItem[]
  totals: BrsTotals
  firstReconciliation: boolean
}
export interface BrsHistory { action: string; by: string | null; at: string; metadata: unknown }
export interface BrsDetail {
  reconciliation: BrsRow
  statement: BrsStatement
  changedSinceApproval: boolean
  live: BrsTotals | null
  history: BrsHistory[]
}

export const STATUS_LABEL: Record<BrsStatus, string> = { draft: 'Draft', submitted: 'Awaiting approval', approved: 'Approved' }
const STATUS_CLASS: Record<BrsStatus, string> = { draft: 's-badge-amber', submitted: 's-badge-blue', approved: 's-badge-green' }

export function StatusChip({ status }: { status: BrsStatus }) {
  return <span className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</span>
}

/** Who may do what — the API decides; these only hide buttons it would refuse. */
export function useBrsRights() {
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const isPreparer = useAuthStore((s) => s.isRole('admin', 'owner', 'finance'))
  const isFinance = useAuthStore((s) => s.isRole('finance'))
  return { canPrepare: isPreparer, canApprove: isAdmin, canReopen: isAdmin || isFinance }
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return (e as Error)?.message || 'Something went wrong'
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function periodLabel(from: string, to: string): string {
  return `${fmtDay(from)} – ${fmtDay(to)}`
}

/** Pakistan's financial year (1 July – 30 June) of a day, e.g. "2026-27". */
export function financialYearOf(day: string): string {
  const y = Number(day.slice(0, 4)); const m = Number(day.slice(5, 7))
  if (!y || !m) return ''
  const start = m >= 7 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

const pad = (n: number) => String(n).padStart(2, '0')
export function monthRange(ym: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2])
  return { from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(new Date(y, mo, 0).getDate())}` }
}
/** Quarter 1–4 of the financial year starting 1 July of `fyStart`. */
export function quarterRange(fyStart: number, q: number): { from: string; to: string } {
  const spans: Array<[string, string]> = [
    [`${fyStart}-07-01`, `${fyStart}-09-30`],
    [`${fyStart}-10-01`, `${fyStart}-12-31`],
    [`${fyStart + 1}-01-01`, `${fyStart + 1}-03-31`],
    [`${fyStart + 1}-04-01`, `${fyStart + 1}-06-30`],
  ]
  const [from, to] = spans[Math.min(3, Math.max(0, q - 1))]!
  return { from, to }
}

export interface BankStatusRow {
  bankAccountId: string; companyName: string | null; name: string; bankName: string | null; accountNumber: string | null
  accountCode: string; isActive: boolean
  lastApprovedPeriodTo: string | null; lastApprovedId: string | null
  outstandingChequesCents: number | null; uncreditedDepositsCents: number | null
  open: { id: string; status: BrsStatus; periodFrom: string; periodTo: string } | null
}

export function useBrsList(params: { bankAccountId?: string; status?: string }) {
  const qs = new URLSearchParams()
  if (params.bankAccountId) qs.set('bankAccountId', params.bankAccountId)
  if (params.status) qs.set('status', params.status)
  return useQuery<BrsRow[]>({
    queryKey: ['brs-list', qs.toString()],
    queryFn: () => api.get<BrsRow[]>(`${BRS}/?${qs.toString()}`),
  })
}
