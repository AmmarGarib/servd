// WhatsApp ordering conversation state machine
// Flow: idle → brand → browsing → category → cart → confirm → done
//
// ONE shared GS Foods number takes orders for every brand of every company
// (owner decision, 2026-10-12). A conversation starts with the BRAND MENU —
// the brands that take orders right now, by the same rules the storefront
// uses (active, not deleted, shown on the storefront, open by their opening
// hours in Karachi time) across every company, as the public storefront does.
// The customer picks one and the original flow continues for that brand. One
// brand open → straight to it; none → "ordering is closed right now".
//
// A cart belongs to ONE brand: picking another brand while holding a cart asks
// before emptying it. The order is created at the chosen brand, so it lands
// in that brand's company, priced by that brand's tender GST rate (cash — paid
// on collection) and that company's service charge (lib/pricing priceOrder).
// WhatsApp orders redeem no loyalty, wallet, gift card or promo; points they
// earn accrue at the brand's company when the order completes, like any order.
//
// Member-aware: if the inbound phone matches a known Customer row, we greet
// them by name. When their last order's brand still takes orders, the
// greeting offers "Reorder last" at that brand and skips the brand menu.
//
// WHATSAPP_DEFAULT_CONCEPT is optional now: when it names a brand that takes
// orders it is listed first, and it is the fallback when the brand list
// cannot be read. Missing or wrong, it is ignored — never an error.
//
// The brand must stay live: every message on a session re-checks it, and
// placeOrder refuses a brand switched off, hidden or deleted since the pick.
//
// The production gateway is text-only (lib/whatsapp.ts renders buttons and
// lists as text), so every prompt remembers its options and a TYPED number or
// title is taken as that option's tap (matchOption).
//
// Copy is servd's neutral voice — no emoji, no exclamation marks — because the
// same words go out for every brand, Simmer included (its voice rules forbid
// both). Brand names go through formatBrandName.

import { randomUUID } from 'node:crypto'
import type { OrderDTO } from '@servd/types'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { priceOrder } from '../../lib/pricing.js'
import { sendText, sendInteractiveList, sendButtons } from '../../lib/whatsapp.js'
import { customerScope, type SendScope } from '../../lib/outboundScope.js'
import {
  getSession, saveSession, clearSession, newSession,
  type WaSession, type CartItem, type WaOption,
} from '../../lib/wa-session.js'
import { ingestOrder } from '../../modules/orders/service.js'
import { orderingState, sectionVisibleAt, assertItemsServedAt } from '../../modules/storefront/serviceHours.js'
import { findCustomerByPhone } from '../../lib/customer-channels.js'
import { assertNotBannedAtCompany } from '../../lib/strikes.js'
import { AppError } from '../../lib/errors.js'
import { fmtPkr as fmtPkrShared } from '../../modules/accounting/csv.js'
import { formatBrandName } from '../../lib/brandName.js'

// The one PKR formatter (modules/accounting/csv.ts), in the bot's "PKR 1234" form.
const fmtPkr = (cents: number) => fmtPkrShared(cents, { symbol: true, decimals: 0, group: false })

// ─── Brands that take orders ─────────────────────────────────────────────────

export interface OrderingBrand {
  id: string
  name: string
  slug: string
  tenantId: string
}

/** WhatsApp list rows: at most 10, titles at most 24 characters (Meta's limits). */
const MAX_LIST_ROWS = 10
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/**
 * The storefront's "this brand takes orders" flags (hours aside): active, not
 * deleted, shown on the customer ordering page, and in a company (an order
 * needs one). The brand menu, every step of a session already on a brand, and
 * placeOrder all use this one rule.
 */
const LIVE_BRAND = { isActive: true, deletedAt: null, storefrontVisible: true, tenantId: { not: null } }
/** A dish a customer can order: available, not deleted, priced. */
const ORDERABLE_ITEM = { isAvailable: true, deletedAt: null, priceCents: { gt: 0 } }
/** A menu section that is switched on (time-of-day is checked with sectionVisibleAt). */
const LIVE_SECTION = { isActive: true, deletedAt: null }

/** The brand WHATSAPP_DEFAULT_CONCEPT names, if it is set and names a live brand. Never throws. */
/**
 * Replies about a brand's order name the brand's company: a test company's
 * brand never messages a real customer (lib/outboundScope.ts). Before a brand
 * is picked there is no company, and the reply goes out as before.
 */
function replyScope(session: WaSession | null | undefined): SendScope {
  return customerScope(session?.tenantId ?? null)
}

async function defaultConcept(): Promise<OrderingBrand | null> {
  const slug = process.env['WHATSAPP_DEFAULT_CONCEPT']?.trim()
  if (!slug) return null
  const c = await prisma.concept.findFirst({
    where: { slug, isActive: true, deletedAt: null, tenantId: { not: null } },
    select: { id: true, name: true, slug: true, tenantId: true },
  }).catch(() => null)
  return c ? { id: c.id, name: c.name, slug: c.slug, tenantId: c.tenantId! } : null
}

/**
 * Every brand, of every company, that takes WhatsApp orders right now: the
 * storefront's rules (LIVE_BRAND — isActive, not deleted, storefrontVisible,
 * in a company — and open by its opening hours in PKT, orderingState, the
 * same check checkout runs), plus: a customer can actually REACH a dish — a
 * priced, available item in a section that is switched on and showing at
 * this time of day (sendToMenu only offers such sections, and items are only
 * reached through one). A brand whose dishes all sit in a switched-off or
 * out-of-hours section is not taking orders. WHATSAPP_DEFAULT_CONCEPT, when
 * it is among them, comes first; the rest by name.
 */
export async function orderingBrands(now: Date = new Date()): Promise<OrderingBrand[]> {
  const rows = await prisma.concept.findMany({
    where: { ...LIVE_BRAND, menus: { some: { ...ORDERABLE_ITEM, category: LIVE_SECTION } } },
    select: { id: true, name: true, slug: true, tenantId: true },
    orderBy: { name: 'asc' },
  })
  const sections = rows.length === 0 ? [] : await prisma.category.findMany({
    where: { conceptId: { in: rows.map((c) => c.id) }, ...LIVE_SECTION, items: { some: ORDERABLE_ITEM } },
    select: { conceptId: true, timeRestrictionStart: true, timeRestrictionEnd: true },
  })
  const reachable = new Set(sections
    .filter((c) => sectionVisibleAt(c.timeRestrictionStart, c.timeRestrictionEnd, now))
    .map((c) => c.conceptId))
  const candidates = rows.filter((c) => reachable.has(c.id))
  const open = await Promise.all(candidates.map(async (c) => ((await orderingState(c, now)).open ? c : null)))
  const brands = open.filter((c): c is NonNullable<typeof c> => c !== null)
    .map((c) => ({ id: c.id, name: c.name, slug: c.slug, tenantId: c.tenantId! }))
  const defaultSlug = process.env['WHATSAPP_DEFAULT_CONCEPT']?.trim()
  if (defaultSlug) {
    const i = brands.findIndex((b) => b.slug === defaultSlug)
    if (i > 0) brands.unshift(...brands.splice(i, 1))
  }
  return brands
}

/** Why each candidate brand is closed ("Simmer is closed right now. Opens at 12:00 today."). */
async function closedMessages(now: Date): Promise<string[]> {
  const rows = await prisma.concept.findMany({
    where: LIVE_BRAND,
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: MAX_LIST_ROWS,
  })
  const states = await Promise.all(rows.map((c) => orderingState(c, now)))
  return states.filter((s) => !s.open && s.opensAt).map((s) => s.message!).filter(Boolean)
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const GREETING = /^(hi+|hello|hey+|start|order|salaam|salam|assalam\w*|aoa)\b/
const BRAND_KEYWORD = /^(menu|brands?|switch|change brand|kitchens?)\b/
const SWITCH_ANSWER = /^(yes|y|no|n|keep|switch)\b/

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')

/**
 * A TYPED reply to the last prompt's options. The production gateway is
 * text-only (lib/whatsapp.ts renders buttons as "1. Place order" and list rows
 * as "• Mains"), so nothing ever comes back as a tap: "1", "1.", "Place order",
 * "• Mains" or a copied "2. Keep my cart" must all pick their option. A number
 * picks by position; a title matches case- and punctuation-insensitively; with
 * `prefix`, an unambiguous start of a title (4+ letters, "confirm") matches too.
 */
export function matchOption(options: WaOption[], typed: string, prefix = true): WaOption | null {
  if (options.length === 0) return null
  const t = typed.trim()
  const num = /^(\d{1,2})[.)]?$/.exec(t)
  if (num) return options[Number(num[1]) - 1] ?? null
  // A copied line: "2. Keep my cart", "• Rice bowl — PKR 500" (the renderer's
  // numbering and " — description" are not part of the title).
  const n = norm(t.replace(/^\d{1,2}[.)]\s+/, '').split(' — ')[0]!)
  if (!n) return null
  const exact = options.find((o) => norm(o.title) === n)
  if (exact) return exact
  if (prefix && n.length >= 4) {
    const starts = options.filter((o) => norm(o.title).startsWith(n))
    if (starts.length === 1) return starts[0]!
  }
  return null
}

/** The tap a typed option stands for — handlers read only the tap. */
function asTap(phone: string, opt: WaOption): WaIncomingMessage {
  const reply = { id: opt.id, title: opt.title }
  return opt.id.startsWith('action:')
    ? { from: phone, type: 'interactive', interactive: { type: 'button_reply', button_reply: reply }, button_reply: reply }
    : { from: phone, type: 'interactive', interactive: { type: 'list_reply', list_reply: reply }, list_reply: reply }
}

/** Does the brand still take orders (LIVE_BRAND; hours are placeOrder's)? */
async function brandIsLive(conceptId: string): Promise<boolean> {
  return !!(await prisma.concept.findFirst({ where: { id: conceptId, ...LIVE_BRAND }, select: { id: true } }))
}

/**
 * The session's brand was switched off, hidden or deleted mid-conversation:
 * say so, drop the brand and its cart (a cart is one brand's), back to the
 * brand menu step. The caller decides what to send next.
 */
async function dropClosedBrand(phone: string, session: WaSession): Promise<void> {
  const c = await prisma.concept.findUnique({ where: { id: session.conceptId! }, select: { name: true } })
  const hadCart = session.cart.length > 0
  session.conceptId = null
  session.conceptSlug = null
  session.tenantId = null
  session.cart = []
  session.pendingConceptId = null
  session.brandOptions = []
  session.lastOptions = []
  session.step = 'brand'
  delete session.selectedCategoryId
  delete session.orderKey
  await saveSession(session)
  const name = c ? formatBrandName(c.name) : 'That kitchen'
  await sendText(phone, `${name} is not taking orders right now.${hadCart ? ' Your cart from it has been emptied.' : ''}`)
}

export async function handleWaMessage(phone: string, incoming: WaIncomingMessage) {
  let session = await getSession(phone)
  let message = incoming

  // Keywords only from what the customer TYPED — a tapped row's title (a
  // category called "Hello Bowls") is not a greeting.
  let typed = (message.text?.body ?? '').trim().toLowerCase()
  // A typed answer to the last prompt is that option's tap. An exact title or
  // number beats a keyword ("Hello Bowls" typed in full is the category); a
  // partial title never overrides a greeting or keyword.
  if (session && typed && !message.button_reply && !message.list_reply) {
    const isKeyword = GREETING.test(typed) || BRAND_KEYWORD.test(typed)
    const opt = matchOption(session.lastOptions ?? [], typed, !isKeyword)
    if (opt) {
      message = asTap(phone, opt)
      typed = ''
    }
  }
  const isGreeting = typed !== '' && GREETING.test(typed)
  const isBrandKeyword = typed !== '' && BRAND_KEYWORD.test(typed)
  const btnId = message.button_reply?.id ?? ''
  const listId = message.list_reply?.id ?? ''

  if (session) {
    // A session saved before the brand menu has a brand but no company.
    if (session.conceptId && !session.tenantId) {
      const c = await prisma.concept.findUnique({ where: { id: session.conceptId }, select: { tenantId: true, slug: true } })
      session.tenantId = c?.tenantId ?? null
      session.conceptSlug = session.conceptSlug ?? c?.slug ?? null
    }
    // The brand must STILL take orders at every step — a session lives as
    // long as the customer keeps replying, and a brand switched off, hidden
    // or deleted since it was picked (or a pre-brand-menu session's default
    // brand) never takes another order from it.
    if (session.conceptId && !(await brandIsLive(session.conceptId))) {
      await dropClosedBrand(phone, session)
      if (!isGreeting && !listId.startsWith('brand:')) return sendBrandMenu(phone, session)
    }
  }

  if (!session || isGreeting) {
    return startConversation(phone, session)
  }

  // The "switch kitchens and empty the cart?" answer comes first — "switch"
  // there is a yes, not a request for the brand menu.
  if (session.step === 'switch' && (btnId.startsWith('action:switch-') || SWITCH_ANSWER.test(typed))) {
    return handleSwitch(phone, session, message)
  }

  if (isBrandKeyword || btnId === 'action:brands') {
    return sendBrandMenu(phone, session)
  }

  // A brand row tapped — from the current menu or an older one further up the chat.
  if (listId.startsWith('brand:')) {
    return pickBrand(phone, session, listId.slice('brand:'.length))
  }

  // Member shortcut: "Reorder last" button from the welcome message
  if (btnId === 'action:reorder-last') {
    return handleReorderLast(phone, session)
  }

  if (session.step === 'switch') return handleSwitch(phone, session, message)
  if (session.step === 'brand' || session.step === 'idle' || !session.conceptId) {
    if (session.step === 'idle' && session.conceptId) return handleBrowsing(phone, session, message)
    return handleBrandReply(phone, session, message)
  }

  switch (session.step) {
    case 'browsing':
      return handleBrowsing(phone, session, message)
    case 'category':
      return handleCategory(phone, session, message)
    case 'cart':
      return handleCart(phone, session, message)
    case 'confirm':
      return handleConfirm(phone, session, message)
    default:
      await clearSession(phone)
      return sendText(phone, 'Your session has ended. Send "hi" to start a new order.', replyScope(session))
  }
}

/** Send buttons and remember them, so a typed "1" or "Place order" picks one. */
async function offerButtons(phone: string, session: WaSession, body: string, buttons: WaOption[]): Promise<unknown> {
  session.lastOptions = buttons.map((b) => ({ id: b.id, title: b.title }))
  await saveSession(session)
  return sendButtons(phone, body, buttons.map((b) => ({ id: b.id, title: clip(b.title, 20) })), replyScope(session))
}

/** Send a one-section list and remember its rows (a typed number or title picks one). */
async function offerList(
  phone: string,
  session: WaSession,
  list: { header: string; body: string; button: string; section: string },
  rows: Array<WaOption & { description?: string }>,
): Promise<unknown> {
  session.lastOptions = rows.map((r) => ({ id: r.id, title: r.title }))
  await saveSession(session)
  return sendInteractiveList(phone, list.header, list.body, list.button, [{
    title: list.section,
    rows: rows.map((r) => ({ id: r.id, title: clip(r.title, 24), description: r.description ?? '' })),
  }], replyScope(session))
}

/**
 * A new conversation (or a greeting). A cart in progress is kept — the brand
 * menu says so, and picking another brand asks before emptying it.
 */
async function startConversation(phone: string, prev: WaSession | null) {
  const session = prev && prev.cart.length > 0 && prev.conceptId ? prev : newSession(phone)

  // Member detection — match by phone (E.164 digits, leading-zero-tolerant).
  const member = await findCustomerByPhone(phone).catch(() => null)
  if (member) {
    session.customerId = member.id
    session.customerName = member.name
  }

  let brands: OrderingBrand[]
  try {
    brands = await orderingBrands()
  } catch (err) {
    console.error('[whatsapp] brand list unavailable:', (err as Error).message)
    return fallbackToDefault(phone, session)
  }

  if (member && session.cart.length === 0) {
    const firstName = member.name.trim().split(/\s+/)[0] || member.name
    const greeted = await greetReturningMember(phone, session, member.id, firstName, brands)
    if (greeted) return
    await saveSession(session)
    await sendText(phone, `Welcome back, ${firstName}.`)
    return sendBrandMenu(phone, session, brands)
  }

  await saveSession(session)
  await sendText(phone, member
    ? `Welcome back, ${member.name.trim().split(/\s+/)[0] || member.name}.`
    : 'Welcome to servd. You can order pickup from our kitchens here.')
  return sendBrandMenu(phone, session, brands)
}

/** The brand list could not be read: use WHATSAPP_DEFAULT_CONCEPT if it names a live brand. */
async function fallbackToDefault(phone: string, session: WaSession): Promise<unknown> {
  const fallback = await defaultConcept()
  if (!fallback) {
    await saveSession(session)
    return sendText(phone, 'Sorry, we cannot take orders just now. Please try again in a few minutes.')
  }
  return chooseBrand(phone, session, fallback)
}

// ─── Brand menu ──────────────────────────────────────────────────────────────

/**
 * The brand menu. One brand open → straight to it (no menu); none → closed.
 * The listed order is kept in the session so a typed "2" picks the second.
 */
async function sendBrandMenu(phone: string, session: WaSession, known?: OrderingBrand[]): Promise<unknown> {
  let brands: OrderingBrand[]
  try {
    brands = known ?? await orderingBrands()
  } catch (err) {
    console.error('[whatsapp] brand list unavailable:', (err as Error).message)
    return fallbackToDefault(phone, session)
  }

  if (brands.length === 0) {
    session.step = session.cart.length > 0 ? 'cart' : 'idle'
    session.brandOptions = []
    session.lastOptions = []
    await saveSession(session)
    const why = await closedMessages(new Date()).catch(() => [])
    return sendText(phone, ['Ordering is closed right now.', ...why].join('\n\n'))
  }
  if (brands.length === 1) {
    return chooseBrand(phone, session, brands[0]!)
  }

  const listed = brands.slice(0, MAX_LIST_ROWS)
  session.step = 'brand'
  session.brandOptions = listed.map((b) => b.id)

  const current = session.conceptId ? brands.find((b) => b.id === session.conceptId) : undefined
  const cartNote = session.cart.length > 0 && current
    ? `\n\nYour cart from ${formatBrandName(current.name)} stays if you pick ${formatBrandName(current.name)}.`
    : ''
  return offerList(
    phone,
    session,
    {
      header: 'Order from',
      body: `Which kitchen would you like to order from? Reply with its name or number.${cartNote}`,
      button: 'Choose kitchen',
      section: 'Open now',
    },
    listed.map((b) => ({ id: `brand:${b.id}`, title: formatBrandName(b.name) })),
  )
}

/** A reply while the brand menu is showing: a typed number or name, else the menu again. */
async function handleBrandReply(phone: string, session: WaSession, message: WaIncomingMessage) {
  const typed = (message.text?.body ?? '').trim().toLowerCase()
  if (typed) {
    const brands = await orderingBrands()
    const n = /^\d{1,2}$/.test(typed) ? Number(typed) : NaN
    let match: OrderingBrand | undefined
    if (Number.isInteger(n) && n >= 1) {
      const order = session.brandOptions?.length ? session.brandOptions : brands.map((b) => b.id)
      const id = order[n - 1]
      match = id ? brands.find((b) => b.id === id) : undefined
    } else {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
      const t = norm(typed)
      match = t ? brands.find((b) => norm(formatBrandName(b.name)) === t || norm(b.name) === t || norm(b.slug) === t) : undefined
    }
    if (match) return chooseBrand(phone, session, match)
    return sendBrandMenu(phone, session, brands)
  }
  // Anything else (an unknown row, a stray button) → the menu again.
  return sendBrandMenu(phone, session)
}

/** A brand picked by id: only one that takes orders right now. */
async function pickBrand(phone: string, session: WaSession, conceptId: string) {
  const brands = await orderingBrands()
  const brand = brands.find((b) => b.id === conceptId)
  if (!brand) {
    const known = await prisma.concept.findFirst({
      where: { id: conceptId, isActive: true, deletedAt: null, storefrontVisible: true },
      select: { name: true },
    }).catch(() => null)
    if (known) await sendText(phone, `${formatBrandName(known.name)} is not taking orders right now.`)
    return sendBrandMenu(phone, session, brands)
  }
  return chooseBrand(phone, session, brand)
}

function setBrand(session: WaSession, brand: OrderingBrand) {
  if (session.conceptId !== brand.id) {
    session.cart = []
    delete session.selectedCategoryId
    delete session.orderKey
  }
  session.conceptId = brand.id
  session.conceptSlug = brand.slug
  session.tenantId = brand.tenantId
  session.pendingConceptId = null
  session.brandOptions = []
  session.lastOptions = []
}

/**
 * Go to a brand. Holding a cart from ANOTHER brand → ask first (a cart never
 * mixes brands). The same brand → carry on with the cart.
 */
async function chooseBrand(phone: string, session: WaSession, brand: OrderingBrand): Promise<unknown> {
  const name = formatBrandName(brand.name)
  if (session.cart.length > 0 && session.conceptId && session.conceptId !== brand.id) {
    const from = await prisma.concept.findUnique({ where: { id: session.conceptId }, select: { name: true } })
    session.pendingConceptId = brand.id
    session.step = 'switch'
    const count = session.cart.reduce((s, i) => s + i.quantity, 0)
    return offerButtons(
      phone,
      session,
      `Your cart has ${count} item(s) from ${formatBrandName(from?.name ?? 'another kitchen')}. A cart holds one kitchen's food, so switching to ${name} empties it.`,
      [
        { id: 'action:switch-yes', title: `Switch to ${name}` },
        { id: 'action:switch-no', title: 'Keep my cart' },
      ],
    )
  }

  const sameBrand = session.conceptId === brand.id
  setBrand(session, brand)
  if (sameBrand && session.cart.length > 0) {
    await saveSession(session)
    return handleCartText(phone, session)
  }
  await sendText(phone, `You are ordering from *${name}*.${await loyaltyLine(session)}`, replyScope(session))
  return sendToMenu(phone, session)
}

/** "Switch brand and empty the cart?" */
async function handleSwitch(phone: string, session: WaSession, message: WaIncomingMessage) {
  const btnId = message.button_reply?.id ?? ''
  const typed = (message.text?.body ?? '').trim().toLowerCase()
  const yes = btnId === 'action:switch-yes' || /^(yes|y|switch)\b/.test(typed)
  const no = btnId === 'action:switch-no' || /^(no|n|keep)\b/.test(typed)

  if (yes && session.pendingConceptId) {
    const brand = (await orderingBrands()).find((b) => b.id === session.pendingConceptId)
    if (!brand) {
      session.pendingConceptId = null
      session.step = 'cart'
      await saveSession(session)
      await sendText(phone, 'That kitchen is not taking orders right now. Your cart is unchanged.', replyScope(session))
      return handleCartText(phone, session)
    }
    session.cart = []
    return chooseBrand(phone, session, brand)
  }
  if (no || !session.pendingConceptId) {
    session.pendingConceptId = null
    session.step = 'cart'
    await saveSession(session)
    return handleCartText(phone, session)
  }
  const pending = await prisma.concept.findUnique({ where: { id: session.pendingConceptId }, select: { name: true } })
  return offerButtons(phone, session, 'Switch kitchens and empty your cart?', [
    { id: 'action:switch-yes', title: `Switch to ${formatBrandName(pending?.name ?? '')}` },
    { id: 'action:switch-no', title: 'Keep my cart' },
  ])
}

/** The member's points at the chosen brand's company (points are per company). */
async function loyaltyLine(session: WaSession): Promise<string> {
  if (!session.customerId || !session.tenantId) return ''
  const acct = await prisma.loyaltyAccount.findUnique({
    where: { tenantId_customerId: { tenantId: session.tenantId, customerId: session.customerId } },
    select: { pointsBalance: true },
  }).catch(() => null)
  return acct?.pointsBalance ? `\nYou have *${acct.pointsBalance} loyalty points* here.` : ''
}

// ─── Returning members ───────────────────────────────────────────────────────

/** The member's most recent order at any brand (not cancelled, not deleted). */
function lastOrderOf(customerId: string) {
  return prisma.order.findFirst({
    where: { customerId, status: { not: 'cancelled' }, deletedAt: null },
    orderBy: { placedAt: 'desc' },
    include: {
      items: { select: { menuItemId: true, name: true, quantity: true } },
      concept: { select: { id: true, name: true } },
    },
  })
}

/**
 * Member welcome with a one-tap reorder, when the brand of their last order
 * still takes orders: the session goes to that brand and the brand menu is
 * skipped. Returns false (nothing sent) otherwise — the caller shows the menu.
 */
async function greetReturningMember(
  phone: string,
  session: WaSession,
  customerId: string,
  firstName: string,
  brands: OrderingBrand[],
): Promise<boolean> {
  const lastOrder = await lastOrderOf(customerId).catch(() => null)
  if (!lastOrder || lastOrder.items.length === 0) return false
  const brand = brands.find((b) => b.id === lastOrder.conceptId)
  if (!brand) return false

  setBrand(session, brand)
  session.step = 'browsing'

  const itemSummary = lastOrder.items.slice(0, 3).map((i) => `${i.quantity}× ${i.name}`).join(', ')
  const moreSuffix = lastOrder.items.length > 3 ? `, +${lastOrder.items.length - 3} more` : ''
  const buttons = [
    { id: 'action:reorder-last', title: 'Reorder last' },
    { id: 'action:browse', title: 'See the menu' },
  ]
  if (brands.length > 1) buttons.push({ id: 'action:brands', title: 'Other kitchens' })

  await offerButtons(
    phone,
    session,
    `Welcome back, *${firstName}*.${await loyaltyLine(session)}\n\n*Last time at ${formatBrandName(brand.name)}:*\n${itemSummary}${moreSuffix}\n\nOrder the same again, or browse the menu?`,
    buttons,
  )
  return true
}

/**
 * One-tap reorder: at the brand of the member's LAST order — when it still
 * takes orders (else the brand menu). Clones that order's items into the cart
 * (skipping any deleted or unavailable since, and anything not that brand's),
 * at today's prices, then jumps to the confirm step.
 */
async function handleReorderLast(phone: string, session: WaSession) {
  if (!session.customerId) {
    await sendText(phone, 'Sorry, I lost track of your account. Send "hi" to start over.', replyScope(session))
    return clearSession(phone)
  }

  const lastOrder = await lastOrderOf(session.customerId)
  if (!lastOrder || lastOrder.items.length === 0) {
    await sendText(phone, 'There is no previous order to repeat. Here are the kitchens taking orders.', replyScope(session))
    return sendBrandMenu(phone, session)
  }

  const brands = await orderingBrands()
  const brand = brands.find((b) => b.id === lastOrder.conceptId)
  if (!brand) {
    await sendText(phone, `${formatBrandName(lastOrder.concept.name)} is not taking orders right now.`, replyScope(session))
    return sendBrandMenu(phone, session, brands)
  }
  if (session.cart.length > 0) {
    // Never replace a cart in progress behind the customer's back.
    await sendText(phone, 'You already have items in your cart. Place or cancel that order first.', replyScope(session))
    return handleCartText(phone, session)
  }

  setBrand(session, brand)

  // Items that still exist, are available, and are THIS brand's.
  const eligibleIds = lastOrder.items.map((i) => i.menuItemId).filter((id): id is string => !!id)
  const availableMenu = await prisma.menuItem.findMany({
    where: { id: { in: eligibleIds }, conceptId: brand.id, isAvailable: true, deletedAt: null, priceCents: { gt: 0 } },
    select: { id: true, priceCents: true, name: true },
  })
  const priceById = new Map(availableMenu.map((m) => [m.id, m]))

  session.cart = lastOrder.items
    .filter((i) => i.menuItemId && priceById.has(i.menuItemId))
    .map((i) => {
      const fresh = priceById.get(i.menuItemId!)!
      // Use *current* price, not the historical one.
      return { menuItemId: fresh.id, name: fresh.name, priceCents: fresh.priceCents, quantity: i.quantity }
    })

  if (session.cart.length === 0) {
    await saveSession(session)
    await sendText(phone, 'Nothing from your last order is available right now. Here is the menu.', replyScope(session))
    return sendToMenu(phone, session)
  }

  await saveSession(session)
  return proceedToConfirm(phone, session)
}

// ─── Menu, cart, confirm (the chosen brand) ──────────────────────────────────

async function sendToMenu(phone: string, session: WaSession): Promise<unknown> {
  if (!session.conceptId) return sendBrandMenu(phone, session)
  const now = new Date()
  // The storefront's sections: active, showing at this time of day in PKT,
  // and holding something to order (an empty section leads nowhere).
  const categories = (await prisma.category.findMany({
    where: { conceptId: session.conceptId, ...LIVE_SECTION, items: { some: { ...ORDERABLE_ITEM, conceptId: session.conceptId } } },
    orderBy: { sortOrder: 'asc' },
  })).filter((c) => sectionVisibleAt(c.timeRestrictionStart, c.timeRestrictionEnd, now)).slice(0, MAX_LIST_ROWS)

  session.step = 'browsing'

  if (categories.length === 0) {
    session.lastOptions = []
    await saveSession(session)
    return sendText(phone, 'The menu is unavailable right now. Please try again later, or send "brands" to pick another kitchen.', replyScope(session))
  }

  return offerList(
    phone,
    session,
    { header: 'Menu', body: 'Choose a category: reply with its name or number.', button: 'Browse menu', section: 'Categories' },
    categories.map((c) => ({ id: `cat:${c.id}`, title: c.name })),
  )
}

async function handleBrowsing(phone: string, session: WaSession, message: WaIncomingMessage) {
  // Member welcome buttons land here on first tap. "See the menu" → categories.
  if (message.button_reply?.id === 'action:browse') {
    return sendToMenu(phone, session)
  }

  const listReplyId = message.list_reply?.id ?? ''

  if (listReplyId.startsWith('cat:')) {
    const categoryId = listReplyId.replace('cat:', '')
    // Only the session brand's items, in a section still switched on and
    // showing now — a row from another brand's menu, or from an older list
    // whose section has closed since, is not this cart's.
    const section = await prisma.category.findFirst({
      where: { id: categoryId, conceptId: session.conceptId!, ...LIVE_SECTION },
      select: { timeRestrictionStart: true, timeRestrictionEnd: true },
    })
    const items = section && sectionVisibleAt(section.timeRestrictionStart, section.timeRestrictionEnd, new Date())
      ? await prisma.menuItem.findMany({
        where: { categoryId, conceptId: session.conceptId!, ...ORDERABLE_ITEM },
        orderBy: { displayOrder: 'asc' },
        take: MAX_LIST_ROWS,
      })
      : []

    if (items.length === 0) {
      return sendText(phone, 'No items are available in that category right now.', replyScope(session))
    }

    session.step = 'category'
    session.selectedCategoryId = categoryId

    return offerList(
      phone,
      session,
      { header: 'Choose an item', body: 'Reply with an item\'s name or number to add it to your cart.', button: 'Add to cart', section: 'Items' },
      items.map((i) => ({ id: `item:${i.id}`, title: i.name, description: fmtPkr(i.priceCents) })),
    )
  }

  // Text: check if they typed an item or command
  return handleCartText(phone, session)
}

async function handleCategory(phone: string, session: WaSession, message: WaIncomingMessage) {
  const listReplyId = message.list_reply?.id ?? ''

  if (listReplyId.startsWith('item:')) {
    const menuItemId = listReplyId.replace('item:', '')
    const item = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
      include: { category: { select: { isActive: true, deletedAt: true } } },
    })
    // A cart never mixes brands: an item of another brand is "unavailable"
    // here, as is one whose section has been switched off since it was listed.
    if (!item || !item.isAvailable || item.deletedAt || item.conceptId !== session.conceptId || item.priceCents <= 0
      || !item.category?.isActive || item.category.deletedAt) {
      return sendText(phone, 'Sorry, that item is not available right now.', replyScope(session))
    }

    // Add or increment in cart
    const existing = session.cart.find((c) => c.menuItemId === menuItemId)
    if (existing) {
      existing.quantity += 1
    } else {
      session.cart.push({ menuItemId, name: item.name, priceCents: item.priceCents, quantity: 1 })
    }

    session.step = 'cart'

    const cartTotal = session.cart.reduce((s, i) => s + i.priceCents * i.quantity, 0)
    const cartSummary = session.cart.map((i) => `• ${i.quantity}× ${i.name} – ${fmtPkr(i.priceCents * i.quantity)}`).join('\n')

    return offerButtons(
      phone,
      session,
      `Added *${item.name}*.\n\n*Your cart:*\n${cartSummary}\n\n*Total: ${fmtPkr(cartTotal)}*`,
      [
        { id: 'action:more', title: 'Add more' },
        { id: 'action:confirm', title: 'Confirm order' },
      ],
    )
  }

  return handleCartText(phone, session)
}

async function handleCart(phone: string, session: WaSession, message: WaIncomingMessage) {
  const btnId = message.button_reply?.id ?? ''

  if (btnId === 'action:more') {
    return sendToMenu(phone, session)
  }

  if (btnId === 'action:confirm') {
    return proceedToConfirm(phone, session)
  }

  return handleCartText(phone, session)
}

/**
 * The cart priced the way every channel is priced (lib/pricing priceOrder):
 * today's menu prices for THIS brand (the session's stored prices may be
 * stale), the brand's own GST rate for the tender — the order is paid on
 * collection, so the cash rate (decision 9: cash 15% / card 8%; never
 * concept.taxRate) — and the brand's company's service charge for the
 * WhatsApp channel. Items gone or 86'd since they were added are dropped
 * (named in `dropped`).
 */
async function priceCart(session: WaSession) {
  if (!session.conceptId) throw new Error('No brand chosen')
  const concept = await prisma.concept.findUnique({
    where: { id: session.conceptId },
    select: { id: true, name: true, tenantId: true, taxRateCash: true, taxRateCard: true },
  })
  if (!concept) throw new Error(`Concept '${session.conceptId}' not found`)
  const ids = [...new Set(session.cart.map((i) => i.menuItemId))]
  const menu = new Map((await prisma.menuItem.findMany({
    where: { id: { in: ids }, conceptId: session.conceptId, isAvailable: true, deletedAt: null, priceCents: { gt: 0 } },
    select: { id: true, name: true, priceCents: true },
  })).map((m) => [m.id, m]))
  const lines: CartItem[] = []
  const dropped: string[] = []
  for (const i of session.cart) {
    const m = menu.get(i.menuItemId)
    if (!m) { dropped.push(i.name); continue }
    lines.push({ menuItemId: m.id, name: m.name, priceCents: m.priceCents, quantity: i.quantity })
  }
  const price = await priceOrder(
    lines.map((l) => ({ menuItemId: l.menuItemId, unitPriceCents: l.priceCents, quantity: l.quantity })),
    'cash', 'whatsapp', concept,
  )
  return { concept, lines, price, dropped }
}

async function proceedToConfirm(phone: string, session: WaSession) {
  if (!session.conceptId) return sendBrandMenu(phone, session)
  const { concept, lines, price, dropped } = await priceCart(session)
  session.cart = lines
  if (lines.length === 0) {
    await saveSession(session)
    await sendText(phone, 'Sorry, nothing in your cart is available right now. Here is the menu.', replyScope(session))
    return sendToMenu(phone, session)
  }

  session.step = 'confirm'
  // The session's idempotency key for the order it is about to place — minted
  // when the summary is shown, so a double-tapped "Place order" (or Meta
  // re-delivering the webhook) gets the SAME order back from ingestOrder, never
  // a second ticket. A new summary (cart changed, reorder) mints a new key.
  session.orderKey = randomUUID()

  const itemList = lines.map((i) => `• ${i.quantity}× ${i.name}`).join('\n')
  const droppedNote = dropped.length > 0 ? `\n\n_No longer available, removed: ${dropped.join(', ')}_` : ''
  const serviceLine = price.serviceChargeCents > 0 ? `\nService charge: ${fmtPkr(price.serviceChargeCents)}` : ''

  return offerButtons(
    phone,
    session,
    `*Order summary — ${formatBrandName(concept.name)}*\n\n${itemList}${droppedNote}\n\nSubtotal: ${fmtPkr(price.itemTotalCents)}\nGST ${price.taxRatePct}%: ${fmtPkr(price.taxCents)}${serviceLine}\n*Total: ${fmtPkr(price.totalCents)}*\n\n_Pickup order. Pay on collection._`,
    [
      { id: 'action:place', title: 'Place order' },
      { id: 'action:cancel', title: 'Cancel' },
    ],
  )
}

async function handleConfirm(phone: string, session: WaSession, message: WaIncomingMessage) {
  const btnId = message.button_reply?.id ?? ''

  if (btnId === 'action:place') {
    await placeOrder(phone, session)
    return
  }

  if (btnId === 'action:cancel') {
    await clearSession(phone)
    return sendText(phone, 'Order cancelled. Send "hi" to start again.', replyScope(session))
  }

  return sendText(phone, 'Reply *Place order* to confirm or *Cancel* to start over.', replyScope(session))
}

/** Refusals whose message is written for the customer. */
const CUSTOMER_FACING = new Set(['BRAND_CLOSED', 'ITEM_UNAVAILABLE', 'BANNED', 'ITEM_NOT_PRICED'])

/**
 * Place the WhatsApp order at the session's brand. Source 'servd' (the
 * customer channel) with raw_payload.channel = 'whatsapp' saying where it
 * came from. Priced like every channel: the order carries its GST and rate,
 * and the pending payment is the full bill. Checked first, as checkout does:
 * the brand is still live (active, not deleted, on the storefront, in a
 * company) and open now (a session lives as long as the customer replies), every item
 * is served at this time of day, and the brand's company has no ban on this
 * customer or phone.
 */
export async function placeOrder(phone: string, session: WaSession) {
  if (!session.conceptId) {
    await sendText(phone, 'Please pick a kitchen first.', replyScope(session))
    return sendBrandMenu(phone, session)
  }
  const { concept, lines, price } = await priceCart(session)
  if (lines.length === 0) {
    await sendText(phone, 'Sorry, nothing in your cart is available right now. Send "hi" to start again.', replyScope(session))
    return clearSession(phone)
  }
  const key = session.orderKey ?? randomUUID()

  const dto: OrderDTO = {
    source: 'servd',
    external_id: `whatsapp-${key}`,
    concept_id: session.conceptId,
    placed_at: new Date().toISOString(),
    customer_id: session.customerId ?? null,
    customer_name: session.customerName ?? `WA ${phone.slice(-4)}`,
    items: lines.map((i) => ({
      externalItemId: i.menuItemId,
      menuItemId: i.menuItemId,
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.priceCents,
      modifiers: [],
    })),
    payment: { provider: 'cash', amountCents: price.totalCents, status: 'pending' },
    loyalty_points_earned: null,
    // Not a delivery: a note here would mint a rider hand-over code.
    delivery_notes: null,
    estimated_pickup: null,
    tax_cents: price.taxCents,
    fulfilment_type: 'takeout',
    raw_payload: { channel: 'whatsapp', phone, cart: lines },
  }

  let result: Awaited<ReturnType<typeof ingestOrder>>
  try {
    const existing = await prisma.order.findUnique({
      where: { source_externalId: { source: 'servd', externalId: dto.external_id } },
      select: { id: true },
    })
    // A re-delivered "Place order" for an order already taken skips the
    // checks (the brand may have closed since) — ingestOrder answers it.
    if (!existing) {
      const now = new Date()
      // The brand still takes orders (LIVE_BRAND, the brand menu's rule) — it
      // may have been switched off, hidden or deleted since it was picked.
      if (!(await brandIsLive(concept.id))) {
        throw new AppError('BRAND_CLOSED', `${formatBrandName(concept.name)} is not taking orders right now.`, 409)
      }
      const state = await orderingState(concept, now)
      if (!state.open) throw new AppError('BRAND_CLOSED', state.message ?? `${formatBrandName(concept.name)} is closed right now.`, 409)
      await assertItemsServedAt(concept.id, lines.map((l) => l.menuItemId), now)
      const customer = session.customerId
        ? await prisma.customer.findUnique({ where: { id: session.customerId }, select: { email: true } })
        : null
      await assertNotBannedAtCompany({
        customerId: session.customerId ?? null,
        email: customer?.email ?? null,
        phone,
        tenantId: concept.tenantId,
        intent: 'order',
      })
    }
    result = await ingestOrder(dto, { price })
  } catch (err) {
    // An item 86'd between the summary and the tap, the brand closed, … —
    // tell the customer rather than going silent. The session stays, so "hi"
    // starts again.
    console.error(`[whatsapp] order for ${phone.slice(-4)} not placed:`, (err as Error).message)
    const why = err instanceof AppError && CUSTOMER_FACING.has(err.code) ? `${err.message}\n\n` : ''
    await sendText(phone, `${why}Sorry, we could not place that order just now. Send "hi" to start again.`, replyScope(session))
    return
  }
  await clearSession(phone)

  const orderRef = result.order.id.slice(-8).toUpperCase()
  return sendText(
    phone,
    `*Order Placed* at ${formatBrandName(concept.name)}.\n\nReference: *${orderRef}*\n\nPlease come to the counter to collect it. Thank you.`, replyScope(session),
  )
}

async function handleCartText(phone: string, session: WaSession): Promise<unknown> {
  if (session.cart.length > 0) {
    session.step = 'cart'
    const cartTotal = session.cart.reduce((s, i) => s + i.priceCents * i.quantity, 0)
    return offerButtons(
      phone,
      session,
      `Your cart has ${session.cart.length} item(s) – ${fmtPkr(cartTotal)}.\n\nWhat would you like to do?`,
      [
        { id: 'action:more', title: 'Add more' },
        { id: 'action:confirm', title: 'Confirm order' },
      ],
    )
  }

  return sendToMenu(phone, session)
}

// Incoming message type (simplified Meta Cloud API format)
export interface WaIncomingMessage {
  from: string
  type: 'text' | 'interactive' | 'button'
  text?: { body: string }
  interactive?: { type: string; list_reply?: { id: string; title: string }; button_reply?: { id: string; title: string } }
  button_reply?: { id: string; title: string }
  list_reply?: { id: string; title: string }
}
