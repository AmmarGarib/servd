// Nuke every order + its dependent rows.
// Use case: dev DB drowning in seeded/test orders. After this runs:
//   - Order table empty
//   - Every row that FK'd to an Order is gone
//   - Customer rollups (totalSpent / loyaltyPoints / totalOrders) NOT
//     reset; if you want those zeroed too, run with --reset-customers
//
// Usage:
//   npx tsx scripts/wipe-orders.ts                # wipe orders + deps
//   npx tsx scripts/wipe-orders.ts --reset-customers
//   npx tsx scripts/wipe-orders.ts --dry-run      # count only

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const resetCustomers = args.has('--reset-customers')

async function main() {
  const counts = {
    orders: await prisma.order.count(),
    orderItems: await prisma.orderItem.count(),
    orderItemModifiers: await prisma.orderItemModifier.count(),
    orderItemSteps: await prisma.orderItemStep.count(),
    orderReviews: await prisma.orderReview.count(),
    orderComplaints: await prisma.orderComplaint.count(),
    payments: await prisma.payment.count(),
    taxInvoices: await prisma.taxInvoice.count(),
    riderRatings: await prisma.riderRating.count(),
    riderLocations: await prisma.riderLocation.count(),
    promoUsages: await prisma.promoCodeUsage.count(),
    walletTxs: await prisma.walletTransaction.count(),
    loyaltyTxs: await prisma.loyaltyTransaction.count(),
    giftRedemptions: await prisma.giftCardRedemption.count(),
    financialEntries: await prisma.financialEntry.count(),
    groupOrders: await prisma.groupOrder.count(),
    groupOrderItems: await prisma.groupOrderItem.count(),
    groupOrderMembers: await prisma.groupOrderMember.count(),
  }

  console.log('Current row counts:')
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`)

  if (dryRun) {
    console.log('\n[dry-run] no changes made')
    return
  }

  console.log('\nWiping…')

  // Order matters: drop leaves first, work up to Order. All in one tx so
  // a failure leaves the DB consistent. Using deleteMany (no where) on
  // each is faster than a single nested cascade in Prisma.
  await prisma.$transaction([
    // OrderItem children
    prisma.orderItemModifier.deleteMany({}),
    prisma.orderItemStep.deleteMany({}),

    // Order children — required orderId: drop everything
    prisma.orderReview.deleteMany({}),
    prisma.payment.deleteMany({}),
    prisma.taxInvoice.deleteMany({}),
    prisma.riderRating.deleteMany({}),
    prisma.promoCodeUsage.deleteMany({}),
    prisma.financialEntry.deleteMany({}),

    // Nullable orderId: drop only rows tied to an order, preserve
    // standalone rows (manual loyalty adjustments, wallet top-ups,
    // brand-level complaints, gift card redemptions on draft carts, etc).
    prisma.orderComplaint.deleteMany({ where: { orderId: { not: null } } }),
    prisma.riderLocation.deleteMany({ where: { orderId: { not: null } } }),
    prisma.walletTransaction.deleteMany({ where: { orderId: { not: null } } }),
    prisma.loyaltyTransaction.deleteMany({ where: { orderId: { not: null } } }),
    prisma.giftCardRedemption.deleteMany({ where: { orderId: { not: null } } }),

    // GroupOrder graph (members → items → group)
    prisma.groupOrderItem.deleteMany({}),
    prisma.groupOrderMember.deleteMany({}),
    prisma.groupOrder.deleteMany({}),

    // Now safe to drop items, then the order
    prisma.orderItem.deleteMany({}),
    prisma.order.deleteMany({}),
  ])

  if (resetCustomers) {
    console.log('Resetting customer order rollups (totalSpent / totalOrders / loyaltyPoints)…')
    await prisma.customer.updateMany({
      data: {
        totalSpent: 0,
        totalOrders: 0,
        loyaltyPoints: 0,
        lastOrderAt: null,
      },
    })
  }

  const after = await prisma.order.count()
  console.log(`\n✅ done — Order rows remaining: ${after}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
