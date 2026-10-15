'use client'
// Cash requests — shared types, step words, error words and reads.
//
// The owner's process (2026-10-13) with the accountant's rule (H3, 2026-10-14:
// "expense at payment; receipts kept for the file"): anyone raises a request
// naming its expense category, the HOD signs, the director (CEO) approves,
// the box's custodian pays the cash to the holder — that books it to the
// category at once — and the holder uploads the receipts. Receipts that show
// another category, stock or equipment move the money there; change goes
// back into a box. The paper is still the "Cash payment voucher" (CV numbers).
//
// API: backend modules/trustops/cashVouchers.ts + cashRequestSettle.ts, under
// /trustops/cash-vouchers. Every row carries the viewer's capability flags —
// the buttons follow those, never a local role list.

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'

export const CV_BASE = '/trustops/cash-vouchers'
/** Every cash-request read starts with this key, so one invalidation refreshes all. */
export const CV_ROOT = 'cash-vouchers'

export type VoucherStatus =
  | 'draft' | 'hod_signed' | 'submitted' | 'finance_approved' | 'returned' | 'approved' | 'disbursed' | 'posted'
  | 'rejected' | 'cancelled' | 'settled' | 'converted'
/** The step shown. Server `stage` may add words; unknown ones render as plain text. */
export type RequestStage =
  | 'submitted' | 'finance_approved' | 'returned' | 'approved' | 'missing_docs' | 'awaiting_verification' | 'posted'
  | 'draft' | 'hod_signed' | 'paid' | 'receipts_in' | 'settled' | 'needs_review' | 'rejected' | 'cancelled' | 'converted'

/** The words and the badge for each step (globals.css s-badge-*): green = good news, amber = waiting, red = bad. */
export const STAGE_META: Record<RequestStage, { label: string; badge: string }> = {
  submitted:        { label: 'Waiting for finance',     badge: 's-badge-amber' },
  finance_approved: { label: 'Waiting for CEO',         badge: 's-badge-amber' },
  returned:         { label: 'Returned for correction', badge: 's-badge-red' },
  approved:         { label: 'Approved — to pay',       badge: 's-badge-purple' },
  missing_docs:     { label: 'Paid — documents missing', badge: 's-badge-red' },
  awaiting_verification: { label: 'Documents in — finance to verify', badge: 's-badge-teal' },
  posted:           { label: 'Verified & booked',       badge: 's-badge-green' },
  // Legacy rows (before the 2026-10-15 flow)
  draft:        { label: 'Waiting for finance',  badge: 's-badge-amber' },
  hod_signed:   { label: 'Waiting for CEO',      badge: 's-badge-amber' },
  paid:         { label: 'Paid — receipts due',  badge: 's-badge-amber' },
  receipts_in:  { label: 'Receipts in',          badge: 's-badge-teal' },
  settled:      { label: 'Settled',              badge: 's-badge-green' },
  needs_review: { label: 'Needs review',         badge: 's-badge-red' },
  rejected:     { label: 'Rejected',             badge: 's-badge-red' },
  cancelled:    { label: 'Cancelled',            badge: 's-badge-muted' },
  converted:    { label: 'Converted',            badge: 's-badge-muted' },
}

export function stageMeta(s: string) {
  return STAGE_META[s as RequestStage] ?? { label: s.replace(/_/g, ' '), badge: 's-badge-muted' }
}

/**
 * The step to show for a row: from the stored status first (so it is right
 * whatever words the server's `stage` uses), the server's `stage` for the
 * legacy paid / settled sub-steps.
 */
export function stageOf(v: Pick<CashVoucher, 'status' | 'stage' | 'expenseOnVerify' | 'supportingCount'>): string {
  switch (v.status) {
    case 'draft': case 'submitted': return 'submitted'
    case 'hod_signed': case 'finance_approved': return 'finance_approved'
    case 'disbursed':
      if (v.expenseOnVerify) return (v.supportingCount ?? 0) > 0 ? 'awaiting_verification' : 'missing_docs'
      return v.stage ?? 'paid'
    default: return v.status
  }
}

export interface SupportingDoc {
  id: string; fileName?: string | null; mime: string; sizeBytes: number; createdAt: string
  uploadedById?: string | null; uploadedByName?: string | null; kind?: string
}

export interface HistoryRow { id?: string; at?: string; createdAt?: string; action: string; actorName?: string | null; summary?: string | null; before?: unknown; after?: unknown; note?: string | null }

export interface Dashboard {
  waitingFinance: { count: number; cents: number }
  waitingCeo: { count: number; cents: number }
  returned: { count: number; cents: number }
  approvedUnpaid: { count: number; cents: number }
  missingDocs: { count: number; cents: number }
  awaitingVerification: { count: number; cents: number }
  docsOverdue: { count: number; cents: number }
  postedThisMonth: { count: number; cents: number }
}

export interface ReceiptMeta { id: string; mime: string; sizeBytes: number; createdAt: string; uploadedById?: string; settlementId?: string | null }

export interface SettlementLine {
  id: string; kind: 'expense' | 'stock' | 'capex'; categoryKey: string | null; accountCode: string; amountCents: number
  description: string; conceptId: string | null; inventoryItemId: string | null; quantity: number | null; unit: string | null
  capexLineId: string | null; capexPaymentId: string | null; receiptLineId: string | null
}
export interface Settlement {
  id: string; seq: number; totalCents: number; note: string | null; submittedById: string; submittedByName: string | null; createdAt: string
  lines: SettlementLine[]; attachments: ReceiptMeta[]
}

export interface CashVoucher {
  id: string
  tenantId: string
  number: string
  voucherDate: string
  payeeName: string
  payeeUserId: string | null
  holderUserId?: string | null
  holderName?: string | null
  purpose: string
  /** A PAYOUT key or a keeper's 6xxx (as stored). */
  category: string | null
  categoryKey?: string | null
  categoryAccountCode?: string | null
  conceptId: string | null
  department: string | null
  /** The amount PAID (total = gross − discount). */
  amountCents: number
  kind?: 'request' | 'expense'
  grossCents?: number | null
  discountCents?: number
  /** Server wording, "Rupees … only". */
  amountInWords?: string
  boxId: string | null
  status: VoucherStatus
  stage: RequestStage
  expenseOnVerify?: boolean
  supportingCount?: number
  supporting?: SupportingDoc[]
  financeApprovedById?: string | null
  financeApprovedAt?: string | null
  financeApprovedByName?: string | null
  submittedAt?: string | null
  returnedAt?: string | null
  returnedByName?: string | null
  returnNote?: string | null
  returnCount?: number
  docsVerifiedAt?: string | null
  docsVerifiedByName?: string | null
  postedAt?: string | null
  postedByName?: string | null
  postedJournalEntryId?: string | null
  preparedById: string
  hodSignedById: string | null
  hodSignedAt: string | null
  directorSignedById: string | null
  directorSignedAt: string | null
  rejectedAt?: string | null
  rejectNote?: string | null
  cancelledAt?: string | null
  cancelNote?: string | null
  disbursedById?: string | null
  disbursedAt?: string | null
  /** The box custodian's name when it was paid. */
  cashierName?: string | null
  pettyCashMovementId?: string | null
  dueBy?: string | null
  settledCents: number
  returnedCents: number
  convertedCents: number
  remainingCents: number
  settledAt?: string | null
  overdue: boolean
  needsReview: boolean
  receiptCount: number
  receiptsUnsettled: number
  receipts: ReceiptMeta[]
  signedPhotos: ReceiptMeta[]
  isMine: boolean
  createdAt: string
  // Names
  preparedByName?: string | null
  hodSignedByName?: string | null
  directorSignedByName?: string | null
  rejectedByName?: string | null
  cancelledByName?: string | null
  disbursedByName?: string | null
  boxName?: string | null
  custodianId?: string | null
  custodianName?: string | null
  conceptName?: string | null
  companyName?: string | null
  // What this viewer may do (the server re-checks each one)
  canEdit: boolean
  canEditCategory: boolean
  canSignHod: boolean
  canFinanceApprove?: boolean
  canApprove: boolean
  canReturn?: boolean
  canReject: boolean
  canUpload?: boolean
  canVerify?: boolean
  canCancel: boolean
  canPay: boolean
  canUploadReceipts: boolean
  canSettle: boolean
  canReturnChange: boolean
  canReclass: boolean
  canNameHolder: boolean
  // Detail only
  paidAccountCode?: string | null
  payMovement?: { id: string; amountCents: number; createdAt: string; journalEntryId: string | null; boxId: string } | null
  settlements?: Settlement[]
}

/** What the paper calls the payee: a holder (request) or an outside payee (expense). */
export const isExpenseKind = (v: Pick<CashVoucher, 'kind'>) => v.kind === 'expense'

/** The cashier: the name stamped when it was paid, else the box's custodian now. */
export function cashierOf(v: CashVoucher): string | null {
  return v.cashierName ?? v.custodianName ?? null
}

export interface PettyBox {
  id: string
  name: string
  tenantId: string | null
  conceptId: string | null
  custodianId: string
  custodianName?: string | null
  floatCents: number
  isActive: boolean
}

/** A pay / return-change answers `{ voucher, … }`; the rest answer the request. */
function asOne(r: unknown): CashVoucher {
  const o = (r ?? {}) as Record<string, unknown>
  return (o['voucher'] && typeof o['voucher'] === 'object' ? o['voucher'] : r) as CashVoucher
}

/** The list views the server knows (GET /trustops/cash-vouchers?view=). */
export type ListView =
  | 'mine' | 'finance' | 'ceo' | 'returned' | 'to_pay' | 'missing_docs' | 'awaiting_verification' | 'posted'
  | 'overdue' | 'receipts_due' | 'settled' | 'needs_review' | 'all'

/** One view of the register (newest first, up to 200). `keeper` = the server says this login runs petty cash. */
export function useVouchers(view: ListView) {
  return useQuery({
    queryKey: [CV_ROOT, 'list', view],
    queryFn: async () => {
      const r: { items?: CashVoucher[]; nextCursor?: string | null; keeper?: boolean } =
        await api.get(`${CV_BASE}?view=${view}&limit=200`)
      return { items: r.items ?? [], truncated: !!r.nextCursor, keeper: !!r.keeper }
    },
    refetchInterval: 60_000,
  })
}

/** The dashboard counts and PKR totals (company-scoped; staff see their own). */
export function useDashboard() {
  return useQuery<Dashboard>({
    queryKey: [CV_ROOT, 'dashboard'],
    queryFn: () => api.get(`${CV_BASE}/dashboard`),
    refetchInterval: 60_000,
    retry: false,
  })
}

/** The voucher's audit trail, oldest first. */
export function useHistory(id: string) {
  return useQuery<{ items?: HistoryRow[] } | HistoryRow[]>({
    queryKey: [CV_ROOT, 'history', id],
    queryFn: () => api.get(`${CV_BASE}/${id}/history`),
    enabled: !!id,
    retry: false,
  })
}

export function useVoucher(id: string) {
  return useQuery({
    queryKey: [CV_ROOT, 'one', id],
    queryFn: async () => asOne(await api.get<unknown>(`${CV_BASE}/${id}`)),
    enabled: !!id,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 403)) && n < 1,
  })
}

/** Every petty-cash box (cash keepers only — 403 for everyone else, silently). */
export function usePettyBoxes() {
  return useQuery<PettyBox[]>({
    queryKey: ['petty-cash-boxes'],
    queryFn: () => api.get('/trustops/petty-cash/boxes'),
    retry: false,
    meta: { background: true },
  })
}

/** The boxes I hold (any login) — the custodian's box picker. */
export function useMyBoxes() {
  return useQuery<PettyBox[]>({
    queryKey: ['petty-cash-boxes', 'mine'],
    queryFn: () => api.get('/trustops/petty-cash/boxes?mine=1'),
    retry: false,
    meta: { background: true },
  })
}

export interface SpendCategory { key: string; label: string; code: string; kind: string }

/** The expense categories a request can name (the server's one list). */
export function useCategories() {
  return useQuery<{ categories: SpendCategory[] }>({
    queryKey: ['petty-cash-categories'],
    queryFn: () => api.get('/trustops/petty-cash/categories'),
    staleTime: 300_000,
  })
}

/** "Transport / conveyance (6140)" for a stored category (a key or a 6xxx). */
export function categoryWords(category: string | null | undefined, categories: SpendCategory[]): string {
  if (!category) return '—'
  const c = categories.find((x) => x.key === category)
  if (c) return `${c.label} (${c.code})`
  return /^\d{4}$/.test(category) ? `Account ${category}` : category
}

/** Brands for the optional brand field — every staff role reads this list. */
export function useBrands() {
  return useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Array<{ id: string; name: string; tenantId?: string | null }>>('/concepts?view=picker'),
    staleTime: 60_000,
    meta: { background: true },
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 1,
  })
}

/** Staff logins (managers and HR read it) — a keeper names someone else as the holder. */
export function useStaffNames() {
  return useQuery<Array<{ id: string; name: string; tenantId?: string | null }>>({
    queryKey: ['users'],
    queryFn: () => api.get('/auth/users'),
    retry: false,
    meta: { background: true },
  })
}

// ─── Error words ────────────────────────────────────────────────────────────

const ERROR_WORDS: Record<string, string> = {
  SELF_APPROVE: 'You cannot approve your own request — another finance login does.',
  NOT_APPROVED: 'Print, PDF and Excel are available once the CEO has approved.',
  DOCS_REQUIRED: 'Upload at least one supporting document before verifying.',
  ALREADY_POSTED: 'This voucher is already verified and booked.',
  NOT_FINANCE: 'Only finance can do that.',
  VOUCHER_NOT_RETURNED: 'Only a returned voucher can be resubmitted.',
  VOUCHER_NOT_SUBMITTED: 'This voucher has moved on — reload to see where it is.',
  BAD_STATE: 'This voucher has moved on — reload to see where it is.',
  TOO_MANY_DOCUMENTS: 'A voucher takes at most 20 supporting documents.',
  BAD_DOCUMENT: 'That file type is not accepted. Use PDF, JPG, PNG, WebP, Excel, Word, PowerPoint, CSV or TXT up to 5 MB.',
  DISCOUNT_TOO_LARGE: 'The discount cannot be more than the amount.',
  PAYEE_REQUIRED: 'Name the payee.',
  VOUCHER_NOT_APPROVED: 'The director has not approved this request yet — it can be paid only after approval.',
  ALREADY_PAID: 'This request is already paid.',
  INSUFFICIENT_FLOAT: "The cash box doesn't hold enough — top it up first.",
  SAME_SIGNER: 'The CEO must be a different person from the finance approver.',
  SELF_SIGN_HOD: 'You hold this cash — your HOD signs it, not you.',
  NOT_HOD: 'Only the HOD of the person who holds the cash (their reporting manager), finance or a manager can sign this.',
  NOT_YOURS: "This request is not one you raised, hold, sign or pay.",
  NOT_CUSTODIAN: 'Only the cashier who holds the cash box, finance or a manager can pay from it.',
  BOX_REQUIRED: 'Pick the cash box the money comes from.',
  BOX_PICK_KEEPERS_ONLY: 'Only finance or a manager picks or changes the cash box.',
  BOX_NOT_IN_COMPANY: "That cash box is not an open box of this request's company.",
  BOX_UNAVAILABLE: 'That cash box is closed — pick another one.',
  HOLDER_REQUIRED: 'This request names nobody to take the cash — finance names the holder first.',
  CATEGORY_REQUIRED: 'This request names no expense category — finance sets it before it is paid.',
  SPEND_CATEGORY_REQUIRED: 'Pick what the cash is for (the expense category).',
  SPEND_CATEGORY_UNKNOWN: 'The category on this request is not one servd knows — finance picks one from the list before it is paid.',
  USE_STOCK_LINE: 'Food, drinks and packaging are not an expense category — raise it under the closest category; the receipts bring them into stock.',
  EXPLICIT_ACCOUNT_NOT_ALLOWED: 'Only finance or a manager can pick an account — pick a category.',
  NOT_AN_EXPENSE_CODE: 'That is not an operating-expense (6xxx) account.',
  ACCOUNT_NOT_FOUND: "This company's chart does not have that account.",
  AMOUNT_TOO_LARGE: 'That amount is too large for a cash request.',
  CONCEPT_NOT_IN_COMPANY: "That brand belongs to another company — pick one of the request's company's brands.",
  PAYEE_NOT_IN_COMPANY: "That login is not a member of this request's company.",
  VOUCHER_NOT_DRAFT: 'This voucher can no longer be edited here — it has moved on.',
  VOUCHER_CHANGED: 'Someone else changed this request — reload to see where it is.',
  VOUCHER_NOT_HOD_SIGNED: 'This request has moved on — reload to see where it is.',
  VOUCHER_NOT_CANCELLABLE: 'Only a request that is not yet paid can be cancelled.',
  VOUCHER_NOT_PAID: 'Receipts and change come in once the request is paid, until it is settled.',
  RECEIPT_NOT_ALLOWED: 'Only the person who holds the cash, finance or a manager can add or remove its receipts.',
  SETTLE_NOT_ALLOWED: 'Only the person who holds the cash, finance or a manager can submit its receipts.',
  TOO_MANY_RECEIPTS: 'A cash request takes at most 20 receipts.',
  RECEIPT_REQUIRED: 'Add the receipts these lines come from first.',
  RECEIPT_NOT_ON_REQUEST: 'A receipt was not uploaded on this request.',
  RECEIPT_IN_USE: 'That receipt is already on a submitted settlement.',
  LINES_EMPTY: 'Say what the receipts were for — add at least one line.',
  RECEIPTS_OVER_REQUEST: 'The lines come to more than is still open on this request.',
  OVER_REMAINING: 'That is more change than is still open on this request.',
  STOCK_LINES_NOT_ALLOWED: 'Only finance, a manager or someone who runs the stock can book goods into stock.',
  STOCK_LINE_FIXED: 'Stock and equipment lines are fixed by their documents — only an expense line moves.',
  ITEM_NOT_IN_COMPANY: "That stock item is not one of this company's.",
  UNIT_MISMATCH: "That unit cannot be converted to the item's own unit.",
  CAPEX_LINE_NOT_IN_COMPANY: "That CapEx item is not one of this company's.",
  NOT_CAPITAL: 'That CapEx line is not equipment — pick an equipment line.',
  USE_CAPEX: 'That looks like equipment — book it as an Equipment (CapEx) line.',
  PAYMENT_NOT_BOOKED: 'The payment of this request is not on the books yet — book the petty-cash history first.',
  CASH_REQUEST_PAID_FIXED: 'Receipts are already booked against this payment — move money with a settlement line instead.',
  PERIOD_LOCKED: 'That month is closed in the books.',
  BAD_FILE: 'That file could not be used. Take the photo again (JPEG, PNG or WebP), or pick a PDF up to 3 MB.',
  BAD_PHOTO: 'That photo could not be used. Take it again (a JPEG, PNG or WebP image).',
  BAD_CURSOR: 'The list is out of date — reload the page.',
  NO_ACTIVE_COMPANY: 'Pick a company first (the company switcher, top left).',
  PORTFOLIO_WRITE_CANCELLED: 'You cancelled — nothing was saved.',
}

/** A refusal in plain words: the known codes, else the server's own message. */
export function errorWords(e: unknown): string {
  if (e instanceof ApiError) {
    const known = ERROR_WORDS[e.code]
    // These carry useful specifics from the server (sizes, the float, the amounts).
    if (known && ['BAD_PHOTO', 'BAD_FILE', 'BAD_DOCUMENT', 'INSUFFICIENT_FLOAT', 'RECEIPTS_OVER_REQUEST', 'OVER_REMAINING', 'UNIT_MISMATCH'].includes(e.code) && e.message) {
      return `${known} (${e.message})`
    }
    if (known) return known
    if (e.status === 413) return 'That file is too large. Take the photo again a little further away.'
    if (e.status === 403) return e.message || "Your login can't do that on cash requests."
    if (e.status === 404) return 'This request was not found — it may belong to another company.'
    if (e.status === 409) return e.message || 'This request has moved on — refresh to see where it is now.'
    return e.message
  }
  return e instanceof Error ? e.message : 'Something went wrong.'
}

// ─── Money and dates ────────────────────────────────────────────────────────

const TZ = 'Asia/Karachi'

/** Today in Karachi as YYYY-MM-DD (for the date field). */
export function todayKarachi(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
/** A date as YYYY-MM-DD for the date field. */
export function dateInput(iso: string | null | undefined): string {
  if (!iso) return todayKarachi()
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return todayKarachi()
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
/** "13 Oct 2026". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}
/** "13 Oct 2026, 14:05". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d)
}
