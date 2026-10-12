// API client for servd operations frontend
//
// F43: read tokens through the auth store. zustand's `getState()` works in any
// context (component, hook, plain TS module) so we don't need to keep two
// copies of the token — one in the store and a mirror in localStorage. The
// store's persist middleware already writes to localStorage under its own key
// `servd-auth`.

import { useAuthStore } from '../store/auth'
import { useBrandFilter } from '../store/brandFilter'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

function getToken(): string | null {
  return useAuthStore.getState().token
}

function getRefreshToken(): string | null {
  return useAuthStore.getState().refreshToken
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The API's `error.details` (e.g. go-live 409 NOT_READY `{ missing }`,
     *  TERMINAL_CHARGE_ACTIVE `{ chargeId }`), when it sent any. */
    public details?: unknown,
  ) {
    super(message)
  }
}

/** Read an error body; a non-JSON answer (a proxy's HTML 502) still becomes an ApiError. */
async function errorFrom(res: Response, fallbackCode: string, fallbackMessage: string): Promise<ApiError> {
  const data = await res.json().catch(() => null) as { error?: { code?: string; message?: string; details?: unknown } } | null
  return new ApiError(
    res.status,
    data?.error?.code ?? fallbackCode,
    data?.error?.message ?? fallbackMessage,
    data?.error?.details,
  )
}

let _refreshing: Promise<string | null> | null = null

async function refreshAccessToken(): Promise<string | null> {
  if (_refreshing) return _refreshing
  _refreshing = (async () => {
    try {
      // refreshToken may be null after a reload (we no longer persist it) — the
      // httpOnly refresh cookie carries it, so always attempt the refresh.
      const refreshToken = getRefreshToken()
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { accessToken?: string }
      // Mirror the rotated token into memory for the WS handshake. The cookie is
      // the real credential; return a sentinel so the request retries even when
      // the body carries no token.
      const cur = useAuthStore.getState()
      if (cur.user && data.accessToken) cur.setAuth(cur.user, data.accessToken, refreshToken ?? undefined)
      return data.accessToken ?? 'cookie'
    } finally {
      _refreshing = null
    }
  })()
  return _refreshing
}

// ─── Portfolio-write guard (auto-applied to every mutating request) ──────────
//
// When the user is in "Portfolio view" (viewing data aggregated across all
// their companies), any attempt to write a new record is ambiguous — which
// company should the new brand / order / promo go into? Rather than wire a
// hook into all ~70 create flows individually, we intercept here: every
// POST that's not on the exclusion list dispatches `servd:portfolio-write-
// request` and waits for the global PortfolioWriteGuardModal to resolve
// (user picks a tenant → session switches → request proceeds).
//
// Excluded paths fire normally even in portfolio mode — these are operations
// that don't bind to a specific tenant (auth, tenant management, account-
// level prefs, idempotent media uploads).
const PORTFOLIO_GUARD_EXCLUSIONS: readonly RegExp[] = [
  /^\/auth\b/,                  // login, refresh, PIN, magic link, clock in/out
  /^\/tenants\b/,               // tenant primitives: switch, list, merge
  /^\/me\b/,                    // self-prefs (theme, notifications)
  /^\/media\/upload-url\b/,     // presigned URL is tenant-agnostic
  /^\/site-layouts\b/,          // page's company comes from its slug (brand) or none (shared pages)
  // Transactional kitchen routes: tenant is deterministic from the order's
  // conceptId. Prompting the operator to pick a company would be nonsense —
  // an order at Stax always lands on Bukhari, an order at Flipd always lands
  // on Clifton, period. (The backend re-derives + asserts this anyway.)
  /^\/orders\b/,
  /^\/pos\b/,
  /^\/kds\b/,
  /^\/expo\b/,                  // fire / reject / serve — order pins the tenant
  /^\/storefront\b/,
  /^\/reservations\b/,
  /^\/inventory\b/,
  /^\/recipes\b/,
  /^\/components\b/,
  // Projections span multiple brands (often multiple tenants too) — they're
  // an analytical/planning artifact, not a tenant-bound record. Picking one
  // company to "own" a multi-brand projection would be wrong.
  /^\/projections\b/,
]

function isPortfolioGuarded(path: string, method: string): boolean {
  if (typeof window === 'undefined') return false
  if (localStorage.getItem('servd_view_all_tenants') !== '1') return false
  // Only POST needs the guard. PATCH/PUT/DELETE target existing rows and the
  // backend derives the tenant from the row itself — prompting the operator
  // would be both wrong (could move the row cross-tenant accidentally) and
  // disruptive (every brand-edit save would pop the modal).
  if (method.toUpperCase() !== 'POST') return false
  return !PORTFOLIO_GUARD_EXCLUSIONS.some((rx) => rx.test(path))
}

// Promise-based bridge to the global PortfolioWriteGuardModal. Resolves
// when the user picks a tenant; rejects when they cancel. Used inside the
// request fetcher so callers don't need to know the modal exists.
function awaitPortfolioTenantPick(intent: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onResolve = (e: Event) => {
      window.removeEventListener('servd:portfolio-write-resolve', onResolve)
      const detail = (e as CustomEvent<{ result: 'picked' | 'cancelled' }>).detail
      if (detail.result === 'picked') resolve()
      else reject(new ApiError(0, 'PORTFOLIO_WRITE_CANCELLED', 'You cancelled — write not sent.'))
    }
    window.addEventListener('servd:portfolio-write-resolve', onResolve)
    window.dispatchEvent(new CustomEvent('servd:portfolio-write-request', {
      detail: { intent },
    }))
  })
}

// Best-effort guess at what the user is doing, for the modal's copy.
// Reads the path: e.g. POST /concepts → "create a brand". Falls back to a
// generic phrasing if no rule matches.
function describeIntent(method: string, path: string): string {
  const verb = method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update'
  const seg = path.split('/').filter(Boolean)[0] ?? ''
  const noun = seg.replace(/-/g, ' ')
  return `${verb} ${noun}`
}

interface RequestExtra {
  /**
   * Pin this write to a specific tenant — sets `x-servd-active-tenant: <id>`.
   * When provided, the global PortfolioWriteGuardModal is bypassed because
   * the caller has already resolved which company the write targets (e.g.
   * via an inline picker in the create modal). Reads aren't affected: GETs
   * stay in portfolio view via `x-servd-portfolio` regardless of this.
   */
  tenantId?: string
}

async function request<T>(path: string, options: RequestInit = {}, retry = true, extra: RequestExtra = {}): Promise<T> {
  const token = getToken()
  const method = (options.method ?? 'GET').toUpperCase()

  // Inline-picker path: caller passed an explicit tenantId. Skip the global
  // guard prompt — the user already picked. Header is read by the backend
  // auth middleware and overrides req.staffUser.tenantId for this request.
  //
  // Fallback path: portfolio view + no explicit tenantId → fire the global
  // modal, wait for the user to pick. Modal sets a module-level slot on
  // useEnsureTenant; we consume it here and forward as the header.
  let resolvedTenantId = extra.tenantId
  if (isPortfolioGuarded(path, method) && !resolvedTenantId) {
    await awaitPortfolioTenantPick(describeIntent(method, path))
    // Side-effect: modal stashed the picked id. Pull + clear so the next
    // unrelated write doesn't accidentally inherit it.
    const { consumePickedTenantId } = await import('../hooks/useEnsureTenant')
    resolvedTenantId = consumePickedTenantId() ?? undefined
  }

  // Portfolio mode: when the operator has flipped the sidebar tenant
  // switcher to "All companies", every read should aggregate across every
  // tenant they own. We signal this to the backend via the
  // `x-servd-portfolio` header rather than mutating the URL — keeps the
  // existing route shapes intact, easy to toggle off centrally if it ever
  // misbehaves.
  const portfolio = typeof window !== 'undefined'
    && localStorage.getItem('servd_view_all_tenants') === '1'
    && ['GET', 'HEAD'].includes(method)

  // Global brand filter (store/brandFilter.ts) — reads only. A write must
  // never be narrowed by a view filter.
  const brand = typeof window !== 'undefined' && ['GET', 'HEAD'].includes(method)
    ? useBrandFilter.getState().brandId
    : null

  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...options,
    // Send the httpOnly session cookie. Bearer is still attached when an
    // in-memory token exists (fresh login this session); after a reload there's
    // no token and the cookie alone authenticates.
    credentials: 'include',
    headers: {
      // Only a request that carries a body declares one: an empty body sent as
      // application/json is a 400 on some servers (Fastify's empty-JSON rule).
      ...(options.body != null && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(portfolio && { 'x-servd-portfolio': '1' }),
      ...(brand && { 'x-servd-brand': brand }),
      ...(resolvedTenantId && { 'x-servd-active-tenant': resolvedTenantId }),
      ...options.headers,
    },
  })

  // Auto-refresh on 401 then retry once
  if (res.status === 401 && retry) {
    const newToken = await refreshAccessToken()
    if (newToken) return request<T>(path, options, false, extra)
    // Refresh failed — clear auth and redirect to login
    // F43: clear via the store so all subscribers (UI, socket) react.
    useAuthStore.getState().clearAuth()
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired')
  }

  if (!res.ok) {
    throw await errorFrom(res, 'HTTP_' + res.status, `Request failed (${res.status})`)
  }

  if (brand && typeof window !== 'undefined') {
    useBrandFilter.getState().record(window.location.pathname, res.headers.get('x-servd-brand-applied') === '1')
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** Download a file the API generates (CSV exports), with the session attached.
 *  An expired session is refreshed and the download retried once, the same
 *  as request(); any failure rejects, for the caller to show. */
async function download(path: string, filename: string, retry = true): Promise<void> {
  const token = getToken()
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    credentials: 'include',
    // Same view as the screen it was downloaded from: portfolio spans companies.
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(localStorage.getItem('servd_view_all_tenants') === '1' && { 'x-servd-portfolio': '1' }),
    },
  })
  if (res.status === 401 && retry) {
    if (await refreshAccessToken()) return download(path, filename, false)
    useAuthStore.getState().clearAuth()
    window.location.href = '/login'
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired')
  }
  if (!res.ok) {
    throw await errorFrom(res, 'DOWNLOAD_FAILED', 'Download failed')
  }
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const api = {
  download,
  get:    <T>(path: string) => request<T>(path),
  // Mutations accept an optional second arg shape: either the body alone
  // (legacy callers) or `{ tenantId }` to pin the write to a specific company
  // — used by inline pickers in /workforce, /procurement, /settings etc. so
  // the operator stays in portfolio view while writing.
  post:   <T>(path: string, body: unknown, extra?: RequestExtra) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }, true, extra),
  patch:  <T>(path: string, body: unknown, extra?: RequestExtra) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }, true, extra),
  put:    <T>(path: string, body: unknown, extra?: RequestExtra) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }, true, extra),
  delete: <T>(path: string, extra?: RequestExtra) =>
    request<T>(path, { method: 'DELETE' }, true, extra),
  // Same as `get` but force the portfolio header on. Use this from CEO
  // management surfaces (e.g. /settings concepts list) where the user is
  // managing every brand they own regardless of which tenant the sidebar
  // switcher is currently pointing at.
  getAcrossTenants: <T>(path: string) =>
    request<T>(path, { headers: { 'x-servd-portfolio': '1' } }),
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ accessToken: string; refreshToken: string; user: { id: string; name: string; role: string } }>(
      '/auth/login',
      { email, password },
    ),
  refresh: (refreshToken: string) =>
    api.post<{ accessToken: string }>('/auth/refresh', { refreshToken }),
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export const ordersApi = {
  list: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return api.get<{ data: Order[]; cursor: string | null; hasMore: boolean }>(`/orders${qs}`)
  },
  get: (id: string) => api.get<Order>(`/orders/${id}`),
  // Kitchen / service progress only — the API refuses 'cancelled' here.
  updateStatus: (id: string, status: string) =>
    api.patch<Order>(`/orders/${id}/status`, { status }),
  // The one staff cancel: managers only, reason required, audited.
  cancel: (id: string, reason: string) =>
    api.post<{ ok: true; order: Order }>(`/orders/${id}/cancel`, { reason }),
  updateItemStatus: (itemId: string, status: string) =>
    api.patch<OrderItem>(`/order-items/${itemId}/status`, { status }),
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

export const menuApi = {
  getMenu: (conceptId: string) => api.get<Category[]>(`/menu/${conceptId}`),
  createCategory: (body: { conceptId: string; name: string; sortOrder?: number }) =>
    api.post<Category>('/menu/categories', body),
  updateCategory: (id: string, body: Partial<{ name: string; sortOrder: number }>) =>
    api.patch<Category>(`/menu/categories/${id}`, body),
  deleteCategory: (id: string) => api.delete<void>(`/menu/categories/${id}`),
  createItem: (body: unknown) => api.post<MenuItem>('/menu/items', body),
  updateItem: (id: string, body: unknown) => api.patch<MenuItem>(`/menu/items/${id}`, body),
  deleteItem: (id: string) => api.delete<void>(`/menu/items/${id}`),
  toggleAvailability: (id: string, isAvailable: boolean) =>
    api.patch<MenuItem>(`/menu/items/${id}/availability`, { isAvailable }),
}

// ─── POS ──────────────────────────────────────────────────────────────────────

export const posApi = {
  createOrder: (body: unknown) => api.post<Order>('/pos/orders', body),
  processPayment: (body: unknown) => api.post<{ payments: Payment[] }>('/pos/payments', body),
  openShift: (openingFloatCents: number) => api.post<Shift>('/pos/shifts/open', { openingFloatCents }),
  closeShift: (shiftId: string, closingFloatCents: number, notes?: string) =>
    api.post<ZReport>(`/pos/shifts/${shiftId}/close`, { closingFloatCents, notes }),
  getZReport: (shiftId: string) => api.get<ZReport>(`/pos/shifts/${shiftId}/zreport`),
  // The caller's open drawer (or null) — the server, not local storage, says
  // which shift this user is on.
  currentShift: () => api.get<{ shift: { id: string; openedAt: string; openingFloatCents: number; tenantId: string | null } | null }>('/pos/shifts/current'),
  // The one comp engine: capped, PIN-approved above the cashier cap, on the drawer.
  compOrder: (orderId: string, body: { amountCents: number; reason: string; shiftId: string; managerOverridePin?: string; staffMealFor?: string }) =>
    api.post<{ id: string; orderCompleted: boolean }>(`/pos/orders/${orderId}/comp`, body),
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Order {
  id: string
  conceptId: string
  source: string
  status: string
  totalCents: number
  discountCents: number
  taxCents: number
  placedAt: string
  completedAt: string | null
  customerName: string | null
  deliveryNotes: string | null
  riderId: string | null
  table: { label: string } | null
  concept: { name: string; slug: string }
  rider?: { id: string; name: string; phone: string } | null
  items: OrderItem[]
  payments: Payment[]
}

export interface OrderItem {
  id: string
  orderId: string
  menuItemId: string | null
  name: string
  quantity: number
  unitPriceCents: number
  status: string
  stationId: string | null
  station: { name: string } | null
  notes: string | null
  course: number | null
  firedAt: string | null
  scheduledFireAt: string | null
  bumpPhotoUrl: string | null
  modifiers: OrderItemModifier[]
  menuItem: { imageUrl: string | null; nameUrdu: string | null; instructions: string | null; instructionsUrdu: string | null } | null
}

export interface OrderItemModifier {
  id: string
  name: string
  priceDeltaCents: number
}

export interface MenuItem {
  id: string
  conceptId: string
  categoryId: string
  name: string
  nameUrdu: string | null
  description: string | null
  instructions: string | null
  instructionsUrdu: string | null
  priceCents: number
  imageUrl: string | null
  videoUrl: string | null
  isAvailable: boolean
  displayOrder: number
  modifierGroups: ModifierGroup[]
}

export interface ModifierGroup {
  id: string
  name: string
  isRequired: boolean
  minSelect: number
  maxSelect: number
  modifiers: Modifier[]
}

export interface Modifier {
  id: string
  name: string
  priceDeltaCents: number
  isDefault: boolean
}

export interface Category {
  id: string
  name: string
  sortOrder: number
  items: MenuItem[]
}

export interface Payment {
  id: string
  method: string
  amountCents: number
  status: string
  changeCents: number | null
  /** A Raast QR payment's reconciliation state (GET /orders/:id). */
  raastReceipt?: RaastReceiptState | null
}

// ─── Raast QR (2026-10-12) ───────────────────────────────────────────────────
// A Raast payment completes the sale at the till; its RaastReceipt stays
// 'provisional' until a bank-statement line shows the money ('matched').

export type RaastReceiptStatus = 'awaiting' | 'provisional' | 'matched' | 'cancelled' | 'unreceived' | 'needs_attention'

export interface RaastReceiptState {
  status: RaastReceiptStatus
  bankRef: string | null
  confirmedVia: 'cashier' | 'sms' | 'bank_api' | null
  smsConfirmedAt: string | null
  matchedAt: string | null
}

/** Plain words for a Raast receipt's state (finance and the order page). */
export const RAAST_STATUS_LABEL: Record<RaastReceiptStatus, string> = {
  awaiting: 'Waiting for the transfer',
  provisional: 'Provisional — not on a bank statement yet',
  matched: 'Matched to the bank statement',
  cancelled: 'Cancelled',
  unreceived: 'Written off — never received',
  needs_attention: 'Needs attention',
}

/** Short chip text for a Raast receipt's state. */
export const RAAST_STATUS_SHORT: Record<RaastReceiptStatus, string> = {
  awaiting: 'Awaiting',
  provisional: 'Provisional',
  matched: 'Matched',
  cancelled: 'Cancelled',
  unreceived: 'Not received',
  needs_attention: 'Needs attention',
}

/**
 * Payment-method labels (the server's lib/tenders.ts TENDER_LABEL): tills take
 * Cash, Card – Keenu and Raast QR; Keenu QR is retired (old rows only).
 */
export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card – Keenu',
  raast: 'Raast QR',
  keenu_qr: 'Keenu QR (retired)',
  comp: 'Comp',
  split: 'Split',
  wallet: 'Wallet',
  gift_card: 'Gift card',
}

export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return ''
  return PAYMENT_METHOD_LABEL[method] ?? method.replace(/_/g, ' ')
}

export interface Shift {
  id: string
  userId: string
  status: string
  openedAt: string
  closedAt: string | null
  openingFloatCents: number
}

// GET /pos/shifts/:id/zreport — the one shift summary. Expected cash is the
// one drawer formula (backend lib/drawer.ts); isBalanced is judged against the
// drawer company's own tolerance, so clients never hard-code a threshold.
export interface ZReport {
  shiftId: string
  staffName: string
  openedAt: string
  closedAt: string | null
  status: 'open' | 'closed'
  notes: string | null
  cashSales: number
  cardSales: number
  walletSales: number
  totalSales: number
  totalOrders: number
  totalDiscounts: number
  totalTax: number
  expectedCashInDrawer: number
  actualCashInDrawer: number | null
  cashVariance: number | null
  openingFloatCents: number
  closingFloatCents: number | null
  grossCents: number
  compCents: number
  refundsCents: number
  cashRefundsCents: number
  byMethod: Array<{ method: string; count: number; amountCents: number }>
  /** Raast QR takings on this drawer (absent on an API without Raast). */
  raastSales?: number
  raastCount?: number
  /** Of raastSales: not on a bank statement yet / matched to one. */
  raastProvisionalCents?: number
  raastMatchedCents?: number
  cashMovements: { drops: number; adds: number; payouts: number; payins: number }
  expectedCashCents: number
  varianceCents: number | null
  varianceLimitCents: number
  isBalanced: boolean
}
