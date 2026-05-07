// Vitest setup. Each test run starts with a clean schema (`prisma migrate
// reset --force --skip-seed`) and a freshly seeded chart of accounts. The
// suite assumes DATABASE_URL points at a disposable test database.

import { execSync } from 'node:child_process'
import { beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

declare global {
  // eslint-disable-next-line no-var
  var __TEST_PRISMA__: PrismaClient | undefined
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes('test')) {
    throw new Error(`Refusing to run tests against non-test DATABASE_URL: ${process.env.DATABASE_URL}`)
  }

  // Reset + apply migrations on the test DB
  execSync('pnpm exec prisma migrate reset --force --skip-seed', {
    stdio: 'inherit',
    env: process.env,
  })

  const prisma = new PrismaClient()
  globalThis.__TEST_PRISMA__ = prisma

  // Seed only the accounts we need for posting tests — not the full demo data
  await seedTestAccounts(prisma)
}, 60_000)

afterAll(async () => {
  await globalThis.__TEST_PRISMA__?.$disconnect()
})

async function seedTestAccounts(prisma: PrismaClient): Promise<void> {
  const accounts: Array<{ code: string; name: string; type: 'asset'|'liability'|'equity'|'revenue'|'expense' }> = [
    { code: '1010', name: 'Cash on Hand',                       type: 'asset' },
    { code: '1015', name: 'Cash in POS Drawer',                 type: 'asset' },
    { code: '1020', name: 'Bank',                               type: 'asset' },
    { code: '1030', name: 'Card / Gateway Receivable',          type: 'asset' },
    { code: '1110', name: 'Customer AR',                        type: 'asset' },
    { code: '1120', name: 'Foodpanda AR',                       type: 'asset' },
    { code: '1210', name: 'Inventory — Food',                   type: 'asset' },
    { code: '1320', name: 'GST Input',                          type: 'asset' },
    { code: '2010', name: 'AP Suppliers',                       type: 'liability' },
    { code: '2020', name: 'Wages Payable',                      type: 'liability' },
    { code: '2030', name: 'GST Output',                         type: 'liability' },
    { code: '2050', name: 'Wallet Liability',                   type: 'liability' },
    { code: '2060', name: 'Loyalty Liability',                  type: 'liability' },
    { code: '2095', name: 'Tips Payable',                       type: 'liability' },
    { code: '4001', name: 'Revenue — Simmer',                   type: 'revenue' },
    { code: '4002', name: 'Revenue — Stax',                     type: 'revenue' },
    { code: '4090', name: 'Revenue — Other',                    type: 'revenue' },
    { code: '4100', name: 'Service Charges',                    type: 'revenue' },
    { code: '5010', name: 'Food Cost',                          type: 'expense' },
    { code: '5040', name: 'Waste',                              type: 'expense' },
    { code: '6030', name: 'Wages — Kitchen',                    type: 'expense' },
    { code: '6060', name: 'Marketing & Promo',                  type: 'expense' },
    { code: '6090', name: 'Foodpanda Commission',               type: 'expense' },
    { code: '7010', name: 'Discounts',                          type: 'expense' },
    { code: '7020', name: 'Loyalty Redemptions',                type: 'expense' },
    { code: '7040', name: 'Refunds',                            type: 'expense' },
    { code: '8010', name: 'Cash Variance',                      type: 'expense' },
  ]
  for (const a of accounts) {
    await prisma.account.upsert({
      where: { code: a.code },
      create: { ...a, isActive: true },
      update: {},
    })
  }
}
