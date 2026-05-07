// Storefront analytics — thin batching event tracker.
// Session ID persisted in localStorage. Never throws; analytics must not
// break ordering. All calls are no-ops during SSR.

const BATCH_SIZE = 10
const FLUSH_MS = 4000

export type TrackEvent =
  | 'page_view' | 'concept_view' | 'item_view' | 'item_added' | 'item_removed'
  | 'cart_viewed' | 'checkout_started' | 'checkout_step' | 'checkout_abandoned'
  | 'order_placed' | 'search' | 'filter_applied' | 'concept_switched'
  | 'promo_applied' | 'promo_failed'

interface QueuedEvent {
  event: TrackEvent
  properties?: Record<string, unknown>
  url?: string
}

let _sessionId: string | null = null
let _customerId: string | null = null
let _conceptId: string | null = null
let _buffer: QueuedEvent[] = []
let _timer: ReturnType<typeof setTimeout> | null = null
let _booted = false

function sessionId(): string {
  if (_sessionId) return _sessionId
  try {
    const stored = localStorage.getItem('_asid')
    if (stored) { _sessionId = stored; return _sessionId }
    const id = crypto.randomUUID()
    localStorage.setItem('_asid', id)
    _sessionId = id
  } catch { _sessionId = 'fallback' }
  return _sessionId!
}

async function flush() {
  if (_buffer.length === 0) return
  const events = _buffer.splice(0)
  try {
    const apiBase = ((typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__NEXT_PUBLIC_API_URL__ as string)
      || process.env['NEXT_PUBLIC_API_URL']
      || 'http://localhost:3001').replace(/\/$/, '') + '/api/v1'
    await fetch(`${apiBase}/analytics/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId(), customerId: _customerId, conceptId: _conceptId, events }),
      keepalive: true,
    })
  } catch { /* analytics must never break the app */ }
}

function schedule() {
  if (_timer) return
  _timer = setTimeout(() => { _timer = null; flush() }, FLUSH_MS)
}

function boot() {
  if (_booted || typeof window === 'undefined') return
  _booted = true
  window.addEventListener('pagehide', () => flush())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
}

export function setAnalyticsCustomer(id: string | null) { _customerId = id }
export function setAnalyticsConcept(id: string | null) { _conceptId = id }

export function track(event: TrackEvent, properties?: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  boot()
  _buffer.push({ event, properties, url: window.location.href })
  if (_buffer.length >= BATCH_SIZE) { if (_timer) { clearTimeout(_timer); _timer = null }; flush() }
  else schedule()
}

// Named helpers
export const trackPageView = (path?: string) =>
  track('page_view', path ? { path } : undefined)

export const trackConceptView = (conceptId: string, slug: string) =>
  track('concept_view', { conceptId, slug })

export const trackItemView = (itemId: string, name: string, priceCents: number, conceptId: string) =>
  track('item_view', { itemId, name, priceCents, conceptId })

export const trackItemAdded = (itemId: string, name: string, priceCents: number, qty: number, conceptId: string) =>
  track('item_added', { itemId, name, priceCents, qty, conceptId })

export const trackItemRemoved = (itemId: string, name: string, conceptId: string) =>
  track('item_removed', { itemId, name, conceptId })

export const trackCheckoutStarted = (conceptId: string, itemCount: number, subtotalCents: number) =>
  track('checkout_started', { conceptId, itemCount, subtotalCents })

export const trackCheckoutStep = (step: string, conceptId: string) =>
  track('checkout_step', { step, conceptId })

export const trackCheckoutAbandoned = (conceptId: string, step: string) =>
  track('checkout_abandoned', { conceptId, step })

export const trackOrderPlaced = (orderId: string, conceptId: string, totalCents: number, paymentMethod: string) =>
  track('order_placed', { orderId, conceptId, totalCents, paymentMethod })

export const trackSearch = (query: string, resultCount: number) =>
  track('search', { query, resultCount })

export const trackFilterApplied = (filter: string, value: string) =>
  track('filter_applied', { filter, value })

export const trackPromoApplied = (code: string, conceptId: string, discountCents: number) =>
  track('promo_applied', { code, conceptId, discountCents })

export const trackPromoFailed = (code: string, reason: string) =>
  track('promo_failed', { code, reason })
