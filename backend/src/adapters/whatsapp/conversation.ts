// WhatsApp ordering conversation state machine
// Flow: idle → browsing → category → cart → confirm → done
//
// Member-aware: if the inbound phone matches a known Customer row, we greet
// them by name and surface a "Reorder last" shortcut. Anonymous numbers fall
// back to the original menu-browsing flow. Order placement always sets
// customerId when a member is detected, so loyalty points + history accrue
// correctly without requiring sign-in.

import { randomUUID } from 'node:crypto'
import type { OrderDTO } from '@servd/types'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { priceOrder } from '../../lib/pricing.js'
import { sendText, sendInteractiveList, sendButtons } from '../../lib/whatsapp.js'
import {
  getSession, saveSession, clearSession, newSession,
  type WaSession, type CartItem,
} from '../../lib/wa-session.js'
import { ingestOrder } from '../../modules/orders/service.js'
import { findCustomerByPhone } from '../../lib/customer-channels.js'
import { fmtPkr as fmtPkrShared } from '../../modules/accounting/csv.js'
import { formatBrandName } from '../../lib/brandName.js'

// The one PKR formatter (modules/accounting/csv.ts), in the bot's "PKR 1234" form.
const fmtPkr = (cents: number) => fmtPkrShared(cents, { symbol: true, decimals: 0, group: false })

async function getDefaultConcept() {
  const slug = process.env['WHATSAPP_DEFAULT_CONCEPT']
  if (!slug) throw new Error('WHATSAPP_DEFAULT_CONCEPT not set')
  const concept = await prisma.concept.findUnique({ where: { slug } })
  if (!concept) throw new Error(`Concept '${slug}' not found`)
  return concept
}

export async function handleWaMessage(phone: string, message: WaIncomingMessage) {
  let session = await getSession(phone)

  // Start fresh session if none exists or user sends a greeting
  const text = (message.text?.body ?? message.button_reply?.title ?? message.list_reply?.title ?? '').trim().toLowerCase()
  const isGreeting = /^(hi|hello|hey|start|order|menu|salaam|salam|assalam)/.test(text)
  const isReorderTap = (message.button_reply?.id ?? '') === 'action:reorder-last'

  if (!session || isGreeting) {
    const concept = await getDefaultConcept()
    session = newSession(phone, concept.id, concept.slug)

    // Member detection — match by phone (E.164 digits, leading-zero-tolerant).
    // We hit this once per session; subsequent messages reuse session.customerId.
    const member = await findCustomerByPhone(phone).catch(() => null)
    if (member) {
      session.customerId = member.id
      session.customerName = member.name
      await saveSession(session)
      return greetReturningMember(phone, session, member, formatBrandName(concept.name))
    }

    await saveSession(session)
    await sendText(phone, `👋 Welcome to *${formatBrandName(concept.name)}*!\n\nI can take your order via WhatsApp. Just type naturally or tap the buttons below.`)
    return sendToMenu(phone, session)
  }

  // Member shortcut: "Reorder last" button from the welcome message
  if (isReorderTap) {
    return handleReorderLast(phone, session)
  }

  switch (session.step) {
    case 'idle':
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
      return sendText(phone, 'Your session ended. Send "hi" to start a new order!')
  }
}

/**
 * Member-aware welcome. Shows their last order summary when available so they
 * can one-tap a reorder, plus loyalty balance to make the relationship feel
 * tangible. Falls through to the regular menu if they haven't ordered before
 * (rare — would mean they're a member who has never ordered).
 */
async function greetReturningMember(
  phone: string,
  session: WaSession,
  member: { id: string; name: string },
  conceptName: string,
) {
  // Fetch most recent completed order + loyalty balance in parallel
  const [lastOrder, loyalty] = await Promise.all([
    prisma.order.findFirst({
      where: { customerId: member.id, conceptId: session.conceptId, status: { not: 'cancelled' }, deletedAt: null },
      orderBy: { placedAt: 'desc' },
      include: { items: { select: { name: true, quantity: true } } },
    }),
    // Points are per company (ONL-04): the balance shown is the one the guest
    // can spend at THIS brand — its company's account.
    prisma.concept.findUnique({ where: { id: session.conceptId }, select: { tenantId: true } })
      .then((c) => c?.tenantId
        ? prisma.loyaltyAccount.findUnique({ where: { tenantId_customerId: { tenantId: c.tenantId, customerId: member.id } } })
        : null)
      .catch(() => null),
  ])

  const firstName = member.name.split(/\s+/)[0]
  const balanceLine = loyalty?.pointsBalance
    ? `\n⭐ *${loyalty.pointsBalance} loyalty points* on your account`
    : ''

  if (!lastOrder || lastOrder.items.length === 0) {
    await sendText(phone, `👋 Welcome back, ${firstName}!${balanceLine}\n\nReady to order from *${conceptName}*?`)
    return sendToMenu(phone, session)
  }

  const itemSummary = lastOrder.items.slice(0, 3).map((i) => `${i.quantity}× ${i.name}`).join(', ')
  const moreSuffix = lastOrder.items.length > 3 ? `, +${lastOrder.items.length - 3} more` : ''

  return sendButtons(
    phone,
    `👋 Welcome back, *${firstName}*!${balanceLine}\n\n*Last time you had:*\n${itemSummary}${moreSuffix}\n\nWant the same again, or browse the menu?`,
    [
      { id: 'action:reorder-last', title: '🔁 Reorder last' },
      { id: 'action:browse',       title: '📋 Browse menu' },
    ],
  )
}

/**
 * One-tap reorder: clones the last non-cancelled order's items into the cart
 * (skipping any items that have since been deleted or marked unavailable),
 * then jumps straight to the confirm step. Shaves ~5 taps off a typical reorder.
 */
async function handleReorderLast(phone: string, session: WaSession) {
  if (!session.customerId) {
    await sendText(phone, 'Hmm, I lost track of your account. Send "hi" to start over.')
    return clearSession(phone)
  }

  const lastOrder = await prisma.order.findFirst({
    where: { customerId: session.customerId, conceptId: session.conceptId, status: { not: 'cancelled' }, deletedAt: null },
    orderBy: { placedAt: 'desc' },
    include: { items: { select: { menuItemId: true, name: true, unitPriceCents: true, quantity: true } } },
  })

  if (!lastOrder || lastOrder.items.length === 0) {
    await sendText(phone, "Couldn't find a previous order — let me show you the menu instead.")
    return sendToMenu(phone, session)
  }

  // Filter out items that no longer exist or aren't currently available.
  // Skipping silently is friendlier than blocking — they can adjust at confirm.
  const eligibleIds = lastOrder.items.map((i) => i.menuItemId).filter((id): id is string => !!id)
  const availableMenu = await prisma.menuItem.findMany({
    where: { id: { in: eligibleIds }, isAvailable: true, deletedAt: null },
    select: { id: true, priceCents: true, name: true },
  })
  const priceById = new Map(availableMenu.map((m) => [m.id, m]))

  session.cart = lastOrder.items
    .filter((i) => i.menuItemId && priceById.has(i.menuItemId))
    .map((i) => {
      const fresh = priceById.get(i.menuItemId!)!
      // Use *current* price, not the historical one — pricing is the only
      // place where we'd silently overcharge, so being explicit matters.
      return { menuItemId: fresh.id, name: fresh.name, priceCents: fresh.priceCents, quantity: i.quantity }
    })

  if (session.cart.length === 0) {
    await sendText(phone, 'Looks like nothing from your last order is available right now. Let me show you the menu.')
    return sendToMenu(phone, session)
  }

  await saveSession(session)
  return proceedToConfirm(phone, session)
}

async function sendToMenu(phone: string, session: WaSession) {
  const categories = await prisma.category.findMany({
    where: { conceptId: session.conceptId, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
    take: 10,
  })

  session.step = 'browsing'
  await saveSession(session)

  if (categories.length === 0) {
    return sendText(phone, 'Menu is unavailable right now. Please try again later.')
  }

  return sendInteractiveList(
    phone,
    '📋 Our Menu',
    'Choose a category to browse items:',
    'Browse Menu',
    [{
      title: 'Categories',
      rows: categories.map((c) => ({ id: `cat:${c.id}`, title: c.name, description: '' })),
    }],
  )
}

async function handleBrowsing(phone: string, session: WaSession, message: WaIncomingMessage) {
  // Member welcome buttons land here on first tap (welcome → 'browsing' default
  // step). Map "Browse menu" tap to sending the category list.
  if (message.button_reply?.id === 'action:browse') {
    return sendToMenu(phone, session)
  }

  const listReplyId = message.list_reply?.id ?? ''

  if (listReplyId.startsWith('cat:')) {
    const categoryId = listReplyId.replace('cat:', '')
    const items = await prisma.menuItem.findMany({
      where: { categoryId, isAvailable: true, deletedAt: null },
      orderBy: { displayOrder: 'asc' },
      take: 10,
    })

    if (items.length === 0) {
      return sendText(phone, 'No items available in that category right now.')
    }

    session.step = 'category'
    session.selectedCategoryId = categoryId
    await saveSession(session)

    return sendInteractiveList(
      phone,
      '🍽️ Choose an Item',
      'Tap an item to add it to your cart:',
      'Add to Cart',
      [{
        title: 'Items',
        rows: items.map((i) => ({
          id: `item:${i.id}`,
          title: i.name,
          description: fmtPkr(i.priceCents),
        })),
      }],
    )
  }

  // Text: check if they typed an item or command
  return handleCartText(phone, session, message)
}

async function handleCategory(phone: string, session: WaSession, message: WaIncomingMessage) {
  const listReplyId = message.list_reply?.id ?? ''

  if (listReplyId.startsWith('item:')) {
    const menuItemId = listReplyId.replace('item:', '')
    const item = await prisma.menuItem.findUnique({ where: { id: menuItemId } })
    if (!item || !item.isAvailable) {
      return sendText(phone, 'Sorry, that item is currently unavailable.')
    }

    // Add or increment in cart
    const existing = session.cart.find((c) => c.menuItemId === menuItemId)
    if (existing) {
      existing.quantity += 1
    } else {
      session.cart.push({ menuItemId, name: item.name, priceCents: item.priceCents, quantity: 1 })
    }

    session.step = 'cart'
    await saveSession(session)

    const cartTotal = session.cart.reduce((s, i) => s + i.priceCents * i.quantity, 0)
    const cartSummary = session.cart.map((i) => `• ${i.quantity}× ${i.name} – ${fmtPkr(i.priceCents * i.quantity)}`).join('\n')

    return sendButtons(
      phone,
      `✅ *${item.name}* added!\n\n*Your cart:*\n${cartSummary}\n\n*Total: ${fmtPkr(cartTotal)}*`,
      [
        { id: 'action:more', title: '➕ Add More' },
        { id: 'action:confirm', title: '✅ Confirm Order' },
      ],
    )
  }

  return handleCartText(phone, session, message)
}

async function handleCart(phone: string, session: WaSession, message: WaIncomingMessage) {
  const btnId = message.button_reply?.id ?? ''

  if (btnId === 'action:more') {
    return sendToMenu(phone, session)
  }

  if (btnId === 'action:confirm') {
    return proceedToConfirm(phone, session)
  }

  return handleCartText(phone, session, message)
}

/**
 * The session's idempotency key for the order it is about to place — minted
 * when the summary is shown, so a double-tapped "Place Order" (or Meta
 * re-delivering the webhook) gets the SAME order back from ingestOrder, never
 * a second ticket. A new summary (cart changed, reorder) mints a new key.
 */
type WaSessionWithKey = WaSession & { orderKey?: string }

/**
 * The cart priced the way every channel is priced (lib/pricing priceOrder):
 * today's menu prices for THIS brand (the session's stored prices may be
 * stale), the brand's own GST rate for the tender — the order is paid on
 * collection, so the cash rate (decision 9: cash 15% / card 8%; it was a
 * hard-coded 17% here and never written to the order) — and the company's
 * service charge for the WhatsApp channel. Items gone or 86'd since they were
 * added are dropped (named in `dropped`).
 */
async function priceCart(session: WaSession) {
  const concept = await prisma.concept.findUnique({
    where: { id: session.conceptId },
    select: { id: true, tenantId: true, taxRateCash: true, taxRateCard: true },
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
  return { lines, price, dropped }
}

async function proceedToConfirm(phone: string, session: WaSession) {
  const { lines, price, dropped } = await priceCart(session)
  session.cart = lines
  if (lines.length === 0) {
    await saveSession(session)
    await sendText(phone, 'Sorry — nothing in your cart is available right now. Let me show you the menu.')
    return sendToMenu(phone, session)
  }

  session.step = 'confirm'
  ;(session as WaSessionWithKey).orderKey = randomUUID()
  await saveSession(session)

  const itemList = lines.map((i) => `• ${i.quantity}× ${i.name}`).join('\n')
  const droppedNote = dropped.length > 0 ? `\n\n_No longer available, removed: ${dropped.join(', ')}_` : ''
  const serviceLine = price.serviceChargeCents > 0 ? `\nService charge: ${fmtPkr(price.serviceChargeCents)}` : ''

  return sendButtons(
    phone,
    `🧾 *Order Summary*\n\n${itemList}${droppedNote}\n\nSubtotal: ${fmtPkr(price.itemTotalCents)}\nGST ${price.taxRatePct}%: ${fmtPkr(price.taxCents)}${serviceLine}\n*Total: ${fmtPkr(price.totalCents)}*\n\n_Pickup order. Pay on collection._`,
    [
      { id: 'action:place', title: '🛍️ Place Order' },
      { id: 'action:cancel', title: '❌ Cancel' },
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
    return sendText(phone, '❌ Order cancelled. Send "hi" to start again!')
  }

  return sendText(phone, 'Tap *Place Order* to confirm or *Cancel* to start over.')
}

/**
 * Place the WhatsApp order. Source 'servd' (the customer channel — the order
 * sources are servd / pos / cart / manual, and 'whatsapp' was never one, so
 * ingestOrder refused EVERY WhatsApp order with UNKNOWN_ORDER_SOURCE, hidden
 * behind an `as never` cast) with raw_payload.channel = 'whatsapp' saying
 * where it came from. Priced like every channel: the order carries its GST
 * and rate, and the pending payment is the full bill.
 */
export async function placeOrder(phone: string, session: WaSession) {
  const { lines, price } = await priceCart(session)
  if (lines.length === 0) {
    await sendText(phone, 'Sorry — nothing in your cart is available right now. Send "hi" to start again.')
    return clearSession(phone)
  }
  const key = (session as WaSessionWithKey).orderKey ?? randomUUID()

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
    result = await ingestOrder(dto, { price })
  } catch (err) {
    // An item 86'd between the summary and the tap, a brand mix-up, … — tell
    // the customer rather than going silent. The session stays, so "hi"
    // starts again.
    console.error(`[whatsapp] order for ${phone.slice(-4)} not placed:`, (err as Error).message)
    await sendText(phone, 'Sorry — we couldn\'t place that order just now. Send "hi" to start again.')
    return
  }
  await clearSession(phone)

  const orderRef = result.order.id.slice(-8).toUpperCase()
  return sendText(
    phone,
    `🎉 *Order Placed!*\n\nReference: *${orderRef}*\n\nPlease proceed to the counter for pickup. Thank you! 🙏`,
  )
}

async function handleCartText(phone: string, session: WaSession, _message: WaIncomingMessage) {
  if (session.cart.length > 0) {
    const cartTotal = session.cart.reduce((s, i) => s + i.priceCents * i.quantity, 0)
    return sendButtons(
      phone,
      `Your cart has ${session.cart.length} item(s) – ${fmtPkr(cartTotal)}.\n\nWhat would you like to do?`,
      [
        { id: 'action:more', title: '➕ Add More' },
        { id: 'action:confirm', title: '✅ Confirm Order' },
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
