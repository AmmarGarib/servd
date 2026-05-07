// API client for servd operations frontend

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

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
      const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('servd_refresh_token') : null
      if (!refreshToken) return null
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { accessToken: string }
      if (typeof window !== 'undefined') localStorage.setItem('servd_token', data.accessToken)
      return data.accessToken
    } finally {
      _refreshing = null
    }
  })()
  return _refreshing
}

async function request<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('servd_token') : null

  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  })

  // Auto-refresh on 401 then retry once
  if (res.status === 401 && retry) {
    const newToken = await refreshAccessToken()
    if (newToken) return request<T>(path, options, false)
    // Refresh failed — clear auth and redirect to login
    if (typeof window !== 'undefined') {
      localStorage.removeItem('servd_token')
      localStorage.removeItem('servd_refresh_token')
      window.location.href = '/login'
    }
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
