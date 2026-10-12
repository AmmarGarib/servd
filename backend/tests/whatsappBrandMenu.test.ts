// WhatsApp brand menu — ONE shared GS Foods number takes orders for every
// brand of every company (owner decision, 2026-10-12). A conversation starts
// with the brands that take orders right now; the customer picks one and the
// order lands in that brand's company, priced by that brand's tender GST.
//
//   - the menu lists only brands taking orders (active, not deleted, shown on
//     the storefront, open by their hours, something to sell), across two
//     companies, names through formatBrandName
//   - exactly one brand → no menu, straight to it; none → "closed right now"
//   - picking company B's brand creates the order in company B at B's cash GST
//   - picking another brand while holding a cart asks first; "keep" keeps it
//   - "Reorder last" uses the brand of the member's last order
//   - WHATSAPP_DEFAULT_CONCEPT is optional (missing → no throw; set → first)
//   - an unknown list reply re-sends the menu
//   - a pre-brand-menu Redis session is migrated on read and still places
//   - WA-RV-1: a brand switched off / hidden / deleted mid-session takes no
//     order (placeOrder refuses; the next message drops the brand + cart)
//   - WA-RV-2: the production gateway is text-only, so a whole order can be
//     TYPED — brand, category, item, "Confirm order", "Place order", and the
//     numbered switch / greeting answers
//   - WA-RV-3: a brand whose dishes sit only in a switched-off or
//     out-of-hours section is not listed
//
// Requires a disposable database (DATABASE_URL must contain "test"). Every
// WhatsApp send is mocked — nothing reaches a gateway.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

type Sent =
  | { kind: 'text'; to: string; text: string }
  | { kind: 'buttons'; to: string; text: string; buttons: Array<{ id: string; title: string }> }
  | { kind: 'list'; to: string; header: string; text: string; rows: Array<{ id: string; title: string }> }
const sent: Sent[] = []
vi.mock('../src/lib/whatsapp.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/whatsapp.js')>()),
  sendText: async (to: string, text: string) => { sent.push({ kind: 'text', to, text }); return {} },
  sendButtons: async (to: string, text: string, buttons: Array<{ id: string; title: string }>) => {
    sent.push({ kind: 'buttons', to, text, buttons }); return {}
  },
  sendInteractiveList: async (to: string, header: string, text: string, _btn: string, sections: Array<{ rows: Array<{ id: string; title: string }> }>) => {
    sent.push({ kind: 'list', to, header, text, rows: sections.flatMap((s) => s.rows) }); return {}
  },
}))
vi.mock('../src/lib/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/notify.js')>()),
  sendPhoneMessage: async () => {},
  sendEmail: async () => {},
}))

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { redis } = await import('../src/lib/redis.js')
const { handleWaMessage, orderingBrands, placeOrder, matchOption } = await import('../src/adapters/whatsapp/conversation.js')
const { getSession, saveSession, newSession, clearSession, normaliseSession } = await import('../src/lib/wa-session.js')
type Msg = Parameters<typeof handleWaMessage>[1]

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string
// Open brands: A1 (company A, stored lowercase "simmer"), B1 (company B, cash GST 13%).
let a1: string, b1: string
let a1Slug: string, b1Slug: string
let a1Item: string, a1Cat: string, b1Item: string, b1Cat: string
// Never listed: hidden, inactive, deleted, closed by hours, nothing to sell, no company.
const notListed: string[] = []

let phoneSeq = 0
const newPhone = () => `92311${RUN.replace(/[^0-9]/g, '').padEnd(3, '7').slice(0, 3)}${String(1000 + ++phoneSeq).slice(-4)}`
const text = (phone: string, body: string) => handleWaMessage(phone, { from: phone, type: 'text', text: { body } })
const tapList = (phone: string, id: string, title = 'x') => handleWaMessage(phone, { from: phone, type: 'interactive', list_reply: { id, title } } as Msg)
const tapButton = (phone: string, id: string, title = 'x') => handleWaMessage(phone, { from: phone, type: 'interactive', button_reply: { id, title } } as Msg)
const lastOf = <K extends Sent['kind']>(kind: K) => [...sent].reverse().find((m) => m.kind === kind) as Extract<Sent, { kind: K }> | undefined
const brandMenu = () => [...sent].reverse().find((m) => m.kind === 'list' && m.rows.some((r) => r.id.startsWith('brand:'))) as Extract<Sent, { kind: 'list' }> | undefined

async function mkBrand(data: { name: string; tenantId: string | null; taxRateCash?: number; storefrontVisible?: boolean; isActive?: boolean; deletedAt?: Date | null; withItem?: boolean }) {
  const slug = `wa-${data.name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${RUN}`
  const c = await prisma.concept.create({
    data: {
      name: data.name, slug, type: 'restaurant', tenantId: data.tenantId,
      taxRateCash: data.taxRateCash ?? 15, taxRateCard: 8,
      storefrontVisible: data.storefrontVisible ?? true, isActive: data.isActive ?? true, deletedAt: data.deletedAt ?? null,
    },
  })
  let itemId = '', catId = ''
  if (data.withItem !== false) {
    catId = (await prisma.category.create({ data: { conceptId: c.id, name: 'Mains' } })).id
    itemId = (await prisma.menuItem.create({ data: { conceptId: c.id, categoryId: catId, name: `${data.name} plate`, priceCents: 100_000 } })).id
  }
  return { id: c.id, slug, itemId, catId }
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'WA A', slug: `wa-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'WA B', slug: `wa-b-${RUN}` } })).id

  const A1 = await mkBrand({ name: 'simmer', tenantId: tenantA })
  const B1 = await mkBrand({ name: 'Bravo Grill', tenantId: tenantB, taxRateCash: 13 })
  ;({ id: a1, slug: a1Slug, itemId: a1Item, catId: a1Cat } = A1)
  ;({ id: b1, slug: b1Slug, itemId: b1Item, catId: b1Cat } = B1)

  notListed.push((await mkBrand({ name: 'Hidden', tenantId: tenantA, storefrontVisible: false })).id)
  notListed.push((await mkBrand({ name: 'Inactive', tenantId: tenantB, isActive: false })).id)
  notListed.push((await mkBrand({ name: 'Deleted', tenantId: tenantA, deletedAt: new Date() })).id)
  notListed.push((await mkBrand({ name: 'Empty', tenantId: tenantB, withItem: false })).id)
  notListed.push((await mkBrand({ name: 'Orphan', tenantId: null })).id)
  // Closed by its hours: open only for an hour on a day three days from now (PKT).
  const closed = await mkBrand({ name: 'Closed', tenantId: tenantA })
  const pktDow = new Date(Date.now() + 5 * 3_600_000).getUTCDay()
  await prisma.serviceHours.create({ data: { conceptId: closed.id, dayOfWeek: (pktDow + 3) % 7, openMin: 600, closeMin: 660 } })
  notListed.push(closed.id)

  // WA-RV-3: an available, priced dish nobody can reach.
  //   Charlie — its only dish sits in a switched-off section (plus an empty live one).
  const charlie = await mkBrand({ name: 'Charlie', tenantId: tenantA })
  await prisma.category.update({ where: { id: charlie.catId }, data: { isActive: false } })
  await prisma.category.create({ data: { conceptId: charlie.id, name: 'Specials' } })
  notListed.push(charlie.id)
  //   Echo — its only section shows at another time of day (PKT).
  const echo = await mkBrand({ name: 'Echo', tenantId: tenantB })
  const pktMin = Math.floor((Date.now() + 5 * 3_600_000) / 60_000) % 1440
  const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  await prisma.category.update({ where: { id: echo.catId }, data: { timeRestrictionStart: hhmm(pktMin + 120), timeRestrictionEnd: hhmm(pktMin + 180) } })
  notListed.push(echo.id)

  delete process.env['WHATSAPP_DEFAULT_CONCEPT']
}, 60_000)

beforeEach(() => {
  sent.length = 0
  delete process.env['WHATSAPP_DEFAULT_CONCEPT']
})

afterAll(async () => {
  delete process.env['WHATSAPP_DEFAULT_CONCEPT']
})

describe('the brand menu', () => {
  it('lists only the brands taking orders right now, across both companies, with canonical names', async () => {
    const ids = (await orderingBrands()).map((b) => b.id)
    expect(new Set(ids)).toEqual(new Set([a1, b1]))

    const phone = newPhone()
    await text(phone, 'hi')
    const menu = brandMenu()
    expect(menu).toBeDefined()
    expect(new Set(menu!.rows.map((r) => r.id))).toEqual(new Set([`brand:${a1}`, `brand:${b1}`]))
    for (const id of notListed) expect(menu!.rows.some((r) => r.id === `brand:${id}`)).toBe(false)
    // formatBrandName: the row stored as "simmer" is shown as "Simmer".
    expect(menu!.rows.find((r) => r.id === `brand:${a1}`)!.title).toBe('Simmer')
    // Neutral voice: no exclamation marks, no emoji, in anything sent.
    for (const m of sent) expect(m.text).not.toMatch(/!|\p{Extended_Pictographic}/u)

    const s = (await getSession(phone))!
    expect(s.step).toBe('brand')
    expect(s.conceptId).toBeNull()
    await clearSession(phone)
  })

  it('a session (or a "menu" keyword) with exactly one brand open skips the menu and goes straight to it', async () => {
    await prisma.concept.update({ where: { id: b1 }, data: { storefrontVisible: false } })
    try {
      const phone = newPhone()
      await text(phone, 'hello')
      expect(brandMenu()).toBeUndefined()
      expect(sent.some((m) => m.kind === 'text' && m.text.includes('You are ordering from *Simmer*'))).toBe(true)
      const cats = lastOf('list')!
      expect(cats.rows.map((r) => r.id)).toEqual([`cat:${a1Cat}`])
      const s = (await getSession(phone))!
      expect(s.conceptId).toBe(a1)
      expect(s.tenantId).toBe(tenantA)
      expect(s.step).toBe('browsing')
      await clearSession(phone)
    } finally {
      await prisma.concept.update({ where: { id: b1 }, data: { storefrontVisible: true } })
    }
  })

  it('no brand open → "ordering is closed right now", and no menu', async () => {
    await prisma.concept.updateMany({ where: { id: { in: [a1, b1] } }, data: { storefrontVisible: false } })
    try {
      const phone = newPhone()
      await text(phone, 'hi')
      expect(brandMenu()).toBeUndefined()
      expect(sent.some((m) => m.kind === 'text' && m.text.startsWith('Ordering is closed right now.'))).toBe(true)
      // The brand closed by its hours says when it opens.
      expect(sent.some((m) => m.kind === 'text' && /Closed is closed right now\. Opens at 10:00/.test(m.text))).toBe(true)
      await clearSession(phone)
    } finally {
      await prisma.concept.updateMany({ where: { id: { in: [a1, b1] } }, data: { storefrontVisible: true } })
    }
  })

  it('an unknown list reply (or an unknown brand) re-sends the menu', async () => {
    const phone = newPhone()
    await text(phone, 'hi')
    sent.length = 0
    await tapList(phone, 'garbage-row')
    expect(brandMenu()).toBeDefined()
    sent.length = 0
    await tapList(phone, 'brand:00000000-0000-0000-0000-000000000000')
    expect(brandMenu()).toBeDefined()
    // A listed-but-not-ordering brand says so, then the menu again.
    sent.length = 0
    await tapList(phone, `brand:${notListed[0]}`)
    expect(sent.some((m) => m.kind === 'text' && m.text === 'Hidden is not taking orders right now.')).toBe(false) // hidden is not on the storefront: no name leaked
    expect(brandMenu()).toBeDefined()
    // A typed name that matches nothing → the menu again; a typed number picks.
    sent.length = 0
    await text(phone, 'pizza palace')
    expect(brandMenu()).toBeDefined()
    const order = (await getSession(phone))!.brandOptions!
    sent.length = 0
    await text(phone, '2')
    expect((await getSession(phone))!.conceptId).toBe(order[1])
    await clearSession(phone)
  })

  it('WHATSAPP_DEFAULT_CONCEPT is optional: missing never throws; set, its brand is listed first', async () => {
    const phone = newPhone()
    delete process.env['WHATSAPP_DEFAULT_CONCEPT']
    await expect(text(phone, 'hi')).resolves.not.toThrow()
    expect(brandMenu()).toBeDefined()

    for (const first of [b1Slug, a1Slug]) {
      process.env['WHATSAPP_DEFAULT_CONCEPT'] = first
      sent.length = 0
      await text(phone, 'hi')
      const firstId = first === b1Slug ? b1 : a1
      expect(brandMenu()!.rows[0]!.id).toBe(`brand:${firstId}`)
    }
    // A wrong slug is ignored, not an error.
    process.env['WHATSAPP_DEFAULT_CONCEPT'] = 'no-such-brand'
    sent.length = 0
    await text(phone, 'hi')
    expect(brandMenu()!.rows).toHaveLength(2)
    await clearSession(phone)
  })
})

describe('ordering at the picked brand', () => {
  it('picking company B\'s brand places the order in company B at B\'s cash GST rate', async () => {
    const phone = newPhone()
    await text(phone, 'hi')
    await tapList(phone, `brand:${b1}`, 'Bravo Grill')
    let s = (await getSession(phone))!
    expect(s.conceptId).toBe(b1)
    expect(s.conceptSlug).toBe(b1Slug)
    expect(s.tenantId).toBe(tenantB)
    expect(lastOf('list')!.rows.map((r) => r.id)).toEqual([`cat:${b1Cat}`])

    // Another brand's category or item is not this cart's.
    sent.length = 0
    await tapList(phone, `cat:${a1Cat}`)
    expect(lastOf('text')!.text).toContain('No items are available')

    await tapList(phone, `cat:${b1Cat}`)
    await tapList(phone, `item:${b1Item}`)
    s = (await getSession(phone))!
    expect(s.cart.map((c) => c.menuItemId)).toEqual([b1Item])

    await tapButton(phone, 'action:confirm')
    expect(lastOf('buttons')!.text).toContain('GST 13%')
    await tapButton(phone, 'action:place')
    expect(lastOf('text')!.text).toContain('Order Placed')

    const orders = await prisma.order.findMany({
      where: { externalId: { startsWith: 'whatsapp-' }, rawPayload: { path: ['phone'], equals: phone } },
      include: { concept: { select: { tenantId: true } } },
    })
    expect(orders).toHaveLength(1)
    expect(orders[0]!.conceptId).toBe(b1)
    expect(orders[0]!.concept.tenantId).toBe(tenantB)
    expect(orders[0]!.taxRatePct).toBe(13)
    expect(orders[0]!.taxCents).toBe(13_000)
    expect(await getSession(phone)).toBeNull()
  })

  it('picking another brand while holding a cart asks first; "keep" keeps it, "switch" empties it', async () => {
    const phone = newPhone()
    const s = newSession(phone, a1, a1Slug, tenantA)
    s.cart = [{ menuItemId: a1Item, name: 'simmer plate', priceCents: 100_000, quantity: 2 }]
    s.step = 'cart'
    await saveSession(s)

    await tapList(phone, `brand:${b1}`)
    let now = (await getSession(phone))!
    expect(now.step).toBe('switch')
    expect(now.conceptId).toBe(a1)
    expect(now.cart).toHaveLength(1)
    const ask = lastOf('buttons')!
    expect(ask.text).toContain('2 item(s) from Simmer')
    expect(ask.buttons.map((b) => b.id)).toEqual(['action:switch-yes', 'action:switch-no'])

    await tapButton(phone, 'action:switch-no')
    now = (await getSession(phone))!
    expect(now.conceptId).toBe(a1)
    expect(now.step).toBe('cart')
    expect(now.cart).toHaveLength(1)

    // "menu" mid-cart shows the brand menu, picking the SAME brand keeps the cart.
    sent.length = 0
    await text(phone, 'menu')
    expect(brandMenu()!.text).toContain('Your cart from Simmer stays')
    await tapList(phone, `brand:${a1}`)
    now = (await getSession(phone))!
    expect(now.conceptId).toBe(a1)
    expect(now.cart).toHaveLength(1)

    await text(phone, 'switch brand')
    await tapList(phone, `brand:${b1}`)
    expect((await getSession(phone))!.step).toBe('switch')
    await text(phone, 'switch')
    now = (await getSession(phone))!
    expect(now.conceptId).toBe(b1)
    expect(now.tenantId).toBe(tenantB)
    expect(now.cart).toEqual([])
    await clearSession(phone)
  })
})

describe('returning members', () => {
  it('greets by name and "Reorder last" uses the brand of the last order', async () => {
    const phone = newPhone()
    const cust = await prisma.customer.create({ data: { name: 'Ayesha Khan', phone: `+${phone}` } })
    const t0 = Date.now()
    await prisma.order.create({
      data: { conceptId: a1, customerId: cust.id, source: 'servd', status: 'completed', totalCents: 100_000, placedAt: new Date(t0 - 86_400_000),
        items: { create: [{ name: 'simmer plate', menuItemId: a1Item, quantity: 1, unitPriceCents: 100_000 }] } },
    })
    await prisma.order.create({
      data: { conceptId: b1, customerId: cust.id, source: 'servd', status: 'completed', totalCents: 300_000, placedAt: new Date(t0 - 3_600_000),
        items: { create: [{ name: 'Bravo Grill plate', menuItemId: b1Item, quantity: 3, unitPriceCents: 100_000 }] } },
    })

    await text(phone, 'hi')
    expect(brandMenu()).toBeUndefined()
    const welcome = lastOf('buttons')!
    expect(welcome.text).toContain('Welcome back, *Ayesha*')
    expect(welcome.text).toContain('Last time at Bravo Grill')
    expect(welcome.buttons.map((b) => b.id)).toEqual(['action:reorder-last', 'action:browse', 'action:brands'])

    await tapButton(phone, 'action:reorder-last')
    const s = (await getSession(phone))!
    expect(s.conceptId).toBe(b1)
    expect(s.tenantId).toBe(tenantB)
    expect(s.step).toBe('confirm')
    expect(s.cart).toEqual([{ menuItemId: b1Item, name: 'Bravo Grill plate', priceCents: 100_000, quantity: 3 }])
    expect(lastOf('buttons')!.text).toContain('Order summary — Bravo Grill')
    await clearSession(phone)

    // The last order's brand no longer takes orders → greeting by name + the menu.
    await prisma.concept.update({ where: { id: b1 }, data: { storefrontVisible: false } })
    try {
      sent.length = 0
      await text(phone, 'hi')
      expect(sent.some((m) => m.kind === 'text' && m.text === 'Welcome back, Ayesha.')).toBe(true)
      // Only Simmer open now → straight to it (one brand, no menu).
      expect((await getSession(phone))!.conceptId).toBe(a1)
      // A stale "Reorder last" tap: Bravo is not taking orders → says so, no cart.
      sent.length = 0
      await tapButton(phone, 'action:reorder-last')
      expect(sent.some((m) => m.kind === 'text' && m.text === 'Bravo Grill is not taking orders right now.')).toBe(true)
      expect((await getSession(phone))!.cart).toEqual([])
    } finally {
      await prisma.concept.update({ where: { id: b1 }, data: { storefrontVisible: true } })
    }
    await clearSession(phone)
  })
})

describe('sessions saved before the brand menu', () => {
  it('are migrated on read and still place the order at their brand\'s company', async () => {
    const phone = newPhone()
    // The v1 shape: a brand from WHATSAPP_DEFAULT_CONCEPT, no tenantId, no brand-menu fields.
    await redis.set(`wa:session:${phone}`, JSON.stringify({
      phone, conceptId: a1, conceptSlug: a1Slug, step: 'cart',
      cart: [{ menuItemId: a1Item, name: 'simmer plate', priceCents: 1, quantity: 1 }], orderType: 'pickup',
    }), 'EX', 600)
    const s = (await getSession(phone))!
    expect(s.v).toBe(2)
    expect(s.conceptId).toBe(a1)
    expect(s.tenantId).toBeNull()
    expect(s.brandOptions).toEqual([])

    await tapButton(phone, 'action:confirm')
    expect((await getSession(phone))!.tenantId).toBe(tenantA)
    expect(lastOf('buttons')!.text).toContain('GST 15%')
    await tapButton(phone, 'action:place')
    const order = await prisma.order.findFirstOrThrow({ where: { rawPayload: { path: ['phone'], equals: phone } } })
    expect(order.conceptId).toBe(a1)
    expect(order.taxCents).toBe(15_000)
  })

  it('a stored session with no brand cannot hold a cart or sit on a brand step', () => {
    const s = normaliseSession({ phone: 'p', step: 'cart', cart: [{ menuItemId: 'x', quantity: 1, priceCents: 1, name: 'x' }] }, 'p')!
    expect(s.step).toBe('idle')
    expect(s.cart).toEqual([])
    expect(normaliseSession('nonsense', 'p')).toBeNull()
    const sw = normaliseSession({ phone: 'p', conceptId: 'c', step: 'switch', cart: [] }, 'p')!
    expect(sw.step).toBe('idle')
  })
})

describe('a brand switched off mid-session (WA-RV-1)', () => {
  async function confirmAt(name: string, tenantId: string) {
    const d = await mkBrand({ name, tenantId })
    const phone = newPhone()
    const s = newSession(phone, d.id, d.slug, tenantId)
    s.cart = [{ menuItemId: d.itemId, name: `${name} plate`, priceCents: 100_000, quantity: 1 }]
    s.step = 'cart'
    await saveSession(s)
    await tapButton(phone, 'action:confirm')
    expect((await getSession(phone))!.step).toBe('confirm')
    return { ...d, phone }
  }
  const ordersAt = (conceptId: string) => prisma.order.count({ where: { conceptId } })

  it('deactivated and deleted after Confirm: "Place order" places nothing, drops the brand and its cart', async () => {
    const d = await confirmAt('Delta', tenantA)
    await prisma.concept.update({ where: { id: d.id }, data: { isActive: false, deletedAt: new Date() } })
    sent.length = 0
    await tapButton(d.phone, 'action:place')
    expect(await ordersAt(d.id)).toBe(0)
    expect(sent.some((m) => m.kind === 'text' && m.text === 'Delta is not taking orders right now. Your cart from it has been emptied.')).toBe(true)
    expect(sent.some((m) => m.kind === 'text' && m.text.includes('Order Placed'))).toBe(false)
    expect(brandMenu()).toBeDefined()
    const s = (await getSession(d.phone))!
    expect(s.conceptId).toBeNull()
    expect(s.cart).toEqual([])
    expect(s.step).toBe('brand')
    await clearSession(d.phone)
  })

  it('the storefront switch turned off mid-session: placeOrder itself refuses with BRAND_CLOSED', async () => {
    const d = await confirmAt('Foxtrot', tenantB)
    const session = (await getSession(d.phone))!
    await prisma.concept.update({ where: { id: d.id }, data: { storefrontVisible: false } })
    sent.length = 0
    await placeOrder(d.phone, session)
    expect(await ordersAt(d.id)).toBe(0)
    expect(lastOf('text')!.text).toContain('Foxtrot is not taking orders right now.')
    // Browsing, too: the next message drops the brand.
    sent.length = 0
    await text(d.phone, 'Confirm order')
    expect(brandMenu()).toBeDefined()
    expect((await getSession(d.phone))!.conceptId).toBeNull()
    await clearSession(d.phone)
  })

  it('a pre-brand-menu session on a since-deleted default brand places nothing', async () => {
    const g = await mkBrand({ name: 'Golf', tenantId: tenantA })
    await prisma.concept.update({ where: { id: g.id }, data: { deletedAt: new Date() } })
    const phone = newPhone()
    await redis.set(`wa:session:${phone}`, JSON.stringify({
      phone, conceptId: g.id, conceptSlug: g.slug, step: 'confirm', orderKey: 'k-golf',
      cart: [{ menuItemId: g.itemId, name: 'Golf plate', priceCents: 100_000, quantity: 1 }], orderType: 'pickup',
    }), 'EX', 600)
    await tapButton(phone, 'action:place')
    expect(await ordersAt(g.id)).toBe(0)
    expect((await getSession(phone))!.conceptId).toBeNull()
    await clearSession(phone)
  })
})

describe('typed replies over the text-only gateway (WA-RV-2)', () => {
  it('a whole order typed: brand, category, item, "Confirm order", "Place order"', async () => {
    const phone = newPhone()
    await text(phone, 'hi')
    await text(phone, 'Bravo Grill')
    expect((await getSession(phone))!.conceptId).toBe(b1)
    await text(phone, 'Mains')
    expect((await getSession(phone))!.step).toBe('category')
    await text(phone, '1')
    expect((await getSession(phone))!.cart.map((c) => c.menuItemId)).toEqual([b1Item])
    await text(phone, 'Confirm order')
    expect((await getSession(phone))!.step).toBe('confirm')
    await text(phone, 'Place order')
    expect(lastOf('text')!.text).toContain('Order Placed')
    const orders = await prisma.order.findMany({ where: { rawPayload: { path: ['phone'], equals: phone } } })
    expect(orders).toHaveLength(1)
    expect(orders[0]!.conceptId).toBe(b1)
  })

  it('numbers and copied option lines work at every prompt', async () => {
    const phone = newPhone()
    await text(phone, 'hi')
    const order = (await getSession(phone))!.brandOptions!
    const bravoN = String(order.indexOf(b1) + 1)
    await text(phone, `${bravoN}.`)
    expect((await getSession(phone))!.conceptId).toBe(b1)
    await text(phone, '• Mains')
    await text(phone, '• Bravo Grill plate — PKR 1000')  // a copied row, price and all
    expect((await getSession(phone))!.cart.map((c) => c.menuItemId)).toEqual([b1Item])
    await text(phone, '1')                       // "1. Add more" → the categories again
    expect((await getSession(phone))!.step).toBe('browsing')
    await text(phone, '1')                       // Mains
    await text(phone, '1')                       // the plate again → 2 in the cart
    expect((await getSession(phone))!.cart[0]!.quantity).toBe(2)
    await text(phone, '2')                       // "2. Confirm order"
    expect((await getSession(phone))!.step).toBe('confirm')
    await text(phone, '2. Cancel')
    expect(await getSession(phone)).toBeNull()
  })

  it('the switch question takes "1" / "2" (and does not repeat forever)', async () => {
    const phone = newPhone()
    const s = newSession(phone, a1, a1Slug, tenantA)
    s.cart = [{ menuItemId: a1Item, name: 'simmer plate', priceCents: 100_000, quantity: 1 }]
    s.step = 'cart'
    await saveSession(s)
    await text(phone, 'menu')
    await text(phone, 'Bravo Grill')
    expect((await getSession(phone))!.step).toBe('switch')
    await text(phone, '2')
    let now = (await getSession(phone))!
    expect(now.step).toBe('cart')
    expect(now.conceptId).toBe(a1)
    expect(now.cart).toHaveLength(1)

    await text(phone, 'menu')
    await text(phone, 'Bravo Grill')
    await text(phone, '1')
    now = (await getSession(phone))!
    expect(now.conceptId).toBe(b1)
    expect(now.cart).toEqual([])
    await clearSession(phone)
  })

  it('the returning-member greeting takes a typed "1" / "reorder last"', async () => {
    const phone = newPhone()
    const cust = await prisma.customer.create({ data: { name: 'Bilal Ahmed', phone: `+${phone}` } })
    await prisma.order.create({
      data: { conceptId: a1, customerId: cust.id, source: 'servd', status: 'completed', totalCents: 100_000, placedAt: new Date(Date.now() - 3_600_000),
        items: { create: [{ name: 'simmer plate', menuItemId: a1Item, quantity: 2, unitPriceCents: 100_000 }] } },
    })
    await text(phone, 'hi')
    await text(phone, '1')
    let s = (await getSession(phone))!
    expect(s.step).toBe('confirm')
    expect(s.cart).toEqual([{ menuItemId: a1Item, name: 'simmer plate', priceCents: 100_000, quantity: 2 }])
    await clearSession(phone)

    await text(phone, 'hi')
    await text(phone, 'Reorder last')
    s = (await getSession(phone))!
    expect(s.step).toBe('confirm')
    await clearSession(phone)
  })

  it('matchOption: numbers, titles, unambiguous prefixes; a partial title never beats a keyword', () => {
    const opts = [{ id: 'action:place', title: 'Place order' }, { id: 'action:cancel', title: 'Cancel' }]
    expect(matchOption(opts, '1')?.id).toBe('action:place')
    expect(matchOption(opts, '2)')?.id).toBe('action:cancel')
    expect(matchOption(opts, '3')).toBeNull()
    expect(matchOption(opts, 'PLACE ORDER.')?.id).toBe('action:place')
    expect(matchOption(opts, '1. Place order')?.id).toBe('action:place')
    expect(matchOption([{ id: 'item:x', title: 'Rice bowl' }], '• Rice bowl — PKR 500')?.id).toBe('item:x')
    expect(matchOption(opts, 'place')?.id).toBe('action:place')
    expect(matchOption(opts, 'pla')).toBeNull()                 // too short to be a prefix
    expect(matchOption(opts, 'place', false)).toBeNull()        // prefixes off (a keyword was typed)
    const cats = [{ id: 'cat:1', title: 'Hello Bowls' }, { id: 'cat:2', title: 'Hello Wraps' }]
    expect(matchOption(cats, 'hello bowls')?.id).toBe('cat:1')  // exact title wins
    expect(matchOption(cats, 'hello')).toBeNull()               // ambiguous
    expect(matchOption([], '1')).toBeNull()
  })

  it('typing a category called "Hello Bowls" picks it rather than restarting', async () => {
    const hb = await prisma.category.create({ data: { conceptId: b1, name: 'Hello Bowls', sortOrder: 5 } })
    await prisma.menuItem.create({ data: { conceptId: b1, categoryId: hb.id, name: 'Rice bowl', priceCents: 50_000 } })
    try {
      const phone = newPhone()
      await text(phone, 'hi')
      await text(phone, 'Bravo Grill')
      await text(phone, 'hello bowls')
      const s = (await getSession(phone))!
      expect(s.step).toBe('category')
      expect(s.selectedCategoryId).toBe(hb.id)
      // A bare "hello" is still a greeting.
      await text(phone, 'hello')
      expect(brandMenu()).toBeDefined()
      await clearSession(phone)
    } finally {
      await prisma.menuItem.updateMany({ where: { categoryId: hb.id }, data: { deletedAt: new Date() } })
      await prisma.category.update({ where: { id: hb.id }, data: { deletedAt: new Date() } })
    }
  })
})

describe('only brands with a reachable dish are listed (WA-RV-3)', () => {
  it('a brand whose only dish is in a switched-off or out-of-hours section is not listed, and the menu skips empty sections', async () => {
    const ids = (await orderingBrands()).map((b) => b.id)
    expect(ids).not.toContain(notListed[notListed.length - 2]) // Charlie
    expect(ids).not.toContain(notListed[notListed.length - 1]) // Echo
    // Its section back on → Charlie is listed, and its empty "Specials" section is not offered.
    const charlie = notListed[notListed.length - 2]!
    await prisma.category.updateMany({ where: { conceptId: charlie, name: 'Mains' }, data: { isActive: true } })
    try {
      expect((await orderingBrands()).map((b) => b.id)).toContain(charlie)
      const phone = newPhone()
      await text(phone, 'hi')
      await tapList(phone, `brand:${charlie}`)
      expect(lastOf('list')!.rows.map((r) => r.title)).toEqual(['Mains'])
      await clearSession(phone)
    } finally {
      await prisma.category.updateMany({ where: { conceptId: charlie, name: 'Mains' }, data: { isActive: false } })
    }
  })
})
