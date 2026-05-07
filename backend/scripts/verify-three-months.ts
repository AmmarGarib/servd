// Verify the 3-month simulation actually produced realistic, query-able data.
// Hits the same paths the dashboards use so we know the UI will render correctly.

import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient({ log: ['warn', 'error'] })

async function main() {
  console.log('\n━━━ Simulation Verification ━━━\n')

  const today = new Date(); today.setHours(23, 59, 59, 999)
  const ninetyDaysAgo = new Date(today); ninetyDaysAgo.setDate(today.getDate() - 90); ninetyDaysAgo.setHours(0, 0, 0, 0)

  // 1. Orders by brand
  const concepts = await prisma.concept.findMany({ where: { isActive: true, deletedAt: null } })
  console.log('Orders by brand (last 90 days):')
  for (const c of concepts) {
    const [count, sum] = await Promise.all([
      prisma.order.count({ where: { conceptId: c.id, placedAt: { gte: ninetyDaysAgo, lte: today }, deletedAt: null } }),
      prisma.order.aggregate({
        where: { conceptId: c.id, placedAt: { gte: ninetyDaysAgo, lte: today }, deletedAt: null, status: 'completed' },
        _sum: { totalCents: true, taxCents: true, serviceChargeCents: true },
      }),
    ])
    console.log(`  ${c.slug.padEnd(20)} ${count.toString().padStart(6)} orders · gross PKR ${((sum._sum.totalCents ?? 0) / 100).toLocaleString()}`)
  }

  // 2. Channel mix
  console.log('\nChannel mix:')
  const sources = await prisma.order.groupBy({
    by: ['source'],
    where: { placedAt: { gte: ninetyDaysAgo }, deletedAt: null },
    _count: { _all: true },
    _sum: { totalCents: true },
  })
  for (const s of sources.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${String(s.source).padEnd(15)} ${s._count._all.toString().padStart(6)} orders · PKR ${((s._sum.totalCents ?? 0) / 100).toLocaleString()}`)
  }

  // 3. Shift counts + cash variance
  const shiftCount = await prisma.shift.count({
    where: { openedAt: { gte: ninetyDaysAgo }, status: 'closed' },
  })
  console.log(`\nShifts: ${shiftCount.toLocaleString()} closed`)

  // 4. Refunds / voids / comps
  const voidedItems = await prisma.orderItem.count({ where: { voidedAt: { gte: ninetyDaysAgo } } })
  const compPayments = await prisma.payment.count({ where: { method: 'comp', processedAt: { gte: ninetyDaysAgo } } })
  const refundPayments = await prisma.payment.count({ where: { status: 'refunded', processedAt: { gte: ninetyDaysAgo } } })
  console.log(`\nException activity:`)
  console.log(`  Voided items:    ${voidedItems}`)
  console.log(`  Comp payments:   ${compPayments}`)
  console.log(`  Refund payments: ${refundPayments}`)

  // 5. Supplier bills + payments
  const billCount = await prisma.supplierBill.count({ where: { billDate: { gte: ninetyDaysAgo } } })
  const paymentCount = await prisma.supplierPayment.count({ where: { paymentDate: { gte: ninetyDaysAgo } } })
  console.log(`\nProcurement:`)
  console.log(`  Bills posted:    ${billCount}`)
  console.log(`  Payments made:   ${paymentCount}`)

  // 6. Reservations
  const resvCount = await prisma.reservation.count({ where: { startTime: { gte: ninetyDaysAgo } } })
  console.log(`\nReservations: ${resvCount}`)

  // 7. Journal entries (proves accounting posted)
  const jeCount = await prisma.journalEntry.count({ where: { entryDate: { gte: ninetyDaysAgo } } })
  console.log(`\nJournal entries posted: ${jeCount.toLocaleString()}`)

  // 8. Daily aggregate sanity (last 7 days)
  console.log(`\nLast 7 days (gross PKR):`)
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i); d.setHours(0,0,0,0)
    const next = new Date(d); next.setDate(next.getDate() + 1)
    const sum = await prisma.order.aggregate({
      where: { placedAt: { gte: d, lt: next }, status: 'completed', deletedAt: null },
      _sum: { totalCents: true },
      _count: { _all: true },
    })
    console.log(`  ${d.toISOString().slice(0,10)}  ${(sum._count._all ?? 0).toString().padStart(4)} orders · PKR ${((sum._sum.totalCents ?? 0) / 100).toLocaleString()}`)
  }

  // 9. Top items
  console.log(`\nTop 10 items by quantity:`)
  const topItems = await prisma.$queryRaw<Array<{ name: string; qty: bigint; revenue: bigint }>>`
    SELECT name, SUM(quantity)::bigint AS qty, SUM("unitPriceCents" * quantity)::bigint AS revenue
    FROM order_items
    WHERE "createdAt" >= ${ninetyDaysAgo}
    GROUP BY name
    ORDER BY qty DESC
    LIMIT 10
  `
  for (const r of topItems) {
    console.log(`  ${r.name.padEnd(40)} ${r.qty.toString().padStart(5)} sold · PKR ${(Number(r.revenue) / 100).toLocaleString()}`)
  }

  console.log('\n━━━ All systems exercised ━━━\n')
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
