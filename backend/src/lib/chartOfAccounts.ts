// The standard chart of accounts, and the guarantee that every company has one.
//
// Each company keeps its OWN chart (Account.tenantId; code unique per company),
// so a new company must get a full set of accounts before anything can post —
// otherwise the first order fails with "chart of accounts is missing code 4001".
// `ensureChartOfAccounts` is called at boot for every company and again when a
// company is created, and is a cheap no-op once the chart exists.
//
// Numbering convention:
//   1xxx assets · 2xxx liabilities · 3xxx equity · 4xxx revenue
//   5xxx COGS · 6xxx operating expenses · 7xxx contra-revenue
//   8xxx other (variances, FX)
//
// This is the STARTING chart. Operators add their own accounts from
// Configuration → Chart of accounts; those are never touched by this file.

import type { AccountType } from '@prisma/client'
import { serviceClient as prisma } from './prisma.js'
import { sumCents } from './money.js'

export interface AccountTemplate {
  code: string
  name: string
  type: AccountType
  description?: string
}

export const CHART_OF_ACCOUNTS: AccountTemplate[] = [
  // ── Assets ────────────────────────────────────────────────────────────
  { code: '1010', name: 'Cash on Hand',                       type: 'asset',     description: 'Petty cash / safe' },
  { code: '1015', name: 'Cash in POS Drawer',                 type: 'asset',     description: 'Open-shift drawer floats and takings before deposit' },
  { code: '1020', name: 'Bank — Operating Account',           type: 'asset' },
  { code: '1030', name: 'Card / Gateway Receivable',          type: 'asset',     description: 'Keenu / JazzCash / Easypaisa awaiting settlement' },
  { code: '1110', name: 'Customer Accounts Receivable',       type: 'asset' },
  { code: '1210', name: 'Inventory — Food',                   type: 'asset' },
  { code: '1220', name: 'Inventory — Beverage',               type: 'asset' },
  { code: '1230', name: 'Inventory — Packaging',              type: 'asset' },
  { code: '1310', name: 'Prepaid Expenses',                   type: 'asset' },
  { code: '1320', name: 'GST Input (Recoverable)',            type: 'asset',     description: 'Federal sales tax (FBR) recoverable on supplier purchases — offsets 2030' },
  { code: '1321', name: 'PRA Sales Tax Input',                type: 'asset',     description: 'Punjab Revenue Authority sales tax on services — recoverable, Punjab outlets only' },
  { code: '1322', name: 'SRB Sales Tax Input',                type: 'asset',     description: 'Sindh Revenue Board sales tax — Sindh outlets only' },
  { code: '1323', name: 'KPRA Sales Tax Input',               type: 'asset',     description: 'KP Revenue Authority sales tax — KP outlets only' },
  { code: '1324', name: 'BRA Sales Tax Input',                type: 'asset',     description: 'Balochistan Revenue Authority sales tax — Balochistan outlets only' },
  { code: '1330', name: 'Income Tax (WHT) Receivable',        type: 'asset',     description: 'Income tax withheld at source by clients/platforms' },
  { code: '1340', name: 'Advances to Suppliers',              type: 'asset',     description: 'Payments made before goods received' },
  { code: '1350', name: 'Staff Loans & Advances',             type: 'asset',     description: 'HR loans paid to employees, recovered through payroll' },
  { code: '1510', name: 'Kitchen Equipment',                  type: 'asset' },
  { code: '1520', name: 'Furniture & Fixtures',               type: 'asset' },
  { code: '1530', name: 'IT Equipment',                       type: 'asset' },
  { code: '1540', name: 'Vehicles',                           type: 'asset' },
  { code: '1550', name: 'Leasehold Improvements',             type: 'asset',     description: 'Fit-out of rented premises' },
  { code: '1590', name: 'Accumulated Depreciation',           type: 'asset',     description: 'Contra-asset' },

  // ── Liabilities ───────────────────────────────────────────────────────
  { code: '2010', name: 'Accounts Payable — Suppliers',       type: 'liability' },
  { code: '2020', name: 'Wages Payable',                      type: 'liability' },
  { code: '2030', name: 'GST Output (Payable to FBR)',        type: 'liability', description: 'Federal sales tax collected on sales — owed to FBR' },
  { code: '2031', name: 'PRA Sales Tax Output',               type: 'liability', description: 'Punjab service-sector sales tax collected' },
  { code: '2032', name: 'SRB Sales Tax Output',               type: 'liability', description: 'Sindh service-sector sales tax' },
  { code: '2033', name: 'KPRA Sales Tax Output',              type: 'liability', description: 'KP service-sector sales tax' },
  { code: '2034', name: 'BRA Sales Tax Output',               type: 'liability', description: 'Balochistan service-sector sales tax' },
  { code: '2040', name: 'Income Tax Withholding Payable',     type: 'liability', description: 'WHT deducted from supplier payments — owed to FBR' },
  { code: '2041', name: 'Sales Tax Withholding Payable',      type: 'liability', description: 'STWH where we are the withholding agent' },
  { code: '2050', name: 'Customer Wallet Liability',          type: 'liability', description: 'Funds customers have loaded but not spent' },
  { code: '2060', name: 'Loyalty Points Liability',           type: 'liability', description: 'Accrued unredeemed loyalty points (breakage)' },
  { code: '2080', name: 'Gift Card Liability',                type: 'liability' },
  { code: '2090', name: 'Accrued Expenses',                   type: 'liability' },
  { code: '2095', name: 'Tips Payable to Staff',              type: 'liability', description: 'Customer-discretionary tips received, owed to staff' },

  // ── Equity ────────────────────────────────────────────────────────────
  { code: '3010', name: "Owner's Capital",                    type: 'equity' },
  { code: '3020', name: 'Retained Earnings',                  type: 'equity' },
  { code: '3030', name: "Owner's Drawings",                   type: 'equity' },

  // ── Revenue (per brand — see CONCEPT_REVENUE_CODE in accounting/journal.ts) ──
  { code: '4001', name: 'Revenue — Simmer',                   type: 'revenue' },
  // Stax was renamed Stackd (2026-09-09). Existing charts are renamed by
  // migration 20261010150200 where the name was still the old default. 4006
  // stays "Stax @ Padel" — a separate business that kept its name.
  { code: '4002', name: 'Revenue — Stackd',                   type: 'revenue' },
  { code: '4003', name: 'Revenue — Strata',                   type: 'revenue' },
  { code: '4004', name: 'Revenue — Flipd',                    type: 'revenue' },
  { code: '4005', name: 'Revenue — Garnish Station',          type: 'revenue' },
  { code: '4006', name: 'Revenue — Stax @ Padel',             type: 'revenue' },
  { code: '4007', name: 'Revenue — Bukhari',                  type: 'revenue' },
  { code: '4090', name: 'Revenue — Other / Catering',         type: 'revenue' },
  { code: '4100', name: 'Service Charges',                    type: 'revenue' },

  // ── COGS ──────────────────────────────────────────────────────────────
  { code: '5010', name: 'Food Cost',                          type: 'expense' },
  { code: '5020', name: 'Beverage Cost',                      type: 'expense' },
  { code: '5030', name: 'Packaging Cost',                     type: 'expense' },
  { code: '5040', name: 'Waste / Spoilage',                   type: 'expense' },
  { code: '5050', name: 'Inventory Variance',                 type: 'expense' },
  { code: '5060', name: 'Inventory Cost Adjustment',          type: 'expense' },

  // ── Operating expenses ────────────────────────────────────────────────
  { code: '6010', name: 'Rent',                               type: 'expense' },
  { code: '6020', name: 'Electricity',                        type: 'expense' },
  { code: '6021', name: 'Gas',                                type: 'expense' },
  { code: '6022', name: 'Internet & Telecom',                 type: 'expense' },
  { code: '6023', name: 'Water',                              type: 'expense' },
  { code: '6030', name: 'Wages — Kitchen',                    type: 'expense' },
  { code: '6031', name: 'Wages — Front of House',             type: 'expense' },
  { code: '6032', name: 'Wages — Management',                 type: 'expense' },
  { code: '6035', name: 'Wages — Riders / Delivery',          type: 'expense' },
  { code: '6040', name: 'Cleaning & Supplies',                type: 'expense' },
  { code: '6050', name: 'Repairs & Maintenance',              type: 'expense' },
  { code: '6060', name: 'Marketing & Promo',                  type: 'expense' },
  { code: '6070', name: 'Software & Subscriptions',           type: 'expense' },
  { code: '6080', name: 'Bank / Card Processing Fees',        type: 'expense' },
  { code: '6081', name: 'Bank Charges (Misc)',                type: 'expense' },
  { code: '6100', name: 'Insurance',                          type: 'expense' },
  { code: '6110', name: 'Professional Fees (Legal/Accounting)', type: 'expense' },
  { code: '6120', name: 'Licences & Permits',                 type: 'expense' },
  { code: '6130', name: 'Property Taxes',                     type: 'expense' },
  { code: '6140', name: 'Travel & Entertainment',             type: 'expense' },
  { code: '6150', name: 'Depreciation Expense',               type: 'expense' },

  // ── Contra-revenue ────────────────────────────────────────────────────
  { code: '7010', name: 'Discounts Given',                    type: 'expense' },
  { code: '7020', name: 'Loyalty Redemptions',                type: 'expense' },
  { code: '7030', name: 'Comps & Promo Items',                type: 'expense' },
  { code: '7040', name: 'Refunds Issued',                     type: 'expense' },

  // ── Other ─────────────────────────────────────────────────────────────
  { code: '8010', name: 'Cash Variance (Over / Short)',       type: 'expense' },
  { code: '8020', name: 'Foreign Exchange Gain / Loss',       type: 'expense' },
  { code: '8030', name: 'Gain / Loss on Asset Disposal',      type: 'expense',   description: 'Proceeds less book value when equipment is sold or scrapped' },
]

/** Codes the posting engine cannot run without — checked by /health. */
export const REQUIRED_ACCOUNT_CODES = [
  '1010', '1015', '1020', '1030', '1210', '1320',
  '2010', '2020', '2030', '2050', '2060', '2095',
  '4001', '4090', '4100',
  // 5050: stock counts post their variance here (crosschecks/countPosting.ts).
  '5010', '5040', '5050',
  '6030', '6080',
  '7010', '7040',
  '8010',
]

/**
 * Make sure `tenantId` has a chart of accounts. Adds only the codes it is
 * missing, so an operator's edits (renamed accounts, extra accounts,
 * deactivated ones) survive — this never overwrites an existing row.
 * Returns how many accounts were added.
 */
export async function ensureChartOfAccounts(tenantId: string): Promise<number> {
  const existing = await prisma.account.findMany({
    where: { tenantId },
    select: { code: true },
  })
  const have = new Set(existing.map((a) => a.code))
  const missing = CHART_OF_ACCOUNTS.filter((a) => !have.has(a.code))
  if (missing.length === 0) return 0

  await prisma.account.createMany({
    data: missing.map((a) => ({
      tenantId,
      code: a.code,
      name: a.name,
      type: a.type,
      description: a.description ?? null,
      isActive: true,
    })),
    skipDuplicates: true,
  })
  return missing.length
}

/**
 * Accounts the old demo seed (prisma/seed.ts) created that are not in the
 * chart above: third-party delivery aggregator accounts, which servd will
 * never use. Matched on code AND the seeded name, so an operator who reused
 * one of these codes for an account of their own is never touched.
 */
export const RETIRED_ACCOUNTS: Array<{ code: string; namePattern: RegExp }> = [
  { code: '1120', namePattern: /foodpanda/i },
  { code: '2070', namePattern: /foodpanda/i },
  { code: '6090', namePattern: /foodpanda/i },
  { code: '6095', namePattern: /aggregator/i },
]

/**
 * Deactivate `tenantId`'s retired aggregator accounts once their ledger
 * balance is zero. Rows are never deleted and an account still carrying a
 * balance stays active until the accountant clears it — deactivating it
 * would hide money, not remove it. Returns the codes it deactivated.
 */
export async function retireAggregatorAccounts(tenantId: string): Promise<string[]> {
  const rows = await prisma.account.findMany({
    where: { tenantId, isActive: true, code: { in: RETIRED_ACCOUNTS.map((r) => r.code) } },
    select: { id: true, code: true, name: true },
  })
  const retired: string[] = []
  for (const row of rows) {
    const rule = RETIRED_ACCOUNTS.find((r) => r.code === row.code)
    if (!rule || !rule.namePattern.test(row.name)) continue
    const sums = await prisma.journalLine.groupBy({
      by: ['type'],
      where: { accountId: row.id },
      _sum: { amountCents: true },
    })
    const debit  = sumCents(sums.find((s) => s.type === 'debit')?._sum.amountCents)
    const credit = sumCents(sums.find((s) => s.type === 'credit')?._sum.amountCents)
    if (debit !== credit) continue
    await prisma.account.update({ where: { id: row.id }, data: { isActive: false } })
    retired.push(row.code)
  }
  return retired
}
