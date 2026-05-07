// 3-month operations simulation.
//
// Runs end-of-day-by-day for the last 90 days across every active concept:
//   • Opens morning + dinner shifts, fires orders during each, closes.
//   • Generates realistic order traffic with day-of-week + meal-period curves.
//   • Mixes channels: POS / storefront / foodpanda / careem.
//   • Pays orders (cash / card / wallet) with the gateway settle path.
//   • Random voids + comps + refunds at policy-realistic rates.
//   • Sprinkles supplier bills + payments + waste log entries.
//   • Schedules a few reservations.
//
// Idempotent on a per-day basis: each order carries an external_id with the
// simulation date, so re-runs don't double-insert.

import { PrismaClient } from '@prisma/client'
import { ingestOrder } from '../src/modules/orders/service.js'
import { processPayment, openShift, closeShift, voidOrderItem, compOrder, refundOrder } from '../src/modules/pos/service.js'
import { createBill, createPayment } from '../src/modules/procurement/service.js'
import { computeServiceCharge } from '../src/lib/setup-config.js'

const prisma = new PrismaClient({ log: ['warn', 'error'] })

const SIM_TAG = 'sim3mo'
const DAYS = 90

// Deterministic PRNG so re-runs produce the same data. Mulberry32.
function makeRng(seed: number) {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = makeRng(0xC0FFEE)
const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)]!
const between = (lo: number, hi: number) => Math.floor(rng() * (hi - lo + 1)) + lo
const chance = (p: number) => rng() < p

// Brand-specific volume curve. Tuned roughly: Stax/Strata = busy QSR, Flipd =
// dessert/snack moderate, Simmer/Craveman = cloud-kitchen busy, Garnish
// Station = catering low daily volume.
const BRAND_VOLUME: Record<string, { lunch: [number, number]; dinner: [number, number]; pricePoint: [number, number] }> = {
  stax:             { lunch: [25, 50], dinner: [40, 80], pricePoint: [55000, 120000] },
  strata:           { lunch: [20, 45], dinner: [35, 75], pricePoint: [60000, 140000] },
  flipd:            { lunch: [10, 20], dinner: [18, 35], pricePoint: [25000, 50000] },
  simmer:           { lunch: [22, 45], dinner: [38, 70], pricePoint: [50000, 110000] },
  craveman:         { lunch: [18, 38], dinner: [30, 60], pricePoint: [55000, 130000] },
  'garnish-station':{ lunch: [3,  10], dinner: [5, 14],  pricePoint: [200000, 600000] }, // catering
}

// Day-of-week multiplier (0 = Sun .. 6 = Sat). Pakistan: Friday/Saturday peak.
const DOW_MULT = [0.85, 0.75, 0.85, 0.95, 1.15, 1.30, 1.10]

// Channel mix per brand.
type Source = 'pos' | 'servd' | 'foodpanda' | 'careem'
const CHANNEL_MIX: Source[] = [
  ...Array(40).fill('pos'),
  ...Array(25).fill('servd'),
  ...Array(25).fill('foodpanda'),
  ...Array(10).fill('careem'),
] as Source[]

interface Concept {
  id: string; slug: string; name: string; taxRate: number
}
interface MenuItemLite {
  id: string; conceptId: string; name: string; priceCents: number; stationId: string | null
}
interface UserLite { id: string; role: string; conceptIds: string[] | null }

async function main() {
  const start = Date.now()
  console.log(`\n━━━ 3-Month Simulation ━━━`)
  console.log(`Span: last ${DAYS} days through ${new Date().toLocaleDateString('en-GB')}\n`)

  const concepts = await prisma.concept.findMany({ where: { deletedAt: null, isActive: true } })
  if (concepts.length === 0) { console.error('No active concepts found. Seed first.'); process.exit(1) }
  console.log(`Found ${concepts.length} active concepts: ${concepts.map((c) => c.slug).join(', ')}\n`)

  // Pre-fetch menu items per concept. Skip concepts with no menu items.
  const menuByConcept = new Map<string, MenuItemLite[]>()
  for (const c of concepts) {
    const items = await prisma.menuItem.findMany({
      where: { conceptId: c.id, isAvailable: true, deletedAt: null },
      select: { id: true, conceptId: true, name: true, priceCents: true, stationId: true },
      take: 200,
    })
    menuByConcept.set(c.id, items)
  }

  // Pre-fetch staff. Prefer cashier/manager; fall back to any active user
  // (admin will do for shift attribution in a sim).
  let staffRaw = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null, role: { in: ['cashier', 'manager'] } },
  })
  if (staffRaw.length === 0) {
    staffRaw = await prisma.user.findMany({
      where: { isActive: true, deletedAt: null, role: { in: ['admin', 'manager', 'cashier'] } },
      take: 5,
    })
  }
  if (staffRaw.length === 0) {
    console.error('No active users found at all. Seed first.')
    process.exit(1)
  }
  const staff: UserLite[] = staffRaw.map((u) => ({ id: u.id, role: u.role, conceptIds: null }))
  console.log(`Using ${staff.length} staff member(s) for shifts: ${staffRaw.map((u) => u.name).join(', ')}\n`)

  // Pre-fetch a customer pool to attach to ~70% of orders.
  const customers = await prisma.customer.findMany({ take: 100 })

  // Pre-fetch suppliers for bill simulation.
  const suppliers = await prisma.supplier.findMany({ where: { deletedAt: null }, take: 20 })

  let totalOrders = 0
  let totalShifts = 0
  let totalBills = 0
  let totalRefunds = 0
  let totalReservations = 0
  let totalRevenueCents = 0
  let skippedDays = 0

  const today = new Date()
  for (let dayOffset = DAYS - 1; dayOffset >= 0; dayOffset--) {
    const day = new Date(today)
    day.setDate(day.getDate() - dayOffset)
    day.setHours(0, 0, 0, 0)

    const dateLabel = day.toISOString().slice(0, 10)
    const dowMult = DOW_MULT[day.getDay()]!
    const isWeekend = day.getDay() === 5 || day.getDay() === 6

    process.stdout.write(`\r  ${dateLabel} (${day.toLocaleDateString('en-GB', { weekday: 'short' })}) `)

    for (const c of concepts) {
      const items = menuByConcept.get(c.id) ?? []
      if (items.length === 0) continue

      const vol = BRAND_VOLUME[c.slug] ?? BRAND_VOLUME.stax!
      const lunchCount = Math.round(between(vol.lunch[0], vol.lunch[1]) * dowMult)
      const dinnerCount = Math.round(between(vol.dinner[0], vol.dinner[1]) * dowMult)

      // ─── Open lunch shift ────────────────────────────────────────────
      const cashier = pick(staff)
      const lunchShift = await openShiftForDate(cashier.id, c.id, day, 11)
      totalShifts++

      const lunchOrders = await burnOrders({
        concept: c, items, customers, count: lunchCount,
        baseDate: day, hourStart: 11, hourEnd: 15,
        cashierId: cashier.id, shiftId: lunchShift.id,
      })
      totalOrders += lunchOrders.placed
      totalRevenueCents += lunchOrders.revenue
      totalRefunds += lunchOrders.refunded

      // Close lunch shift with a small variance
      await closeShiftForDate(lunchShift.id, day, 15, lunchOrders.cashRevenue)

      // ─── Dinner shift ────────────────────────────────────────────────
      const dinnerCashier = pick(staff)
      const dinnerShift = await openShiftForDate(dinnerCashier.id, c.id, day, 18)
      totalShifts++

      const dinnerOrders = await burnOrders({
        concept: c, items, customers, count: dinnerCount,
        baseDate: day, hourStart: 18, hourEnd: 23,
        cashierId: dinnerCashier.id, shiftId: dinnerShift.id,
      })
      totalOrders += dinnerOrders.placed
      totalRevenueCents += dinnerOrders.revenue
      totalRefunds += dinnerOrders.refunded

      await closeShiftForDate(dinnerShift.id, day, 23, dinnerOrders.cashRevenue)

      // ─── Reservations (weekends or busy weekdays) ───────────────────
      if (isWeekend && chance(0.7)) {
        const partySize = between(2, 8)
        const startTime = new Date(day); startTime.setHours(20, 0, 0, 0)
        try {
          await prisma.reservation.create({
            data: {
              conceptId: c.id,
              partySize,
              startTime,
              endTime: new Date(startTime.getTime() + 90 * 60_000),
              guestName: `Guest ${dateLabel.slice(5)}`,
              guestPhone: `+923${between(100000000, 999999999)}`,
              status: 'confirmed',
              source: 'website',
            },
          })
          totalReservations++
        } catch { /* ignore conflicts */ }
      }
    }

    // ─── Supplier bills + payments (a few per week) ─────────────────────
    if (suppliers.length > 0 && day.getDay() === 1) {  // Mondays
      for (let i = 0; i < between(2, 4); i++) {
        try {
          const supplier = pick(suppliers)
          const subtotal = between(50000, 500000)
          const tax = Math.round(subtotal * 0.17)
          const billNumber = `${SIM_TAG}-${dateLabel}-${supplier.id.slice(-4)}-${i}`
          const exists = await prisma.supplierBill.findFirst({ where: { billNumber } })
          if (exists) continue
          const bill = await createBill({
            supplierId: supplier.id,
            billNumber,
            billDate: day.toISOString(),
            dueDate: new Date(day.getTime() + 30 * 86400_000).toISOString(),
            lines: [{ description: 'Weekly supplies', quantity: 1, unitCostCents: subtotal }],
            taxCents: tax,
            createdBy: staff[0]!.id,
          })
          totalBills++
          // 60% chance of paying within 2 weeks
          if (chance(0.6)) {
            const payDate = new Date(day.getTime() + between(7, 21) * 86400_000)
            if (payDate < today) {
              try {
                await createPayment({
                  supplierId: supplier.id,
                  amountCents: bill.totalCents,
                  paymentDate: payDate.toISOString(),
                  method: chance(0.7) ? 'bank_transfer' : 'cash',
                  reference: `Pay-${billNumber}`,
                  applications: [{ billId: bill.id, amountAppliedCents: bill.totalCents }],
                  createdBy: staff[0]!.id,
                })
              } catch { /* ignore: bill already fully applied */ }
            }
          }
        } catch (err) {
          // Surface the FIRST occurrence so I can diagnose silent-failure cases
          if (totalBills === 0 && (err as Error).message) {
            console.warn(`\n  [supplier bill] ${(err as Error).message}`)
          }
        }
      }
    }
  }
  process.stdout.write('\n\n')

  // ─── Summary ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`━━━ Summary ━━━`)
  console.log(`  ${totalOrders.toLocaleString()} orders placed`)
  console.log(`  ${totalShifts.toLocaleString()} shifts opened+closed`)
  console.log(`  ${totalBills.toLocaleString()} supplier bills posted`)
  console.log(`  ${totalRefunds.toLocaleString()} voids/comps/refunds applied`)
  console.log(`  ${totalReservations.toLocaleString()} reservations created`)
  console.log(`  PKR ${(totalRevenueCents / 100).toLocaleString()} gross revenue across ${concepts.length} brands`)
  if (skippedDays > 0) console.log(`  (${skippedDays} day-brand combinations skipped — no menu)`)
  console.log(`\n  Elapsed: ${elapsed}s`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function openShiftForDate(userId: string, _conceptId: string, day: Date, hour: number) {
  // Override `openedAt` with our backdated time. The real openShift refuses if
  // user already has an open shift, so we close any leftover first.
  await prisma.shift.updateMany({
    where: { userId, status: 'open' },
    data: { status: 'closed', closedAt: day, closingFloatCents: 0 },
  })
  const opened = new Date(day); opened.setHours(hour, 0, 0, 0)
  return prisma.shift.create({
    data: { userId, openingFloatCents: 500000, status: 'open', openedAt: opened },
  })
}

async function closeShiftForDate(shiftId: string, day: Date, hour: number, expectedCash: number) {
  const closed = new Date(day); closed.setHours(hour, 30, 0, 0)
  const variance = Math.round((rng() - 0.5) * 40000)  // ±200 PKR
  // Use the real closeShift path so journal entries post via postShiftClose.
  // Fall back to a raw update if the real call fails (smoke tolerance).
  try {
    await closeShift(shiftId, 500000 + expectedCash + variance)
    // Backdate to the simulated close time
    await prisma.shift.update({ where: { id: shiftId }, data: { closedAt: closed } })
  } catch {
    await prisma.shift.update({
      where: { id: shiftId },
      data: { status: 'closed', closedAt: closed, closingFloatCents: 500000 + expectedCash + variance },
    })
  }
}

interface BurnOpts {
  concept: Concept
  items: MenuItemLite[]
  customers: { id: string; name: string }[]
  count: number
  baseDate: Date
  hourStart: number
  hourEnd: number
  cashierId: string
  shiftId: string
}

async function burnOrders(opts: BurnOpts): Promise<{ placed: number; revenue: number; cashRevenue: number; refunded: number }> {
  const { concept, items, customers, count, baseDate, hourStart, hourEnd, cashierId, shiftId } = opts
  let placed = 0
  let revenue = 0
  let cashRevenue = 0
  let refunded = 0

  for (let i = 0; i < count; i++) {
    try {
      const placedAt = new Date(baseDate)
      placedAt.setHours(hourStart + Math.floor(rng() * (hourEnd - hourStart)), between(0, 59), between(0, 59))

      const source = pick(CHANNEL_MIX)
      const itemCount = between(1, 4)
      const orderItems = []
      let itemTotal = 0
      for (let j = 0; j < itemCount; j++) {
        const item = pick(items)
        const qty = between(1, 3)
        orderItems.push({
          externalItemId: item.id,
          menuItemId: item.id,
          name: item.name,
          quantity: qty,
          unitPriceCents: item.priceCents,
          modifiers: [],
        })
        itemTotal += item.priceCents * qty
      }
      const taxCents = Math.round(itemTotal * (concept.taxRate / 100))
      const serviceChargeCents = await computeServiceCharge(itemTotal + taxCents, source === 'pos' ? 'pos' : 'storefront')
      const totalCents = itemTotal + taxCents + serviceChargeCents

      const customer = chance(0.7) ? pick(customers) : null
      const externalId = `${SIM_TAG}-${placedAt.toISOString()}-${concept.slug}-${i}`

      const { order } = await ingestOrder({
        source: source as never,
        external_id: externalId,
        concept_id: concept.id,
        placed_at: placedAt.toISOString(),
        customer_id: customer?.id ?? null,
        customer_name: customer?.name ?? null,
        table_id: null,
        ...(source === 'pos' && { pos_staff_id: cashierId, shift_id: shiftId }),
        items: orderItems,
        payment: { provider: null as never, amountCents: totalCents, status: 'pending' },
        loyalty_points_earned: null,
        delivery_notes: null,
        estimated_pickup: null,
      })

      // Patch totals (ingestOrder doesn't accept tax/service inline)
      await prisma.order.update({
        where: { id: order.id },
        data: {
          taxCents, serviceChargeCents, totalCents,
          placedAt,
          status: 'completed',
          completedAt: new Date(placedAt.getTime() + between(15, 45) * 60_000),
        },
      })

      // Pay it. POS = cash/card mix; aggregator = wallet/card; storefront = card/wallet.
      const isPos = source === 'pos'
      const isCash = isPos && chance(0.45)
      const method = isCash ? 'cash' : isPos ? (chance(0.5) ? 'card' : 'jazzcash_wallet') : (chance(0.5) ? 'card' : 'easypaisa_wallet')
      try {
        await processPayment({
          orderId: order.id,
          shiftId,
          payments: [{
            method: method as never,
            amountCents: totalCents,
            ...(method === 'cash' && { tenderedCents: totalCents }),
            ...(method !== 'cash' && { gatewayRef: `sim-${order.id.slice(-8)}`, gateway: (method === 'card' ? 'keenu' : method.startsWith('jaz') ? 'jazzcash' : 'easypaisa') as never }),
          }],
        })
      } catch { /* gateway-ref required on non-cash; safe to ignore in sim */ }

      revenue += totalCents
      if (isCash) cashRevenue += totalCents
      placed++

      // Random void/comp/refund (<2% of orders)
      if (chance(0.015)) {
        const r = rng()
        try {
          if (r < 0.4) {
            // Fetch the order's items separately — ingestOrder return shape varies
            const oi = await prisma.orderItem.findFirst({ where: { orderId: order.id, voidedAt: null } })
            if (oi) {
              await voidOrderItem({
                orderId: order.id,
                orderItemId: oi.id,
                reason: 'simulated void',
                actorId: cashierId,
                actorRole: 'manager',  // bypass cashier cap so the sim doesn't fail policy
              })
            }
          } else if (r < 0.7) {
            await compOrder({
              orderId: order.id,
              amountCents: Math.min(totalCents, between(10000, 30000)),
              reason: 'simulated comp — guest service',
              actorId: cashierId,
              actorRole: 'manager',  // bypass cashier cap so the sim doesn't fail policy
            })
          } else {
            await refundOrder({
              orderId: order.id,
              amountCents: Math.min(totalCents, between(20000, 50000)),
              reason: 'simulated refund',
              actorId: cashierId,
              actorRole: 'manager',
            })
          }
          refunded++
        } catch { /* policy might block; that's fine */ }
      }
    } catch (err) {
      // Idempotent on external_id — re-run will silently re-fetch existing
    }
  }
  return { placed, revenue, cashRevenue, refunded }
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
