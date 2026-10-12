// Vitest setup. Each test run starts with a clean schema (`prisma migrate
// reset --force --skip-seed`) and a freshly seeded chart of accounts. The
// suite assumes DATABASE_URL points at a disposable test database.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

  // Build the schema straight from schema.prisma rather than replaying the
  // migration history.
  //
  // `migrate reset` cannot run against an empty database any more. Two data
  // migrations — 20260529103000_seed_simmer_menu_items_v2 and
  // 20260529120000_seed_stax_flipd_menus — INSERT menu rows against hardcoded
  // PRODUCTION concept and category UUIDs. They carry a `WHERE NOT EXISTS`
  // guard on the item name, which makes them idempotent, but nothing checks
  // that the concept exists at all, so on a fresh database every insert trips
  // the menu_items -> concepts foreign key and the whole reset aborts. That
  // took the entire suite down with it.
  //
  // Those files are NOT edited here on purpose: they are already applied in
  // production, and changing an applied migration's contents changes its
  // checksum, which makes the next `migrate deploy` on the box refuse to run.
  // The test database wants the CURRENT schema, not a history lesson, so it
  // gets `db push` instead. (The migration history still can't rebuild a
  // database from scratch — that's a real disaster-recovery gap, and fixing it
  // means a new migration that repairs the old ones, not an edit in place.)
  execSync('pnpm exec prisma db push --force-reset --skip-generate --accept-data-loss', {
    stdio: 'inherit',
    env: process.env,
  })

  const prisma = new PrismaClient()
  globalThis.__TEST_PRISMA__ = prisma

  // `db push` builds only what schema.prisma can express. The raw-SQL objects
  // production has (0_init's last section: the reservations no-overlap
  // exclusion constraint and the recipe-ingredient one-source check, plus the
  // btree_gist extension the first needs) are applied here, read straight
  // from the migration so there is one copy of the SQL. Without them the
  // race-proof booking tests ran against a table that allowed double bookings.
  await applyRawSqlObjects(prisma)

  // Seed only the accounts we need for posting tests — not the full demo data
  await seedTestAccounts(prisma)
}, 60_000)

afterAll(async () => {
  await globalThis.__TEST_PRISMA__?.$disconnect()
})

async function applyRawSqlObjects(prisma: PrismaClient): Promise<void> {
  const sql = readFileSync(new URL('../prisma/migrations/0_init/migration.sql', import.meta.url), 'utf8')
  const marker = sql.indexOf('-- ─── Raw-SQL objects')
  if (marker === -1) throw new Error('0_init: raw-SQL section not found — update tests/setup.ts')
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS btree_gist')
  const statements = sql.slice(marker)
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean)
  for (const statement of statements) await prisma.$executeRawUnsafe(statement)
  // Partial unique indexes that live only in later migrations (db push can't
  // express them). Keep in step with the migration that creates each one.
  // 20261010210100_pos_connector — at most one live card-machine charge per order.
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "terminal_charges_one_active_per_order" ON "terminal_charges" ("orderId")
    WHERE "kind" = 'charge' AND "status" IN ('pending','sent','approved','cancel_requested','unknown')`)
}

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
  // `accounts.code` stopped being globally unique when the ledger went
  // per-company (migration 20260908120000) — it is `@@unique([tenantId, code])`
  // now. This upsert still keyed on `code` alone, so it had been failing at
  // argument validation ever since, taking every suite down in beforeAll.
  //
  // These rows are the company-less chart the posting tests fall back on, so
  // tenantId stays null and the composite key is (null, code). Prisma cannot
  // match a null inside a compound unique via upsert, so it's find-then-create.
  for (const a of accounts) {
    const existing = await prisma.account.findFirst({
      where: { tenantId: null, code: a.code },
      select: { id: true },
    })
    if (!existing) {
      await prisma.account.create({ data: { ...a, isActive: true } })
    }
  }
}
