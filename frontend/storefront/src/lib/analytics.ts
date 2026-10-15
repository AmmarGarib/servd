// Storefront analytics. TWO sinks behind ONE `track()`:
//
//  1. First-party: the batching tracker below (POST /analytics/events,
//     company-scoped on the API). Session ID persisted in localStorage.
//  2. Google Analytics 4: the SEO events in GA_EVENTS, sent ONLY when
//     NEXT_PUBLIC_GA4_ID is set AND the visitor pressed "Accept" on the
//     consent notice (components/analytics/Analytics.tsx). No id → no script,
//     no cookie, no notice. Consent Mode defaults to denied, and gtag.js is
//     not even downloaded until consent is granted.
//
// Never throws; analytics must not break ordering. All calls are no-ops
// during SSR. GA params carry values and ids only, never personal data
// (no names, phones, emails, addresses).

const BATCH_SIZE = 10
const FLUSH_MS = 4000

export type TrackEvent =
  | 'page_view' | 'concept_view' | 'item_view' | 'item_added' | 'item_removed'
  | 'cart_viewed' | 'checkout_started' | 'checkout_step' | 'checkout_abandoned'
  | 'order_placed' | 'search' | 'filter_applied' | 'concept_switched'
  | 'promo_applied' | 'promo_failed'
  | GaEvent

/** The GA4 events (the SEO round-1 contract). Sent to GA4 only. */
export type GaEvent =
  | 'view_item' | 'add_to_cart' | 'begin_checkout' | 'purchase'
  | 'reservation' | 'waitlist_join' | 'whatsapp_click' | 'contact_submit'

const GA_EVENTS: ReadonlySet<string> = new Set<GaEvent>([
  'view_item', 'add_to_cart', 'begin_checkout', 'purchase',
  'reservation', 'waitlist_join', 'whatsapp_click', 'contact_submit',
])

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
  if (GA_EVENTS.has(event)) { gaEvent(event as GaEvent, properties); return }
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


// ── Google Analytics 4 + consent ─────────────────────────────────────────────
// Build-time id (NEXT_PUBLIC_, inlined). Anything that is not a GA4 measurement
// id is treated as unset.
const RAW_GA4_ID = (process.env['NEXT_PUBLIC_GA4_ID'] ?? '').trim()
export const GA4_ID = /^G-[A-Z0-9]{4,20}$/.test(RAW_GA4_ID) ? RAW_GA4_ID : ''
export const gaConfigured = (): boolean => GA4_ID !== ''

export type ConsentChoice = 'granted' | 'denied'
const CONSENT_KEY = 'sv_consent'
export const CONSENT_EVENT = 'servd:consent'
/** Dispatch on window to re-open the notice (e.g. a footer "Cookie settings" link). */
export const CONSENT_OPEN_EVENT = 'servd:consent-open'

/** Paths where analytics never runs: the editor's iframe, the rider tool, preview. */
export function analyticsPathSkipped(pathname: string | null | undefined): boolean {
  const p = pathname ?? '/'
  return /^\/(editor-frame|rider|preview)(\/|$)/.test(p)
}

export function readConsent(): ConsentChoice | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY)
    return v === 'granted' || v === 'denied' ? v : null
  } catch { return null }
}

type GtagWindow = Window & { dataLayer?: unknown[]; gtag?: (...a: unknown[]) => void; __svGaLoaded?: boolean }

/** Defines dataLayer/gtag and the Consent Mode defaults (all denied). Idempotent. */
function ensureGtag(): GtagWindow['gtag'] {
  const w = window as GtagWindow
  if (w.gtag) return w.gtag
  w.dataLayer = w.dataLayer || []
  w.gtag = function () { (w.dataLayer as unknown[]).push(arguments) } // GA needs the arguments object
  w.gtag('consent', 'default', {
    analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    wait_for_update: 500,
  })
  return w.gtag
}

/** Page URL for GA: no query string (tokens, codes) and no order id. */
function cleanPath(): string {
  return window.location.pathname.replace(/\/order\/[^/]+/, '/order/_')
}

/** Loads GA once, only when configured, on an allowed path, with consent granted. */
function loadGa(): void {
  const w = window as GtagWindow
  if (!gaConfigured() || w.__svGaLoaded || analyticsPathSkipped(window.location.pathname)) return
  const gtag = ensureGtag()!
  w.__svGaLoaded = true
  gtag('consent', 'update', { analytics_storage: 'granted' })
  gtag('js', new Date())
  // Page views are sent by hand on every route change (sendPageView).
  gtag('config', GA4_ID, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false })
  const s = document.createElement('script')
  s.async = true
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA4_ID)}`
  document.head.appendChild(s)
}

/** Records the visitor's choice. 'granted' loads GA; 'denied' keeps it off. */
export function setConsent(choice: ConsentChoice): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(CONSENT_KEY, choice) } catch { /* choice lasts this page only */ }
  if (choice === 'granted') loadGa()
  else if ((window as GtagWindow).gtag) (window as GtagWindow).gtag!('consent', 'update', { analytics_storage: 'denied' })
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: choice }))
}

/** Called on mount: sets the denied defaults, and loads GA if consent was given before. */
export function initAnalytics(): ConsentChoice | null {
  if (typeof window === 'undefined' || !gaConfigured()) return null
  ensureGtag()
  const c = readConsent()
  if (c === 'granted') loadGa()
  return c
}

function gaOn(): boolean {
  return typeof window !== 'undefined' && gaConfigured()
    && (window as GtagWindow).__svGaLoaded === true
    && readConsent() === 'granted'
    && !analyticsPathSkipped(window.location.pathname)
}

/** page_view for the current route (call after every navigation). */
export function sendPageView(): void {
  if (!gaOn()) return
  const path = cleanPath()
  ;(window as GtagWindow).gtag!('event', 'page_view', {
    page_location: window.location.origin + path,
    page_path: path,
    page_title: document.title,
  })
}

function gaEvent(event: GaEvent, params?: Record<string, unknown>): void {
  try {
    if (!gaOn()) return
    ;(window as GtagWindow).gtag!('event', event, params ?? {})
  } catch { /* analytics must never break the app */ }
}

// ── purchase: once per order, from the order page ────────────────────────────
// Checkout arms the order (sessionStorage) right after placing it; the tracker
// page it lands on fires `purchase` once and disarms. A later visit to the
// tracker (another device, an old link) therefore never counts a second sale.
const ARMED_KEY = 'sv_purchase_armed'

export function armPurchase(orderId: string): void {
  try { sessionStorage.setItem(ARMED_KEY, orderId) } catch { /* no purchase event then */ }
}

/** Order reference shown everywhere: the last 8 characters of the id, uppercased. */
const orderRef = (id: string): string => id.slice(-8).toUpperCase()

export function trackPurchaseOnce(order: { id: string; totalCents: number; taxCents?: number; slug: string; isTest?: boolean; status?: string }): void {
  try {
    if (typeof window === 'undefined' || order.isTest) return
    if (sessionStorage.getItem(ARMED_KEY) !== order.id) return
    if (['cancelled', 'rejected', 'refunded'].includes(order.status ?? '')) return
    sessionStorage.removeItem(ARMED_KEY)
    track('purchase', {
      transaction_id: orderRef(order.id),
      currency: 'PKR',
      value: order.totalCents / 100,
      ...(order.taxCents != null ? { tax: order.taxCents / 100 } : {}),
      item_brand: order.slug,
    })
  } catch { /* never break the tracker */ }
}
