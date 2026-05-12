/**
 * B03: de-duplicate FinancialEntry rows before applying the new unique
 * constraint on orderId. Keeps the oldest entry per order (financial
 * accuracy: the first one captured the correct commission rate at the
 * time of completion). Subsequent duplicates were ledger noise.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  // Prisma maps the model to the snake_case table `financial_entries` but
  // keeps the column casing from the schema (`orderId`). Quote it to bypass
  // Postgres's lowercasing.
  const result = await prisma.$executeRawUnsafe(`
    DELETE FROM financial_entries fe
    USING financial_entries fe2
    WHERE fe.id > fe2.id
      AND fe."orderId" = fe2."orderId"
  `)
  console.log(`Removed ${result} duplicate financial entries`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
