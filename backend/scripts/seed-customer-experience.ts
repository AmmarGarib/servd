// Customer-experience seed.
//
// Populates customer-side demo data so /account, /brand/<slug>, and the
// kitchen tracker never feel empty during testing. Also exercises the
// lifecycle workers — by setting realistic firstOrderAt / lastOrderAt /
// birthdays, the birthday/winback/welcome triggers will actually fire on
// their next tick.
//
// Idempotent: each demo customer is keyed by email; skipped if already
// present. Safe to run repeatedly.
//
// Run AFTER the main seed:
//   npm run --prefix backend db:seed
//   tsx scripts/seed-customer-experience.ts
//
// What it creates:
//   • "Demo Power User" — 25 completed orders, 4 reviews (mix of 5/4/3),
//     loyalty Gold, 2 upcoming reservations, 3 past reservations, today's birthday
//   • "Demo New Customer" — 1 completed order, no review yet (tests welcome flow)
//   • "Demo Lapsed Customer" — last order 90 days ago (tests winback flow)
//   • "Demo Complainer" — 1 complaint marked resolved 25h ago (tests follow-up)
//   • Public reviews on each concept (so /brand/<slug> shows real ratings)

import { PrismaClient } from '@prisma/client'

const SEED_MARKER_EMAIL = 'demo.power@servd.pk'

const prisma = new PrismaClient()

const SAMPLE_REVIEW_COMMENTS = [
  { rating: 5, comment: 'Quietly the best burger in town. Bun was warm. Pickles were sharp. Special sauce hit.', tags: ['Food was great', 'Loved the flavours'] },
  { rating: 5, comment: 'Service was quick and the macros were exactly what I needed.',                       tags: ['Quick service', 'Good value'] },
  { rating: 4, comment: 'Loved the food. Driver took a while.',                                                tags: ['Food was great'] },
  { rating: 4, comment: 'Generous portions, would order again.',                                               tags: ['Generous portions', 'Good value'] },
  { rating: 3, comment: 'Decent but the fries were a bit cold.',                                               tags: ['Cold when it arrived'] },
  { rating: 5, comment: 'These guys understand smashburgers. Crisp edges, melty cheese, perfect.',             tags: ['Food was great', 'Beautiful presentation'] },
]

async function main() {
  console.info('🌱 Seeding customer-experience demo data…')

  const existing = await prisma.customer.findUnique({ where: { email: SEED_MARKER_EMAIL } })
  if (existing) {
    console.info('  ✓ Already seeded — skipping. (Delete demo.power@servd.pk to re-seed.)')
    return
  }

  const concepts = await prisma.concept.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, slug: true, name: true },
    take: 8,
  })
  if (concepts.length === 0) {
    throw new Error('No active concepts found — run the main seed first.')
  }

  // ── 1. Power user — has done it all ─────────────────────────────────────
  const power = await prisma.customer.create({
    data: {
      name: 'Aisha Power',
      email: 'demo.power@servd.pk',
      phone: '+923001110001',
      marketingOptIn: true,
      birthdayMmDd: birthdayToday(),
      firstOrderAt: daysAgo(120),
      lastOrderAt:  daysAgo(2),
      totalSpentCents: 2_750_000,    // PKR 27,500 lifetime — past first milestone
      preferredConcept: { connect: { id: concepts[0]!.id } },
    },
  })

  await prisma.loyaltyAccount.upsert({
    where: { customerId: power.id },
    create: {
      customerId: power.id,
      pointsBalance: 1850,
      lifetimePoints: 4200,
      tier: 'silver',
      stampCounts: { [concepts[0]!.slug]: 8 } as object,
    },
    update: {},
  })

  // 25 completed orders — spread across concepts and time
  console.info('  · creating 25 demo orders for power user…')
  const tables = await prisma.table.findMany({ where: { conceptId: { in: concepts.map(c => c.id) } }, take: 6 })
  for (let i = 0; i < 25; i++) {
    const concept = concepts[i % concepts.length]!
    const placedAt = daysAgo(120 - Math.floor(i * (118 / 25)))
    await prisma.order.create({
      data: {
        conceptId: concept.id,
        customerId: power.id,
        customerName: power.name,
        source: 'servd',
        externalId: `demo-power-${i}`,
        status: 'completed',
        totalCents: 80000 + Math.floor(Math.random() * 60000),
        taxCents: 10000,
        placedAt,
        completedAt: new Date(placedAt.getTime() + 35 * 60_000),
        items: {
          create: [
            { name: 'Smash Double',     quantity: 1, unitPriceCents: 65000, status: 'bumped' },
            { name: 'Loaded Fries',     quantity: 1, unitPriceCents: 35000, status: 'bumped' },
          ],
        },
      },
    })
  }

  // 4 reviews on her past orders
  const reviewableOrders = await prisma.order.findMany({
    where: { customerId: power.id, status: 'completed' },
    take: 4,
    orderBy: { completedAt: 'desc' },
  })
  for (let i = 0; i < reviewableOrders.length; i++) {
    const o = reviewableOrders[i]!
    const sample = SAMPLE_REVIEW_COMMENTS[i % SAMPLE_REVIEW_COMMENTS.length]!
    await prisma.orderReview.create({
      data: {
        orderId:    o.id,
        customerId: power.id,
        conceptId:  o.conceptId,
        rating:     sample.rating,
        comment:    sample.comment,
        tags:       sample.tags,
        isPositive: sample.rating >= 4,
        source:     'storefront',
      },
    }).catch(() => { /* duplicate */ })
  }

  // 2 upcoming + 3 past reservations
  if (tables.length > 0) {
    for (let i = 0; i < 2; i++) {
      const concept = concepts[i % concepts.length]!
      const start = new Date(Date.now() + (i + 1) * 86_400_000 + 19 * 3600_000)
      await prisma.reservation.create({
        data: {
          conceptId: concept.id,
          customerId: power.id,
          partySize: 2 + i,
          startTime: start,
          endTime:   new Date(start.getTime() + 90 * 60_000),
          guestName: power.name, guestPhone: power.phone,
          source: 'website',
          status: i === 0 ? 'confirmed' : 'booked',
          confirmToken: `demo-confirm-power-${i}-${Date.now()}`,
        },
      })
    }
    for (let i = 0; i < 3; i++) {
      const concept = concepts[i % concepts.length]!
      const start = daysAgo(30 + i * 15)
      await prisma.reservation.create({
        data: {
          conceptId: concept.id,
          customerId: power.id,
          partySize: 2,
          startTime: start,
          endTime:   new Date(start.getTime() + 90 * 60_000),
          guestName: power.name, guestPhone: power.phone,
          source: 'website',
          status: 'completed',
          completedAt: new Date(start.getTime() + 90 * 60_000),
        },
      })
    }
  }

  // ── 2. New customer — 1 order, no review yet ────────────────────────────
  const newGuy = await prisma.customer.create({
    data: {
      name: 'Demo Newbie',
      email: 'demo.new@servd.pk',
      phone: '+923001110002',
      marketingOptIn: true,
      firstOrderAt: hoursAgo(3),
      lastOrderAt:  hoursAgo(3),
      totalSpentCents: 95000,
    },
  })
  await prisma.order.create({
    data: {
      conceptId: concepts[0]!.id, customerId: newGuy.id, customerName: newGuy.name,
      source: 'servd', externalId: 'demo-new-1',
      status: 'completed',
      totalCents: 95000, taxCents: 12000,
      placedAt: hoursAgo(3),
      completedAt: hoursAgo(2),
      items: { create: [{ name: 'Test Burger', quantity: 1, unitPriceCents: 95000, status: 'bumped' }] },
    },
  })

  // ── 3. Lapsed customer — for winback flow ───────────────────────────────
  const lapsed = await prisma.customer.create({
    data: {
      name: 'Demo Lapsed',
      email: 'demo.lapsed@servd.pk',
      phone: '+923001110003',
      marketingOptIn: true,
      firstOrderAt: daysAgo(180),
      lastOrderAt:  daysAgo(95),
      totalSpentCents: 480000,
    },
  })
  await prisma.order.create({
    data: {
      conceptId: concepts[0]!.id, customerId: lapsed.id, customerName: lapsed.name,
      source: 'servd', externalId: 'demo-lapsed-1',
      status: 'completed',
      totalCents: 120000, taxCents: 15000,
      placedAt: daysAgo(95),
      completedAt: daysAgo(95),
      items: { create: [{ name: 'Test Item', quantity: 1, unitPriceCents: 120000, status: 'bumped' }] },
    },
  })

  // ── 4. Complaint follow-up demo customer ────────────────────────────────
  const upset = await prisma.customer.create({
    data: {
      name: 'Demo Resolver',
      email: 'demo.resolver@servd.pk',
      phone: '+923001110004',
      marketingOptIn: true,
      firstOrderAt: daysAgo(20),
      lastOrderAt:  daysAgo(5),
      totalSpentCents: 290000,
    },
  })
  const complaintOrder = await prisma.order.create({
    data: {
      conceptId: concepts[0]!.id, customerId: upset.id, customerName: upset.name,
      source: 'servd', externalId: 'demo-resolver-1',
      status: 'completed',
      totalCents: 110000, taxCents: 14000,
      placedAt: daysAgo(5),
      completedAt: daysAgo(5),
      items: { create: [{ name: 'Test Item', quantity: 1, unitPriceCents: 110000, status: 'bumped' }] },
    },
  })
  await prisma.orderComplaint.create({
    data: {
      orderId: complaintOrder.id,
      customerId: upset.id,
      conceptId: concepts[0]!.id,
      title: 'Wrong item delivered',
      description: 'I ordered the chicken but received beef. Resolved with a free replacement.',
      category: 'wrong_item',
      status: 'resolved',
      priority: 'medium',
      resolvedAt: hoursAgo(25),               // > 24h ago — eligible for follow-up
      resolution: 'Replacement sent + 200 loyalty points credited',
    },
  })

  // ── 5. Public reviews on each concept (for /brand/<slug> page) ──────────
  console.info('  · seeding public reviews on each concept…')
  for (const concept of concepts) {
    // Need a real completed order to attach the review to.
    const placeholderOrder = await prisma.order.create({
      data: {
        conceptId: concept.id, source: 'servd',
        externalId: `demo-public-review-${concept.slug}-${Date.now()}`,
        customerName: 'Anonymous Diner',
        status: 'completed',
        totalCents: 80000, taxCents: 10000,
        placedAt: daysAgo(10), completedAt: daysAgo(10),
        items: { create: [{ name: 'Sample Item', quantity: 1, unitPriceCents: 80000, status: 'bumped' }] },
      },
    })
    const sample = SAMPLE_REVIEW_COMMENTS[Math.floor(Math.random() * SAMPLE_REVIEW_COMMENTS.length)]!
    await prisma.orderReview.create({
      data: {
        orderId: placeholderOrder.id,
        conceptId: concept.id,
        rating: sample.rating,
        comment: sample.comment,
        tags: sample.tags,
        isPositive: sample.rating >= 4,
        source: 'manual',
      },
    }).catch(() => { /* duplicate */ })
  }

  console.info('✅ Customer-experience seed complete.')
  console.info('')
  console.info('Demo customers created:')
  console.info(`  • ${power.email}     — power user, ${concepts.length}+ concepts, has reviews + reservations`)
  console.info(`  • ${newGuy.email}   — new (1h-old first order, eligible for welcome trigger)`)
  console.info(`  • ${lapsed.email} — lapsed (95 days, eligible for winback)`)
  console.info(`  • ${upset.email}— complaint resolved 25h ago (eligible for follow-up)`)
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000)
}
function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 3_600_000)
}
function birthdayToday(): string {
  const d = new Date()
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
