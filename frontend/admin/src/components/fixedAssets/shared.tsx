'use client'
// Fixed-asset register screens — the pieces every page of Finance → Accounting
// → Fixed assets shares: the API shapes (backend modules/fixedAssets), the
// lookups hook, the tab bar, the modal, and the error wording.
//
// Nothing here keeps a class list, a default life or a role list: classes,
// lives and what the caller may do all come from GET
// /accounting/fixed-assets/lookups (its `capabilities` flags and each
// request's canDecide / canCancel).

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { api, ApiError } from '../../lib/api'
import { fmtPkrWhole } from '../../lib/money'
import { usePermissions } from '../../hooks/useCan'
import { canOpenPath } from '../../lib/moduleCatalog'
import { Modal as SharedModal } from '../ui/Modal'

export const FA_BASE = '/accounting/fixed-assets'

// ─── API shapes ─────────────────────────────────────────────────────────────

export interface FaClass {
  id: string
  tenantId: string
  key: string
  label: string
  costAccountCode: string
  accumAccountCode: string | null
  depreciable: boolean
  pooled: boolean
  defaultLifeMonths: number | null
  taxRateBp: number
  taxInitialAllowanceBp: number
  isActive: boolean
}
export interface FaNamed { id: string; name: string; tenantId: string }
export interface FaPoolRef { id: string; label: string; tenantId: string; locationId: string; conceptId: string | null; classKey: string; typeKey: string }
export interface FaLookups {
  activeTenantId: string | null
  companies: Array<{ id: string; name: string }>
  classes: FaClass[]
  smallwareTypes: Array<{ key: string; label: string }>
  locations: FaNamed[]
  brands: FaNamed[]
  suppliers: FaNamed[]
  pools: FaPoolRef[]
  bankAccounts: Array<{ id: string; name: string; tenantId: string; accountCode: string | null }>
  disposalKinds: Array<{ key: string; label: string }>
  writeOffCauses: Array<{ key: string; label: string }>
  requestKinds: Array<{ key: string; label: string }>
  lastCompletedPeriod: string
  currentPeriod: string
  capabilities: { canWrite: boolean; canCount: boolean; canApprove: boolean; canSetInitialAllowance?: boolean }
}

export interface FaAsset {
  id: string
  tenantId: string
  companyName: string
  assetTag: string | null
  name: string
  classKey: string
  classLabel: string
  kind: 'individual' | 'pool_layer'
  poolId: string | null
  poolLabel: string | null
  quantity: number
  originalQuantity: number
  conceptId: string | null
  conceptName: string | null
  locationId: string | null
  locationName: string | null
  status: 'active' | 'disposed' | 'voided'
  inServiceAt: string
  acquiredAt: string
  disposedAt: string | null
  disposalKind: string | null
  method: string | null
  /** H42: ticked for the 25% initial allowance in the tax view (finance / the CEO set it). */
  initialAllowanceEligible?: boolean
  usefulLifeMonths: number | null
  leaseEndsAt: string | null
  originalCostCents: number
  salvageCents: number
  inputTaxCents: number
  costCents: number
  accumulatedCents: number
  nbvCents: number
  nextChargeCents: number
  unchargedMonths: number
  lastChargedPeriod: string | null
  pendingRequestCount: number
  capexLineId: string | null
  supplierId: string | null
  supplierName: string | null
  serialNumber: string | null
  warrantyUntil: string | null
  notes: string | null
}

export interface FaRequest {
  id: string
  tenantId: string
  companyName: string
  kind: string
  kindLabel: string
  status: 'pending' | 'posted' | 'rejected' | 'cancelled' | string
  effectiveDate: string
  payload: Record<string, unknown> | null
  amountCents: number | null
  reason: string
  assetId: string | null
  asset: { id: string; assetTag: string | null; name: string; classKey: string; status: string } | null
  poolId: string | null
  pool: { id: string; label: string } | null
  capexLineId: string | null
  capexLine: { id: string; item: string; projectId: string; projectName: string } | null
  requestedByName: string | null
  requestedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  postedAt: string | null
  errorMessage: string | null
  needsApproval: boolean
  /** add_existing: where it came from, in plain words, and the item's name (no asset until approved). */
  existing?: { sourceLabel: string; name: string | null }
  canDecide: boolean
  canCancel: boolean
}

// ─── Wording ────────────────────────────────────────────────────────────────

/** Codes whose own message is worth leading with something clearer. Everything else shows the server's message, which is already plain English. */
const CODE_WORDS: Record<string, string> = {
  USE_CAPEX: 'Bought equipment goes on the register through CapEx. Use Buy equipment (Quick buy) or prepare a delivered item in the Project tracker; equipment you already had goes on with Add existing asset.',
  MONTH_NOT_ENDED: 'That month has not ended yet. Depreciation is charged for completed months only.',
  RUN_IN_PROGRESS: 'Depreciation is being charged for this company right now. Try again in a minute.',
  REQUEST_PENDING: 'There is already a request waiting on this asset. Decide or cancel it first.',
  NOT_PENDING: 'That request has already been decided.',
  BOOKS_CLOSED_TODAY: 'The books are closed through today, so nothing can post until a month is open.',
  CLASS_IN_USE: 'This class already has assets on the register, so whether it is pooled cannot change.',
  TAX_YEAR_FROZEN: 'That tax year is already frozen.',
  TAX_YEAR_OPEN: 'That tax year has not finished yet, so it cannot be frozen.',
  NO_ACTIVE_COMPANY: 'Pick one company in the top bar first. This is filed per company.',
  TREATMENT_LOCKED: 'An instalment of this line is already on the books as it is, so the treatment can no longer change.',
  LINE_HAS_POSTINGS: 'Something of this line is already on the books. Reverse it first.',
  PROJECT_HAS_POSTINGS: 'Something of this project is already on the books. Reverse it first.',
  ADVANCE_APPLIED_TO_ASSET: 'This advance has already been applied to an asset on the register.',
  PREPAID_RELEASING: 'Part of this prepayment has already been released to rent, so it can no longer change.',
  LINE_CAPITALISED: 'This item is on the fixed-asset register (or waiting for the CEO). Its cost, quantity and dates are fixed. Void the asset and prepare it again to change them.',
  CAPITALISATION_PENDING: 'This item is already waiting for the CEO to capitalise it.',
  ALREADY_CAPITALISED: 'This item is already on the fixed-asset register.',
  PREPAID_TERM_REQUIRED: 'Say how many months this rent advance covers and from which month.',
  QUICK_BUY_BANK_ONLY: 'Quick buy pays from a bank account. Equipment bought with cash goes through a cash request and its CapEx line.',
  OVERRIDE_NOT_ALLOWED: 'Only the CEO can override that.',
}

export function errorWords(e: unknown): string {
  if (e instanceof ApiError) return CODE_WORDS[e.code] ?? e.message
  if (e instanceof Error) return e.message
  return 'Something went wrong. Try again.'
}

// ─── Small helpers ──────────────────────────────────────────────────────────

export const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' } as const
export const inp = 'w-full rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-primary'
export const btnPrimary = 'rounded-lg bg-primary px-4 py-2 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50'
export const btnGhost = 'rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white disabled:opacity-50'

export function todayIso(): string {
  return new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
}

export function fmtDay(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s.length === 10 ? `${s}T12:00:00+05:00` : s)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' })
}

export function fmtMonth(p: string): string {
  const [y, m] = p.split('-')
  if (!y || !m) return p
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

export function fmtLife(months: number | null | undefined): string {
  if (!months) return 'Not depreciated'
  if (months % 12 === 0) return `${months / 12} year${months === 12 ? '' : 's'}`
  return `${months} months`
}

export const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`

export function money(c: number | null | undefined): string {
  return fmtPkrWhole(c ?? null)
}

/** Exact rupees and paisa, for places where a small difference matters (tie-out). */
export function moneyExact(c: number): string {
  const sign = c < 0 ? '-' : ''
  const abs = Math.abs(c)
  return `${sign}PKR ${Math.floor(abs / 100).toLocaleString('en-PK')}.${String(abs % 100).padStart(2, '0')}`
}

export function L({ t, children, hint }: { t: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold text-white/50">{t}</span>
      {children}
      {hint && <span className="block text-[11px] text-white/40 mt-1">{hint}</span>}
    </label>
  )
}

/** Thin wrapper over the shared Modal (Escape, focus trap, scroll lock, "Discard changes?" when `dirty`). */
export function Modal({ title, children, onClose, wide, dirty }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean; dirty?: boolean }) {
  return <SharedModal title={title} onClose={onClose} wide={wide} dirty={dirty}>{children}</SharedModal>
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="text-xs text-s-red mt-3" role="alert">{errorWords(error)}</p>
}

/** A one-line result under a page header or a form: green for done, amber for waiting, red for refused. */
export function Notice({ tone, children, onClose }: { tone: 'ok' | 'wait' | 'bad'; children: React.ReactNode; onClose?: () => void }) {
  const colour = tone === 'ok' ? 'var(--erp-success)' : tone === 'bad' ? 'var(--erp-danger)' : 'var(--erp-warning)'
  return (
    <div className="rounded-xl px-4 py-3 text-sm flex items-start justify-between gap-3" role="status"
      style={{ background: `color-mix(in srgb, ${colour} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${colour} 30%, transparent)`, color: colour }}>
      <span>{children}</span>
      {onClose && <button onClick={onClose} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">&times;</button>}
    </div>
  )
}

export function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: 'good' | 'bad'; sub?: string }) {
  return (
    <div className="rounded-2xl p-4" style={card}>
      <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{label}</p>
      <p className={`text-lg font-black mt-1 break-words ${tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-s-red' : 'text-white/90'}`}>{value}</p>
      {sub && <p className="text-[11px] text-white/40 mt-0.5">{sub}</p>}
    </div>
  )
}

export function AssetStatusBadge({ status }: { status: string }) {
  if (status === 'active') return <span className="s-badge-green">In use</span>
  if (status === 'disposed') return <span className="s-badge-muted">Disposed</span>
  if (status === 'voided') return <span className="s-badge-red">Voided</span>
  return <span className="s-badge-muted">{status}</span>
}

export function RequestStatusBadge({ status }: { status: string }) {
  if (status === 'pending') return <span className="s-badge-amber">Waiting for the CEO</span>
  if (status === 'posted') return <span className="s-badge-green">Done</span>
  if (status === 'rejected') return <span className="s-badge-red">Rejected</span>
  if (status === 'cancelled') return <span className="s-badge-muted">Cancelled</span>
  return <span className="s-badge-muted">{status}</span>
}

// ─── Data ───────────────────────────────────────────────────────────────────

/** The one lookups call: classes with lives, outlets, brands, suppliers, pools, banks, and what the caller may do. */
export function useFaLookups() {
  return useQuery<FaLookups>({
    queryKey: ['fa-lookups'],
    queryFn: () => api.get<FaLookups>(`${FA_BASE}/lookups`),
    staleTime: 60_000,
  })
}

/**
 * What the caller may do on the register, for pages OUTSIDE it (CapEx), plus
 * the register's lookups (outlets, brands, classes) for the forms. The API's
 * own flags; when the caller's modules cannot open the register nothing is
 * asked and every flag is false.
 */
export function useFaCapabilities(): { canWrite: boolean; canCount: boolean; canApprove: boolean; ready: boolean; lookups: FaLookups | undefined } {
  const { data: me } = usePermissions()
  const open = !!me && canOpenPath(FA_BASE, me.role, me.modules ?? [])
  const q = useQuery<FaLookups>({
    queryKey: ['fa-lookups'],
    queryFn: () => api.get<FaLookups>(`${FA_BASE}/lookups`),
    staleTime: 60_000,
    enabled: open,
    retry: false,
  })
  const c = q.data?.capabilities
  return { canWrite: !!c?.canWrite, canCount: !!c?.canCount, canApprove: !!c?.canApprove, ready: !open || !!q.data || q.isError, lookups: q.data }
}

// ─── Page frame and tabs ────────────────────────────────────────────────────

const TABS: Array<{ href: string; label: string }> = [
  { href: FA_BASE, label: 'Register' },
  { href: `${FA_BASE}/pools`, label: 'Smallwares' },
  { href: `${FA_BASE}/requests`, label: 'Requests' },
  { href: `${FA_BASE}/reports`, label: 'Reports' },
  { href: `${FA_BASE}/classes`, label: 'Classes & policy' },
]
const OTHER_TABS = ['pools', 'requests', 'reports', 'classes']

function activeTabHref(pathname: string): string {
  if (!pathname.startsWith(FA_BASE)) return FA_BASE
  const seg = pathname.slice(FA_BASE.length).split('/').filter(Boolean)[0]
  if (seg && OTHER_TABS.includes(seg)) return `${FA_BASE}/${seg}`
  return FA_BASE
}

/** The pending-request count shown on the Requests tab (shares the Requests page's cache key). */
function usePendingCount(): number {
  const q = useQuery<{ pendingCount: number }>({
    queryKey: ['fa-pending-count'],
    queryFn: () => api.get<{ pendingCount: number }>(`${FA_BASE}/requests?status=pending&limit=500`),
    staleTime: 30_000,
    retry: false,
    meta: { background: true },
  })
  return q.data?.pendingCount ?? 0
}

export function FaFrame({ title, subtitle, actions, back, children }: {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  /** Where the back link goes (default: the accounting hub). */
  back?: { href: string; label: string }
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? FA_BASE
  const active = activeTabHref(pathname)
  const pending = usePendingCount()
  const b = back ?? { href: '/accounting', label: '← Accounting' }
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 pt-5 border-b border-white/[0.05]">
        <Link href={b.href} className="text-xs text-white/40 hover:text-white/70">{b.label}</Link>
        <div className="flex flex-wrap items-start justify-between gap-3 mt-2">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">Fixed assets</p>
            <h1 className="text-2xl font-black text-white/90 break-words">{title}</h1>
            {subtitle && <div className="text-sm text-white/45 mt-1 max-w-2xl">{subtitle}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        <nav className="flex gap-1 mt-4 overflow-x-auto -mb-px" aria-label="Fixed assets sections">
          {TABS.map((t) => {
            const on = t.href === active
            return (
              <Link key={t.href} href={t.href} aria-current={on ? 'page' : undefined}
                className="px-3 sm:px-4 py-2.5 text-sm font-bold whitespace-nowrap transition-colors"
                style={on
                  ? { color: 'var(--erp-primary-ink)', borderBottom: '2px solid var(--erp-accent)' }
                  : { color: 'rgb(var(--fg-rgb) / 0.5)', borderBottom: '2px solid transparent' }}>
                {t.label}
                {t.label === 'Requests' && pending > 0 && <span className="s-badge-amber ml-2">{pending}</span>}
              </Link>
            )
          })}
        </nav>
      </header>
      <div className="px-4 sm:px-7 py-6 max-w-6xl mx-auto space-y-5">{children}</div>
    </div>
  )
}

/** Names of a company's outlets / brands for a form, from the lookups. */
export function forCompany<T extends { tenantId: string }>(list: T[] | undefined, tenantId: string): T[] {
  return (list ?? []).filter((x) => x.tenantId === tenantId)
}
