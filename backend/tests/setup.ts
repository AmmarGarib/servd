// Vitest setup. Each test run starts with a clean schema (`prisma migrate
// reset --force --skip-seed`) and a freshly seeded chart of accounts. The
// suite assumes DATABASE_URL points at a disposable test database.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { CHART_OF_ACCOUNTS } from '../src/lib/chartOfAccounts.js'

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
  // btree_gist extension the first needs; finance wave B's partial uniques,
  // composite foreign key and CHECKs) are applied here, read straight from
  // the migrations so there is one copy of the SQL. Without them the
  // race-proof booking tests ran against a table that allowed double bookings.
  await applyRawSqlObjects(prisma)

  // The company-less chart (see seedTestAccounts) — not the full demo data.
  await seedTestAccounts(prisma)
}, 60_000)

afterAll(async () => {
  await globalThis.__TEST_PRISMA__?.$disconnect()
})

/**
 * The statements of one marked section of a migration file: from the line
 * starting `from` up to the line starting `to` (or the end of the file),
 * full-line comments dropped, split on ';'. A section read this way must hold
 * no ';' inside a statement and no trailing comments — the migration says so
 * next to its marker.
 */
function migrationSection(migration: string, from: string, to?: string): string[] {
  const sql = readFileSync(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8')
  const start = sql.indexOf(from)
  if (start === -1) throw new Error(`${migration}: marker '${from}' not found — update tests/setup.ts`)
  const end = to === undefined ? sql.length : sql.indexOf(to, start)
  if (end === -1) throw new Error(`${migration}: marker '${to}' not found after '${from}' — update tests/setup.ts`)
  return sql.slice(start, end)
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean)
}

/**
 * Run one raw-SQL object statement so that running it twice is harmless: an
 * index gets IF NOT EXISTS, a constraint already on its table is skipped.
 * Only those two shapes are accepted — anything else in a section means the
 * section changed shape, and this helper has to learn it first.
 */
async function applyIdempotent(prisma: PrismaClient, statement: string): Promise<void> {
  const index = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i.exec(statement)
  if (index) {
    await prisma.$executeRawUnsafe(`CREATE ${index[1] ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${statement.slice(index[0].length)}`)
    return
  }
  const constraint = /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"/i.exec(statement)
  if (constraint) {
    const [, table, name] = constraint
    const found = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT 1 AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = ${table} AND t.relnamespace = current_schema()::regnamespace AND c.conname = ${name}`
    if (found.length === 0) await prisma.$executeRawUnsafe(statement)
    return
  }
  throw new Error(`tests/setup.ts: unexpected raw-SQL statement shape: ${statement.slice(0, 120)}`)
}

async function applyRawSqlObjects(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS btree_gist')
  for (const statement of migrationSection('0_init', '-- ─── Raw-SQL objects')) await applyIdempotent(prisma, statement)
  // Finance wave B: the partial / expression unique indexes, the fleet-rate
  // composite foreign key and the CHECK constraints (plan sections 5 and 6)
  // — everything between the migration's SQL-only marker and its row-level
  // security marker. (RLS stays out: the test database has no RLS helpers,
  // and the migration's own DO block skips itself without them.)
  for (const statement of migrationSection('20261014090000_finance_wave_b',
    '-- ─── SQL-only objects', '-- ─── Row-level security')) await applyIdempotent(prisma, statement)
  // Partial unique indexes that live only in later migrations (db push can't
  // express them). Keep in step with the migration that creates each one.
  // 20261010210100_pos_connector — at most one live card-machine charge per order.
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "terminal_charges_one_active_per_order" ON "terminal_charges" ("orderId")
    WHERE "kind" = 'charge' AND "status" IN ('pending','sent','approved','cancel_requested','unknown')`)
  // 20261013090100_raast_tender — one awaiting Raast intent per order; one
  // default Raast receiving account per company.
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "raast_receipts_one_awaiting_per_order" ON "raast_receipts" ("orderId") WHERE "status" = 'awaiting'`)
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "bank_accounts_one_raast_default_per_company" ON "bank_accounts" ("tenantId") WHERE "raastDefault" = true AND "deletedAt" IS NULL`)
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
