'use client'
// Cash vouchers — shared types, status words, error words and reads.
//
// The owner's process (2026-10-13): the HOD prepares the voucher in servd and
// signs it, the director (the CEO) signs it, it is printed, the cashier (the
// cash box's custodian) signs the paper and pays the cash, and a photo of the
// signed paper is uploaded. Only that upload puts it in cash — it becomes one
// petty-cash spend on its box. Generating, signing or printing never does.
//
// API: backend modules/trustops/cashVouchers.ts, under /trustops/cash-vouchers.

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'

export const CV_BASE = '/trustops/cash-vouchers'
/** Every cash-voucher read starts with this key, so one invalidation refreshes all. */
export const CV_ROOT = 'cash-vouchers'

export type VoucherStatus = 'draft' | 'hod_signed' | 'approved' | 'disbursed' | 'rejected' | 'cancelled'

export const STATUSES: VoucherStatus[] = ['draft', 'hod_signed', 'approved', 'disbursed', 'rejected', 'cancelled']

/** The words and the badge for each status (globals.css s-badge-*). */
export const STATUS_META: Record<VoucherStatus, { label: string; chip: string; badge: string }> = {
  draft:      { label: 'Draft',                   chip: 'Draft',                badge: 's-badge-muted' },
  hod_signed: { label: 'Waiting for director',    chip: 'Waiting for director', badge: 's-badge-amber' },
  approved:   { label: 'Approved — print & pay',  chip: 'Approved — print & pay', badge: 's-badge-purple' },
  disbursed:  { label: 'Paid',                    chip: 'Paid',                 badge: 's-badge-green' },
  rejected:   { label: 'Rejected',                chip: 'Rejected',             badge: 's-badge-red' },
  cancelled:  { label: 'Cancelled',               chip: 'Cancelled',            badge: 's-badge-muted' },
}

export function statusMeta(s: string) {
  return STATUS_META[s as VoucherStatus] ?? { label: s, chip: s, badge: 's-badge-muted' }
}

export interface CashVoucher {
  id: string
  tenantId: string
  number: string
  voucherDate: string
  payeeName: string
  payeeUserId: string | null
  purpose: string
  category: string | null
  conceptId: string | null
  department: string | null
  amountCents: number
  boxId: string
  status: VoucherStatus
  preparedById: string
  hodSignedById: string | null
  hodSignedAt: string | null
  directorSignedById: string | null
  directorSignedAt: string | null
  rejectedById?: string | null
  rejectedAt?: string | null
  rejectNote?: string | null
  cancelledById?: string | null
  cancelledAt?: string | null
  cancelNote?: string | null
  disbursedById?: string | null
  disbursedAt?: string | null
  /** The box custodian's name when it was paid. */
  cashierName?: string | null
  pettyCashMovementId?: string | null
  createdAt: string
  updatedAt?: string
  // ── Names the API adds (detail; the list may carry some of them) ──
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
  payeeUserName?: string | null
  hasPhoto?: boolean
  photo?: { mime: string; sizeBytes: number; uploadedAt: string; uploadedById: string } | null
  box?: { id?: string; name?: string | null; custodianId?: string | null; custodianName?: string | null } | null
  concept?: { id?: string; name?: string | null } | null
  tenant?: { id?: string; name?: string | null } | null
}

/** The box's name, wherever the API put it. */
export function boxNameOf(v: CashVoucher): string | null {
  return v.boxName ?? v.box?.name ?? null
}
/** The cashier: the name stamped when it was paid, else the box's custodian now. */
export function cashierOf(v: CashVoucher): string | null {
  return v.cashierName ?? v.custodianName ?? v.box?.custodianName ?? null
}
export function brandNameOf(v: CashVoucher): string | null {
  return v.conceptName ?? v.concept?.name ?? null
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
  movements?: Array<{ category: string | null }>
}

/** The detail answers the voucher, or `{ voucher }` (disburse answers `{ voucher, movement }`). */
function asOne(r: unknown): CashVoucher {
  const o = (r ?? {}) as Record<string, unknown>
  return (o['voucher'] && typeof o['voucher'] === 'object' ? o['voucher'] : r) as CashVoucher
}

/** Pages read for the register: 200 a page (the API's most), newest first. */
const PAGE = 200
const MAX_PAGES = 10

/**
 * Every voucher in view (all statuses — the page counts and filters them).
 * GET / answers `{ items, nextCursor }`; the pages are followed so the counts
 * are true, up to MAX_PAGES × PAGE vouchers (`truncated` past that).
 */
export function useVouchers() {
  return useQuery({
    queryKey: [CV_ROOT, 'list'],
    queryFn: async () => {
      const all: CashVoucher[] = []
      let cursor: string | null = null
      for (let i = 0; i < MAX_PAGES; i++) {
        const qs: string = `?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const r: { items?: CashVoucher[]; nextCursor?: string | null } | CashVoucher[] = await api.get(`${CV_BASE}${qs}`)
        if (Array.isArray(r)) return { items: r, truncated: false }
        all.push(...(r.items ?? []))
        cursor = r.nextCursor ?? null
        if (!cursor) return { items: all, truncated: false }
      }
      return { items: all, truncated: true }
    },
    refetchInterval: 60_000,
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

/** The petty-cash boxes (same read and cache key as the Petty cash page). */
export function usePettyBoxes() {
  return useQuery<PettyBox[]>({
    queryKey: ['petty-cash-boxes'],
    queryFn: () => api.get('/trustops/petty-cash/boxes'),
    retry: false,
    meta: { background: true },
  })
}

/** Brands for the optional brand field — every staff role reads this list. */
export function useBrands() {
  return useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Array<{ id: string; name: string }>>('/concepts?view=picker'),
    staleTime: 60_000,
    meta: { background: true },
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 1,
  })
}

/** Staff names, for the "Pay to" suggestions (managers and HR read it; others type the name). */
export function useStaffNames() {
  return useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['users'],
    queryFn: () => api.get('/auth/users'),
    retry: false,
    meta: { background: true },
  })
}

/** Categories offered as suggestions — free text; the petty-cash spend gets the same category. */
export const CATEGORY_SUGGESTIONS = [
  'supplies', 'courier', 'repairs & maintenance', 'fuel & transport', 'utilities',
  'staff welfare', 'cleaning', 'office', 'marketing', 'kitchen equipment', 'advance', 'miscellaneous',
]

// ─── Error words ────────────────────────────────────────────────────────────

const ERROR_WORDS: Record<string, string> = {
  VOUCHER_NOT_APPROVED: 'The director has not approved this voucher yet — the signed photo can be uploaded only after approval.',
  ALREADY_DISBURSED: 'This voucher is already paid — it is in petty cash.',
  INSUFFICIENT_FLOAT: "The cash box doesn't hold enough — top it up first.",
  SAME_SIGNER: 'The director must be a different person from the HOD who signed.',
  BOX_NOT_IN_COMPANY: "That cash box is not one of this company's boxes — pick a box of the voucher's company.",
  BAD_PHOTO: 'That photo could not be used. Take it again (a JPEG, PNG or WebP image).',
  PHOTO_TOO_LARGE: 'That photo is too large. Take it again a little further away.',
  AMOUNT_TOO_LARGE: 'That amount is too large for a cash voucher.',
  CONCEPT_NOT_IN_COMPANY: "That brand belongs to another company — pick one of the cash box's company's brands.",
  PAYEE_NOT_IN_COMPANY: "That login is not a member of this voucher's company — type the name without picking a login.",
  BOX_UNAVAILABLE: 'The cash box on this voucher has been closed — cancel the voucher and raise a new one.',
  VOUCHER_NOT_DRAFT: 'Only a draft can be edited or signed as HOD — someone may have signed it already. Reload to see where it is.',
  VOUCHER_NOT_HOD_SIGNED: 'Only a voucher the HOD has signed can be approved or rejected — it may have moved on. Reload to see where it is.',
  VOUCHER_NOT_CANCELLABLE: 'Only a voucher that is not yet paid can be cancelled.',
  BAD_CURSOR: 'The list is out of date — reload the page.',
  NO_ACTIVE_COMPANY: 'Pick a company first (the company switcher, top left).',
  PORTFOLIO_WRITE_CANCELLED: 'You cancelled — nothing was saved.',
}

/** A refusal in plain words: the known codes, else the server's own message. */
export function errorWords(e: unknown, action?: 'approve' | 'reject' | 'save' | 'sign' | 'cancel' | 'disburse'): string {
  if (e instanceof ApiError) {
    const known = ERROR_WORDS[e.code]
    // These two carry useful specifics from the server (the sizes, the float).
    if (known && (e.code === 'BAD_PHOTO' || e.code === 'INSUFFICIENT_FLOAT') && e.message) return `${known} (${e.message})`
    if (known) return known
    if (e.status === 413) return ERROR_WORDS['PHOTO_TOO_LARGE']!
    if (e.status === 403 && (action === 'approve' || action === 'reject')) return 'Only the CEO (director) can approve or reject a cash voucher.'
    if (e.status === 403) return "Your login can't do that on cash vouchers."
    if (e.status === 404) return 'This voucher was not found — it may belong to another company.'
    if (e.status === 409) return e.message || 'This voucher has moved on — refresh to see where it is now.'
    return e.message
  }
  return e instanceof Error ? e.message : 'Something went wrong.'
}

// ─── Dates ──────────────────────────────────────────────────────────────────

const TZ = 'Asia/Karachi'

/** Today in Karachi as YYYY-MM-DD (for the date field). */
export function todayKarachi(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
/** The voucher's date as YYYY-MM-DD for the date field. */
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
