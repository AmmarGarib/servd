// Redis-backed WhatsApp conversation session
// Key: wa:session:<phone>, TTL: 30 minutes of inactivity
//
// One shared GS Foods number takes orders for every brand of every company
// (owner decision, 2026-10-12), so a session starts WITHOUT a brand: the
// customer picks one from the brand menu, and only then are conceptId /
// conceptSlug / tenantId set. A cart always belongs to the session's brand —
// it never mixes brands, and switching brand asks before emptying it.
//
// Sessions written before the brand menu (v1: a brand from
// WHATSAPP_DEFAULT_CONCEPT, no tenantId, no brand-menu fields) are migrated
// on read by normaliseSession, so a conversation in flight at deploy time
// carries on where it was.

import { redis } from './redis.js'

export type WaStep =
  | 'idle'
  | 'brand'      // Sent the brand menu, waiting for a pick
  | 'switch'     // Asked "switch brand and empty the cart?"
  | 'browsing'   // Sent menu categories
  | 'category'   // Browsing items in a category
  | 'cart'       // Has items, reviewing cart
  | 'confirm'    // Confirming order details
  | 'done'       // Order placed

const STEPS: readonly WaStep[] = ['idle', 'brand', 'switch', 'browsing', 'category', 'cart', 'confirm', 'done']
/** Steps that only make sense once a brand is chosen. */
const BRAND_STEPS: readonly WaStep[] = ['browsing', 'category', 'cart', 'confirm']

export interface CartItem {
  menuItemId: string
  name: string
  priceCents: number
  quantity: number
}

export interface WaSession {
  /** Schema version — 2 since the brand menu. */
  v?: number
  phone: string
  /** The chosen brand; null until the customer picks one. */
  conceptId: string | null
  conceptSlug: string | null
  /** The chosen brand's company (Concept.tenantId). */
  tenantId?: string | null
  step: WaStep
  cart: CartItem[]
  selectedCategoryId?: string
  customerId?: string
  customerName?: string
  orderType: 'pickup' | 'delivery'
  /** Brand ids in the order the last brand menu listed them (typed "2" → the second). */
  brandOptions?: string[]
  /** The brand the customer asked to switch to while holding a cart. */
  pendingConceptId?: string | null
  /** Idempotency key for the order the summary was shown for (see conversation.ts). */
  orderKey?: string
  /**
   * The options the last prompt showed (buttons or list rows), in order. The
   * production gateway is text-only — buttons and lists arrive as numbered /
   * bulleted text and come back as TYPED replies — so a typed number or title
   * is mapped back to its option id (conversation.ts matchOption).
   */
  lastOptions?: WaOption[]
}

export interface WaOption {
  id: string
  /** The full label (before any clipping to Meta's title limits). */
  title: string
}

const TTL = 30 * 60  // 30 minutes

function key(phone: string) {
  return `wa:session:${phone}`
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

function option(v: unknown): WaOption | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const id = str(r['id'])
  return id ? { id, title: typeof r['title'] === 'string' ? r['title'] : '' } : null
}

function cartItem(v: unknown): CartItem | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const menuItemId = str(r['menuItemId'])
  const quantity = Number(r['quantity'])
  const priceCents = Number(r['priceCents'])
  if (!menuItemId || !Number.isInteger(quantity) || quantity <= 0) return null
  return {
    menuItemId,
    name: typeof r['name'] === 'string' ? r['name'] : '',
    priceCents: Number.isFinite(priceCents) ? priceCents : 0,
    quantity,
  }
}

/**
 * Migrate a stored session (any version) to the current shape. Missing or
 * malformed fields get safe defaults; a session with no brand can hold no cart
 * and cannot sit on a brand-only step. Returns null for something that is not
 * a session at all.
 */
export function normaliseSession(raw: unknown, phone: string): WaSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const conceptId = str(r['conceptId']) ?? null
  let step: WaStep = STEPS.includes(r['step'] as WaStep) ? (r['step'] as WaStep) : 'idle'
  let cart = Array.isArray(r['cart']) ? r['cart'].map(cartItem).filter((c): c is CartItem => c !== null) : []
  if (!conceptId) {
    cart = []
    if (BRAND_STEPS.includes(step) || step === 'switch') step = 'idle'
  }
  const session: WaSession = {
    v: 2,
    phone: str(r['phone']) ?? phone,
    conceptId,
    conceptSlug: conceptId ? (str(r['conceptSlug']) ?? null) : null,
    tenantId: conceptId ? (str(r['tenantId']) ?? null) : null,
    step,
    cart,
    orderType: r['orderType'] === 'delivery' ? 'delivery' : 'pickup',
    brandOptions: Array.isArray(r['brandOptions']) ? r['brandOptions'].filter((x): x is string => typeof x === 'string') : [],
    pendingConceptId: str(r['pendingConceptId']) ?? null,
    lastOptions: Array.isArray(r['lastOptions']) ? r['lastOptions'].map(option).filter((o): o is WaOption => o !== null) : [],
  }
  const selectedCategoryId = str(r['selectedCategoryId'])
  const customerId = str(r['customerId'])
  const customerName = str(r['customerName'])
  const orderKey = str(r['orderKey'])
  if (selectedCategoryId) session.selectedCategoryId = selectedCategoryId
  if (customerId) session.customerId = customerId
  if (customerName) session.customerName = customerName
  if (orderKey) session.orderKey = orderKey
  if (session.step === 'switch' && !session.pendingConceptId) session.step = session.cart.length > 0 ? 'cart' : 'idle'
  return session
}

export async function getSession(phone: string): Promise<WaSession | null> {
  try {
    const raw = await redis.get(key(phone))
    if (!raw) return null
    return normaliseSession(JSON.parse(raw), phone)
  } catch {
    return null
  }
}

export async function saveSession(session: WaSession): Promise<void> {
  await redis.set(key(session.phone), JSON.stringify({ ...session, v: 2 }), 'EX', TTL)
}

export async function clearSession(phone: string): Promise<void> {
  await redis.del(key(phone))
}

/**
 * A fresh session. With no brand (the shared number's normal start) the
 * customer picks one from the brand menu; a brand may be given when the
 * caller already knows it (tests, a reorder).
 */
export function newSession(
  phone: string,
  conceptId: string | null = null,
  conceptSlug: string | null = null,
  tenantId: string | null = null,
): WaSession {
  return {
    v: 2,
    phone,
    conceptId: conceptId || null,
    conceptSlug: conceptId ? (conceptSlug || null) : null,
    tenantId: conceptId ? tenantId : null,
    step: 'idle',
    cart: [],
    orderType: 'pickup',
    brandOptions: [],
    pendingConceptId: null,
    lastOptions: [],
  }
}
