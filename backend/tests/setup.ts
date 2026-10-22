// Vitest setup. Each test file starts with a clean schema (`prisma db push
// --force-reset`, below, plus the raw-SQL objects of the migrations) and a
// freshly seeded company-less chart of accounts. The suite assumes
// DATABASE_URL points at a disposable test database.

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

  // Loyalty is PAUSED on live while the owner decides (lib/loyaltyPause.ts; absent = paused).
  // The suite tests the loyalty engine itself, so it runs with loyalty ON; the pause has its
  // own test (tests/loyaltyPause.test.ts), which switches it off again.
  await prisma.setting.upsert({ where: { key: 'loyalty.paused' }, create: { key: 'loyalty.paused', value: '{"paused":false}' }, update: { value: '{"paused":false}' } })
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
  // Inter-company asset transfers (2026-10-21): ic_source_chk gains 'asset_transfer'.
  await prisma.$executeRawUnsafe('ALTER TABLE "intercompany_transfers" DROP CONSTRAINT IF EXISTS "ic_source_chk"')
  for (const statement of migrationSection('20261021160000_ic_asset_transfer',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // Head office (D1/D3): the partial uniques head_office_links_one_live and
  // recharge_runs_one_open, and every CHECK of the new tables — read from the
  // migration's SQL-only section (RLS stays out, as above).
  for (const statement of migrationSection('20261015120000_head_office',
    '-- ─── SQL-only objects', '-- ─── Row-level security')) await applyIdempotent(prisma, statement)
  // On-account resume: one live statement per client and period
  // (receivable_invoices_one_statement_per_period).
  for (const statement of migrationSection('20261015120100_on_account_resume',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // Servd-wide bans (2026-10-15): one active auto ban per CUSTOMER replaces the per-company index.
  await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "customer_bans_one_active_auto_per_company"')
  for (const statement of migrationSection('20261015150000_bans_servd_wide',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // Cash vouchers (2026-10-15): cash_vouchers_discount_chk (amount paid = gross − discount).
  for (const statement of migrationSection('20261015140000_petty_cash_expense_vouchers',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // Cash vouchers paid from cash on hand / a bank (2026-10-16): cash_vouchers_pay_source_chk.
  for (const statement of migrationSection('20261016160000_voucher_pay_source',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // "To pay from" (2026-10-19): the pay-source CHECK learns 'credit' — drop the old one, then the migration's.
  await prisma.$executeRawUnsafe('ALTER TABLE "cash_vouchers" DROP CONSTRAINT IF EXISTS "cash_vouchers_pay_source_chk"')
  for (const statement of migrationSection('20261019110000_voucher_pay_from',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // Classification chosen at raise (2026-10-20): cash_vouchers_planned_classification_chk.
  for (const statement of migrationSection('20261020130000_voucher_planned_classification',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // Deposit slips as files (2026-10-16): the attachment owner check takes a
  // deposit drop too — drop wave B's version, then the migration's.
  await prisma.$executeRawUnsafe('ALTER TABLE "cash_voucher_attachments" DROP CONSTRAINT IF EXISTS "cash_voucher_attachments_owner_chk"')
  for (const statement of migrationSection('20261016200000_deposit_drop_attachments',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // Record files (2026-10-16): any record can own files (ownerType + ownerId)
  // — drop the deposit-drop version of the owner check, then the migration's.
  await prisma.$executeRawUnsafe('ALTER TABLE "cash_voucher_attachments" DROP CONSTRAINT IF EXISTS "cash_voucher_attachments_owner_chk"')
  for (const statement of migrationSection('20261016210000_record_files',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // Night audit (2026-10-16, sales only): the night_audit_days CHECKs (an
  // audited / closed day names its auditor, an override names its reason)
  // and the start-day format — the migration's SQL-only section (RLS out).
  for (const statement of migrationSection('20261016120000_night_audit',
    '-- ─── SQL-only objects', '-- ─── Row-level security')) await applyIdempotent(prisma, statement)
  // The bell (2026-10-16): the unread partial index, the link / severity /
  // length CHECKs and the unannounced-flags index (migration 20261016140000).
  for (const statement of migrationSection('20261016140000_notifications',
    '-- ─── SQL-only objects', '-- ─── Row-level security')) await applyIdempotent(prisma, statement)
  // Payment classification (2026-10-20): the classification / tax-status / reason CHECKs.
  for (const statement of migrationSection('20261020100000_payment_classification',
    '-- ─── SQL-only objects', '-- ─── Row-level security')) await applyIdempotent(prisma, statement)
  // Shift corrections (2026-10-21): one open set per shift, the reason / tender CHECKs.
  for (const statement of migrationSection('20261021100000_shift_corrections',
    '-- ─── SQL-only objects', '-- ─── Row-level security')) await applyIdempotent(prisma, statement)
  // Void & re-issue (2026-10-21): the tender-reference and no-food / no-money-returned CHECKs.
  for (const statement of migrationSection('20261021140000_shift_correction_reissue',
    '-- ─── SQL-only objects')) await applyIdempotent(prisma, statement)
  // The Trash bin (2026-10-15): one OPEN entry per thing, and promo codes /
  // allocation rules unique over LIVE rows only (migration 20261015170000).
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "trash_entries_open_key" ON "trash_entries"("entityType", "entityId") WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL`)
  await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "promo_codes_tenantId_code_key"')
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_tenant_code_live_key" ON "promo_codes"("tenantId", "code") WHERE "deletedAt" IS NULL`)
  await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "cost_allocation_rules_tenantId_sourceAccountCode_key"')
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "cost_allocation_rules_tenant_source_live_key" ON "cost_allocation_rules"("tenantId", "sourceAccountCode") WHERE "deletedAt" IS NULL`)
}

/**
 * The company-less chart: every template code of CHART_OF_ACCOUNTS (the one
 * list — a code added there is seeded here too, never a hand-kept copy that
 * drifts). The ledger is per company: postJournalEntry resolves codes inside
 * the posting company's chart, so a test company gets its own chart from
 * ensureChartOfAccounts(tenantId) (the same template, every code, with
 * controlledBy on the register's codes) — that is the helper every test
 * company uses, here or through tests/connectorsFixtures.ts.
 *
 * These rows carry no controlledBy: a controlled account must belong to a
 * company (CHECK accounts_controlled_company_chk, applied above).
 */
async function seedTestAccounts(prisma: PrismaClient): Promise<void> {
  // `accounts.code` stopped being globally unique when the ledger went
  // per-company (migration 20260908120000) — it is `@@unique([tenantId, code])`
  // now, and Prisma cannot match a null inside a compound unique via upsert
  // (nor does Postgres treat two nulls as a duplicate for skipDuplicates), so
  // it's find-then-create: only the codes not already there.
  const have = new Set((await prisma.account.findMany({
    where: { tenantId: null },
    select: { code: true },
  })).map((a) => a.code))
  await prisma.account.createMany({
    data: CHART_OF_ACCOUNTS.filter((a) => !have.has(a.code)).map((a) => ({
      code: a.code,
      name: a.name,
      type: a.type,
      description: a.description ?? null,
      isActive: true,
    })),
  })
}
