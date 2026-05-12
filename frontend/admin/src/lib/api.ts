// API client for servd operations frontend
//
// F43: read tokens through the auth store. zustand's `getState()` works in any
// context (component, hook, plain TS module) so we don't need to keep two
// copies of the token — one in the store and a mirror in localStorage. The
// store's persist middleware already writes to localStorage under its own key
// `servd-auth`.

import { useAuthStore } from '../store/auth'

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
  ) {
    super(message)
  }
}

let _refreshing: Promise<string | null> | null = null

async function refreshAccessToken(): Promise<string | null> {
  if (_refreshing) return _refreshing
  _refreshing = (async () => {
    try {
      const refreshToken = getRefreshToken()
      if (!refreshToken) return null
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { accessToken: string }
      // F43: write the new access token back through the store so persistence
      // and any subscribers (e.g. the socket reconnect logic) see the update.
      const cur = useAuthStore.getState()
      if (cur.user) cur.setAuth(cur.user, data.accessToken, refreshToken)
      return data.accessToken
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
  // Transactional kitchen routes: tenant is deterministic from the order's
  // conceptId. Prompting the operator to pick a company would be nonsense —
  // an order at Stax always lands on Bukhari, an order at Flipd always lands
  // on Clifton, period. (The backend re-derives + asserts this anyway.)
  /^\/orders\b/,
  /^\/pos\b/,
  /^\/kds\b/,
  /^\/kitchen-staff\b/,
  /^\/storefront\b/,
  /^\/reservations\b/,
  /^\/inventory\b/,
  /^\/recipes\b/,
  /^\/components\b/,
]

function isPortfolioGuarded(path: string, method: string): boolean {
  if (typeof window === 'undefined') return false
  if (localStorage.getItem('servd_view_all_tenants') !== '1') return false
  // Only mutating verbs need a tenant pinned. GET reads aggregate cleanly.
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase())) return false
  return !PORTFOLIO_GUARD_EXCLUSIONS.some((rx) => rx.test(path))
}

// Promise-based bridge to the global PortfolioWriteGuardModal. Resolves
// when the user picks a tenant; rejects when they cancel. Used inside the
// request fetcher so callers don't need to know the modal exists.
function awaitPortfolioTenantPick(intent: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onResolve = (e: Event) => {
      window.removeEventListener('servd:portfolio-write-resolve', onResolve)
      const detail = (e as CustomEvent<{ result: 'switched' | 'cancelled' }>).detail
      if (detail.result === 'switched') resolve()
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

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const token = getToken()
  const method = (options.method ?? 'GET').toUpperCase()

  // Portfolio safety net: pause and prompt for a target company before
  // writing if the user is in cross-tenant view. Only fires once per
  // session — after they pick, portfolio mode toggles off.
  if (isPortfolioGuarded(path, method)) {
    await awaitPortfolioTenantPick(describeIntent(method, path))
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

  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(portfolio && { 'x-servd-portfolio': '1' }),
      ...options.headers,
    },
  })

  // Auto-refresh on 401 then retry once
  if (res.status === 401 && retry) {
    const newToken = await refreshAccessToken()
    if (newToken) return request<T>(path, options, false)
    // Refresh failed — clear auth and redirect to login
    // F43: clear via the store so all subscribers (UI, socket) react.
    useAuthStore.getState().clearAuth()
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired')
  }

  if (!res.ok) {
    const data = (await res.json()) as { error: { code: string; message: string } }
    throw new ApiError(res.status, data.error.code, data.error.message)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
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
  pin: (pin: string) =>
    api.post<{ token: string; user: { id: string; name: string; role: string } }>('/auth/pin', { pin }),
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
  create: (body: unknown) => api.post<Order>('/orders', body),
  updateStatus: (id: string, status: string) =>
    api.patch<Order>(`/orders/${id}/status`, { status }),
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
}

export interface Shift {
  id: string
  userId: string
  status: string
  openedAt: string
  closedAt: string | null
  openingFloatCents: number
}

export interface ZReport {
  shiftId: string
  staffName: string
  openedAt: string
  closedAt: string | null
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
}
