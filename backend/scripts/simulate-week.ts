/**
 * SIMULATE-WEEK
 *
 * Backfills 7 days of realistic shop activity for the GS Foods ecosystem
 * so dashboards, charts, analytics, payroll and the labour-cost view all
 * have meat on the bones. Then leaves today mid-flight (open shifts, live
 * KDS tickets, customers eating, reservations booked) so the operator can
 * watch a real day in progress.
 *
 * Idempotent: re-running will skip days that already have shifts; safe to
 * run multiple times.
 *
 * Day shape (Pakistani restaurant timing, PKT = UTC+5):
 *   • Lunch service:    12:00–15:30   (Tier-1 brigade)
 *   • Idle:             15:30–18:00
 *   • Dinner service:   18:30–23:30   (Tier-2 brigade, busier)
 *   • Mon–Thu:           60–80 orders
 *   • Fri–Sun:          100–140 orders
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// PKT helpers — we store wall-clock PKT moments as UTC+5
function pkt(daysAgo: number, hour: number, minute = 0): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  d.setUTCHours(hour - 5, minute, 0, 0)  // PKT to UTC
  return d
}
function dateOnly(daysAgo: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  d.setUTCHours(0, 0, 0, 0)
  return d
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}
function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(n, arr.length))
}
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function main() {
  console.log('━━━ Simulating 7-day live activity ━━━\n')

  // ── Load anchors ──────────────────────────────────────────────────────────
  const concepts = await prisma.concept.findMany({ where: { isActive: true } })
  const locations = await prisma.location.findMany({ where: { isActive: true } })
  const menu = await prisma.menuItem.findMany({ where: { isAvailable: true } })
  const tables = await prisma.table.findMany()
  const customers = await prisma.customer.findMany({ take: 50 })
  const kitchenStaff = await prisma.kitchenStaff.findMany({ where: { status: 'active' } })
  const users = await prisma.user.findMany({ where: { isActive: true } })

  if (!locations.length || !concepts.length || !menu.length) {
    console.error('Run seed-live-state first — missing concepts/locations/menu')
    process.exit(1)
  }

  const locationId = locations[0]!.id
  const manager = users.find((u) => u.role === 'manager') ?? users[0]!
  const cashiers = users.filter((u) => u.role === 'cashier')
  const allStaffUsers = [manager, ...cashiers]

  const menuByConcept: Record<string, typeof menu> = {}
  for (const m of menu) (menuByConcept[m.conceptId] ??= []).push(m)
  const tablesByConcept: Record<string, typeof tables> = {}
  for (const t of tables) (tablesByConcept[t.conceptId] ??= []).push(t)

  console.log(`Concepts: ${concepts.length}, Menu: ${menu.length}, Staff: ${kitchenStaff.length}, Customers: ${customers.length}\n`)

  // ── Day-by-day backfill ───────────────────────────────────────────────────
  let totalOrders = 0
  let totalShifts = 0
  let totalKitchenShifts = 0

  for (let dayOffset = 7; dayOffset >= 1; dayOffset--) {
    const dayDate = dateOnly(dayOffset)
    const dow = dayDate.getUTCDay()              // 0=Sun 5=Fri 6=Sat
    const isWeekend = dow === 5 || dow === 6 || dow === 0
    const orderTarget = isWeekend ? rand(100, 140) : rand(60, 80)
    const dayLabel = dayDate.toISOString().slice(0, 10)

    // Skip if we've already simulated this day
    const existing = await prisma.shift.count({
      where: { openedAt: { gte: dayDate, lt: new Date(dayDate.getTime() + 24 * 3600_000) } },
    })
    if (existing > 2) {
      console.log(`Day -${dayOffset} (${dayLabel}, ${isWeekend ? 'weekend' : 'weekday'}) ⏭  already has ${existing} shifts`)
      continue
    }

    console.log(`Day -${dayOffset} (${dayLabel}, ${isWeekend ? 'weekend' : 'weekday'}) — target ${orderTarget} orders…`)

    // POS shifts: manager 11am-11pm; cashier1 11am-7pm; cashier2 4pm-12am
    const shiftManager = await prisma.shift.create({
      data: {
        userId: manager.id, locationId, status: 'closed',
        openedAt: pkt(dayOffset, 11, 0), closedAt: pkt(dayOffset, 23, 30),
        openingFloatCents: 500000, closingFloatCents: 500000,
      },
    })
    const shiftC1 = cashiers[0] ? await prisma.shift.create({
      data: {
        userId: cashiers[0].id, locationId, status: 'closed',
        openedAt: pkt(dayOffset, 11, 0), closedAt: pkt(dayOffset, 19, 0),
        openingFloatCents: 500000, closingFloatCents: 500000,
      },
    }) : null
    const shiftC2 = cashiers[1] ? await prisma.shift.create({
      data: {
        userId: cashiers[1].id, locationId, status: 'closed',
        openedAt: pkt(dayOffset, 16, 0), closedAt: pkt(dayOffset, 0, 0),
        openingFloatCents: 500000, closingFloatCents: 500000,
      },
    }) : null
    totalShifts += [shiftManager, shiftC1, shiftC2].filter(Boolean).length

    // Kitchen brigade — each staff member punches in (idempotent on staffId+date)
    for (const [i, ks] of kitchenStaff.entries()) {
      const isOff = (i + dayOffset) % 7 === 6
      if (isOff) {
        await prisma.kitchenShift.upsert({
          where: { staffId_date: { staffId: ks.id, date: dayDate } },
          update: {},
          create: {
            staffId: ks.id, date: dayDate,
            scheduledStart: '00:00', scheduledEnd: '00:00',
            isWeeklyOff: true, breakMinutes: 0,
          },
        })
        continue
      }
      const tier = i < kitchenStaff.length / 2 ? 'lunch' : 'dinner'
      const start = tier === 'lunch' ? '11:00' : '14:00'
      const end = tier === 'lunch' ? '23:00' : '00:00'
      const actualStart = tier === 'lunch' ? '10:58' : '14:03'
      const actualEnd = tier === 'lunch' ? '23:05' : '23:58'
      await prisma.kitchenShift.upsert({
        where: { staffId_date: { staffId: ks.id, date: dayDate } },
        update: {},
        create: {
          staffId: ks.id, date: dayDate,
          scheduledStart: start, scheduledEnd: end,
          actualStart, actualEnd, breakMinutes: 60,
        },
      })
      totalKitchenShifts++
    }

    // Orders — distributed across the service hours
    let dayOrders = 0
    const hourBuckets: Array<{ hour: number; weight: number }> = [
      { hour: 12, weight: 14 }, { hour: 13, weight: 18 }, { hour: 14, weight: 10 },
      { hour: 15, weight: 4 },  { hour: 16, weight: 2 },  { hour: 17, weight: 3 },
      { hour: 18, weight: 7 },  { hour: 19, weight: 16 }, { hour: 20, weight: 22 },
      { hour: 21, weight: 18 }, { hour: 22, weight: 10 }, { hour: 23, weight: 4 },
    ]
    const totalWeight = hourBuckets.reduce((s, h) => s + h.weight, 0)

    for (const bucket of hourBuckets) {
      const ordersThisHour = Math.round((bucket.weight / totalWeight) * orderTarget)
      for (let n = 0; n < ordersThisHour; n++) {
        const conc = pick(concepts)
        const conceptMenu = menuByConcept[conc.id] ?? []
        if (!conceptMenu.length) continue
        const items = pickN(conceptMenu, rand(1, 4))
        if (!items.length) continue

        const subtotal = items.reduce((s, item) => s + item.priceCents * rand(1, 3), 0)
        const tax = Math.round(subtotal * 0.17)
        const total = subtotal + tax

        // Source split: 50% POS, 25% storefront, 15% foodpanda, 10% careem
        const r = Math.random()
        const source = r < 0.5 ? 'pos' : r < 0.75 ? 'servd' : r < 0.9 ? 'foodpanda' : 'careem'
        const isDineIn = source === 'pos' && (conc.slug === 'simmer' || conc.slug === 'gs-x-viva') && Math.random() < 0.6
        const tableId = isDineIn ? pick(tablesByConcept[conc.id] ?? [])?.id : undefined

        // Which shift gets credit for this order
        const minute = rand(0, 59)
        const placedAt = pkt(dayOffset, bucket.hour, minute)
        let shiftId: string | undefined
        if (source === 'pos') {
          if (bucket.hour < 16) shiftId = shiftC1?.id ?? shiftManager.id
          else if (bucket.hour >= 19) shiftId = shiftC2?.id ?? shiftManager.id
          else shiftId = shiftManager.id
        }

        const cust = Math.random() < 0.4 ? pick(customers) : null

        const order = await prisma.order.create({
          data: {
            source: source as any,
            status: 'completed',
            conceptId: conc.id,
            locationId,
            customerId: cust?.id,
            customerName: cust?.name ?? (source === 'foodpanda' ? `Foodpanda #${rand(1000, 9999)}` : source === 'careem' ? `Careem #${rand(1000, 9999)}` : 'Walk-in'),
            tableId,
            shiftId,
            posStaffId: shiftId ? manager.id : null,
            totalCents: total,
            taxCents: tax,
            placedAt,
            createdAt: placedAt,
            updatedAt: placedAt,
          },
        })
        await prisma.orderItem.createMany({
          data: items.map((it) => ({
            orderId: order.id, menuItemId: it.id,
            name: it.name, quantity: rand(1, 3), unitPriceCents: it.priceCents,
            status: 'bumped' as any, course: 1,
          })),
        })
        if (shiftId) {
          await prisma.payment.create({
            data: {
              orderId: order.id, shiftId,
              method: (Math.random() < 0.5 ? 'cash' : Math.random() < 0.7 ? 'card' : 'jazzcash_wallet') as any,
              amountCents: total, status: 'paid',
              processedAt: placedAt, createdAt: placedAt,
            },
          })
        } else {
          // External orders pay via card
          await prisma.payment.create({
            data: {
              orderId: order.id,
              method: 'card', amountCents: total, status: 'paid',
              processedAt: placedAt, createdAt: placedAt,
            },
          })
        }
        dayOrders++
      }
    }
    totalOrders += dayOrders
    console.log(`  ✓ ${dayOrders} orders, ${[shiftManager, shiftC1, shiftC2].filter(Boolean).length} POS shifts, brigade punched`)
  }

  // ── TODAY (day 0) — leave it mid-flight ───────────────────────────────────
  console.log('\n━━ TODAY (live) ━━')
  const todayShiftCount = await prisma.shift.count({
    where: { openedAt: { gte: dateOnly(0) }, status: 'open' },
  })
  if (todayShiftCount > 0) {
    console.log(`Already have ${todayShiftCount} open shifts today — skipping live setup`)
  } else {
    // Brigade punched in for today
    for (const [i, ks] of kitchenStaff.entries()) {
      const isOff = (i + 0) % 7 === 6
      if (isOff) {
        await prisma.kitchenShift.upsert({
          where: { staffId_date: { staffId: ks.id, date: dateOnly(0) } },
          update: {},
          create: {
            staffId: ks.id, date: dateOnly(0),
            scheduledStart: '00:00', scheduledEnd: '00:00',
            isWeeklyOff: true, breakMinutes: 0,
          },
        })
        continue
      }
      const tier = i < kitchenStaff.length / 2 ? 'lunch' : 'dinner'
      const start = tier === 'lunch' ? '11:00' : '14:00'
      const end = tier === 'lunch' ? '23:00' : '00:00'
      const actualStart = tier === 'lunch' ? '10:58' : '14:03'
      await prisma.kitchenShift.upsert({
        where: { staffId_date: { staffId: ks.id, date: dateOnly(0) } },
        update: {},
        create: {
          staffId: ks.id, date: dateOnly(0),
          scheduledStart: start, scheduledEnd: end,
          actualStart, breakMinutes: 60,
        },
      })
    }
    console.log('  ✓ Brigade punched in for today')
  }

  // ── Reviews on completed orders ──────────────────────────────────────────
  const reviewSamples = [
    { rating: 5, comment: 'Service was excellent and food was hot. Will come back.' },
    { rating: 5, comment: 'Best burger in Karachi. Hands down.' },
    { rating: 4, comment: 'Good food, but waited a bit too long for dessert.' },
    { rating: 4, comment: 'Lovely atmosphere, sea bass was perfect.' },
    { rating: 3, comment: 'Average. Tandoor chicken could be juicier.' },
    { rating: 5, comment: 'Fries were perfect. 10/10.' },
    { rating: 2, comment: 'Burger was cold by the time it arrived.' },
  ]
  const ordersWithoutReviews = await prisma.order.findMany({
    where: {
      status: 'completed',
      customerId: { not: null },
      placedAt: { gte: dateOnly(7), lt: dateOnly(1) },
      review: null,
    },
    take: 20,
  })
  let reviewsAdded = 0
  for (const ord of ordersWithoutReviews) {
    if (Math.random() < 0.4) {
      const sample = pick(reviewSamples)
      try {
        await prisma.orderReview.create({
          data: {
            orderId: ord.id, customerId: ord.customerId!,
            rating: sample.rating, comment: sample.comment,
            createdAt: new Date(ord.placedAt.getTime() + 2 * 3600_000),
          },
        })
        reviewsAdded++
      } catch (e) {
        // unique constraint
      }
    }
  }
  console.log(`  ✓ ${reviewsAdded} customer reviews added`)

  // ── Update customer rollups ──────────────────────────────────────────────
  for (const c of customers) {
    const stats = await prisma.order.aggregate({
      where: { customerId: c.id, status: 'completed' },
      _count: { _all: true },
      _sum: { totalCents: true },
      _max: { placedAt: true },
    })
    const reviewAvg = await prisma.orderReview.aggregate({
      where: { customerId: c.id },
      _avg: { rating: true },
      _count: { _all: true },
    })
    await prisma.customer.update({
      where: { id: c.id },
      data: {
        totalOrders: stats._count._all,
        totalSpendCents: stats._sum.totalCents ?? 0,
        lastVisitAt: stats._max.placedAt,
        avgReviewRating: reviewAvg._avg.rating,
        reviewCount: reviewAvg._count._all,
      },
    }).catch(() => null)
  }
  console.log('  ✓ Customer rollups recalculated')

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n━━━ Done ━━━')
  console.log(`  • ${totalOrders} historical orders across 7 days`)
  console.log(`  • ${totalShifts} POS shifts (3 per day)`)
  console.log(`  • ${totalKitchenShifts} kitchen punch records`)
  console.log(`  • Reviews + customer rollups refreshed`)
  console.log(`\nNext: run scripts/live-ticker.ts in background to keep activity flowing`)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
