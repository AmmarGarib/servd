/**
 * Backfill `fulfilmentType` on existing orders. Idempotent.
 *
 *   tableId set                          → dine_in
 *   source in (foodpanda, careem)        → delivery
 *   source = pos, no tableId             → takeout
 *   source in (servd, cart), no tableId  → takeout (storefront default)
 *   else                                 → dine_in (safest plating default)
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  // All four cases via raw SQL — fastest, and the new column already has a
  // default so nothing breaks if we don't hit every row.
  const dineIn = await prisma.$executeRawUnsafe(`
    UPDATE orders
    SET "fulfilmentType" = 'dine_in'
    WHERE "tableId" IS NOT NULL
  `)
  const delivery = await prisma.$executeRawUnsafe(`
    UPDATE orders
    SET "fulfilmentType" = 'delivery'
    WHERE "tableId" IS NULL AND source IN ('foodpanda', 'careem')
  `)
  const takeout = await prisma.$executeRawUnsafe(`
    UPDATE orders
    SET "fulfilmentType" = 'takeout'
    WHERE "tableId" IS NULL AND source IN ('pos', 'servd', 'cart')
  `)
  console.log(`Backfill complete:`)
  console.log(`  dine_in   → ${dineIn} rows`)
  console.log(`  delivery  → ${delivery} rows`)
  console.log(`  takeout   → ${takeout} rows`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
