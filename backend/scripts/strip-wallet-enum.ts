/**
 * F-PAY02: backfill any existing jazzcash_wallet / easypaisa_wallet payment
 * rows to `card`, so the enum drop in schema.prisma doesn't blow up on the
 * Prisma push. Idempotent — safe to run before every schema change.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const result = await prisma.$executeRawUnsafe(
    `UPDATE payments SET method = 'card' WHERE method IN ('jazzcash_wallet', 'easypaisa_wallet')`,
  )
  console.log(`Backfilled ${result} payment row(s) wallet → card`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
