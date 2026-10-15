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
//
// Reserved ranges (never put a template code in them; the owner of each
// range creates its accounts lazily, per company, with `controlledBy` set):
//
//   1400–1449  Due from <company> — head-office books (D1, not built yet;
//              headOffices module, controlledBy 'head_office')
//   1450–1499  Due from <company> — inter-company pair accounts (H30;
//              intercompany/accounts.ts ensurePairAccounts, controlledBy
//              'intercompany')
//   1500–1599  Fixed assets: the class cost codes, 1590 (legacy accumulated
//              depreciation) and 1591–1599 accumulated depreciation per
//              class. Template accounts, controlledBy 'fixed_asset' — only
//              the register / CapEx post to them (journal.ts).
//   2100–2149  Due to <head office> — company books (D1, lazy)
//   2150–2199  Due to <company> — inter-company pair accounts (lazy)
//   6200–6249  Head office charges — company books (D1, lazy)
//   6990–6999  Costs recharged to group companies (the provider / head-office
//              side). 6990 itself is a TEMPLATE account, the ONE recovery
//              account shared by H30 fleet recharges and D1 head-office
//              recharges.
//
// Codes outside the template (the lazy pair / head-office accounts above,
// an operator's own accounts) are never required and never added here.

import type { AccountType, Prisma } from '@prisma/client'
import { serviceClient as prisma, type prisma as rlsPrisma } from './prisma.js'
import { AppError } from './errors.js'
import { sumCents } from './money.js'

export interface AccountTemplate {
  code: string
  name: string
  type: AccountType
  description?: string
  /**
   * Who controls postings to the account (Account.controlledBy, enforced by
   * postJournalEntry). Copied onto the rows ensureChartOfAccounts CREATES;
   * rows that already existed got it from migration 20261014090000's
   * backfill 9 (same code list as REGISTER_CONTROLLED_CODES).
   */
  controlledBy?: 'fixed_asset'
}

export const CHART_OF_ACCOUNTS: AccountTemplate[] = [
  // ── Assets ────────────────────────────────────────────────────────────
  { code: '1010', name: 'Cash on Hand',                       type: 'asset',     description: 'Safe / cash on hand (petty-cash boxes are 1011)' },
  { code: '1011', name: 'Petty Cash',                         type: 'asset',     description: 'Cash boxes (Finance → Petty cash); each box count ties to this' },
  { code: '1015', name: 'Cash in POS Drawer',                 type: 'asset',     description: 'Open-shift drawer floats and takings before deposit' },
  { code: '1020', name: 'Bank — Operating Account',           type: 'asset' },
  { code: '1030', name: 'Card / Gateway Receivable',          type: 'asset',     description: 'Keenu / JazzCash / Easypaisa awaiting settlement' },
  { code: '1110', name: 'Customer Accounts Receivable',       type: 'asset' },
  { code: '1115', name: 'Till Clearing',                      type: 'asset',     description: 'Reserved for the till-clearing split (parked with on-account clients): nothing posts here yet — till balances and Raast write-offs stay on 1110 until it is resumed' },
  { code: '1210', name: 'Inventory — Food',                   type: 'asset' },
  { code: '1220', name: 'Inventory — Beverage',               type: 'asset' },
  { code: '1230', name: 'Inventory — Packaging',              type: 'asset' },
  { code: '1290', name: 'Stock Differences Suspense',         type: 'asset',     description: 'Waste and count differences awaiting the CEO\'s approval into cost of sales, with their reasons (H20)' },
  { code: '1310', name: 'Prepaid Expenses',                   type: 'asset' },
  { code: '1320', name: 'GST Input (Recoverable)',            type: 'asset',     description: 'Federal sales tax (FBR) recoverable on supplier purchases — offsets 2030' },
  { code: '1322', name: 'SRB Sales Tax Input',                type: 'asset',     description: 'Sindh Revenue Board sales tax — Sindh outlets only' },
  { code: '1330', name: 'Income Tax (WHT) Receivable',        type: 'asset',     description: 'Income tax withheld at source by clients/platforms' },
  { code: '1335', name: 'Sales Tax Withheld by Customers',    type: 'asset',     description: "SRB/FBR sales tax a client withheld as withholding agent, netted in that authority's return (H13)" },
  { code: '1340', name: 'Advances to Suppliers',              type: 'asset',     description: 'Payments made before goods received' },
  { code: '1350', name: 'Staff Loans & Advances',             type: 'asset',     description: 'HR loans paid to employees, recovered through payroll' },
  { code: '1351', name: 'Rider Cash Receivable (COD)',        type: 'asset',     description: 'Delivered cash-on-delivery money an own-fleet rider has not handed in (H5); cleared when the rider pays it in at the till' },
  { code: '1355', name: 'Cash Advances to Settle',            type: 'asset',     description: 'Cash requests paid out, awaiting receipts or change (H3)' },
  { code: '1356', name: "Director's Current Account",         type: 'asset',     description: 'Unsettled cash advances held by a director (H4, Companies Act 2017 s.182); a credit balance is owed to the director' },
  { code: '1360', name: 'Security Deposits (refundable)',     type: 'asset',     description: 'Refundable deposits paid, held until returned or forfeited (H25)' },
  // Fixed assets — the register's accounts (controlledBy 'fixed_asset').
  { code: '1500', name: 'Land',                               type: 'asset',     description: 'Never depreciated',                                    controlledBy: 'fixed_asset' },
  { code: '1505', name: 'Buildings',                          type: 'asset',                                                                         controlledBy: 'fixed_asset' },
  { code: '1510', name: 'Kitchen Equipment',                  type: 'asset',                                                                         controlledBy: 'fixed_asset' },
  { code: '1515', name: 'Power & Generation Equipment',       type: 'asset',     description: 'Generators, UPS',                                      controlledBy: 'fixed_asset' },
  { code: '1520', name: 'Furniture & Fixtures',               type: 'asset',                                                                         controlledBy: 'fixed_asset' },
  { code: '1525', name: 'Office Equipment',                   type: 'asset',                                                                         controlledBy: 'fixed_asset' },
  { code: '1530', name: 'IT Equipment',                       type: 'asset',                                                                         controlledBy: 'fixed_asset' },
  { code: '1540', name: 'Vehicles',                           type: 'asset',                                                                         controlledBy: 'fixed_asset' },
  { code: '1550', name: 'Leasehold Improvements',             type: 'asset',     description: 'Fit-out of rented premises',                           controlledBy: 'fixed_asset' },
  { code: '1560', name: 'Smallwares (pooled)',                type: 'asset',     description: 'Ladles, knives, bowls, trays, plates — tracked in pools (H21)', controlledBy: 'fixed_asset' },
  // 1590 holds depreciation charged before the per-class accounts existed;
  // the one-off reclass moves it to 1591–1599. Nothing else debits it.
  { code: '1590', name: 'Accumulated Depreciation (legacy)',  type: 'asset',     description: 'Contra-asset — depreciation charged before the per-class accounts 1591–1599', controlledBy: 'fixed_asset' },
  { code: '1591', name: 'Accumulated Depreciation — Kitchen Equipment',         type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },
  { code: '1592', name: 'Accumulated Depreciation — Furniture & Fixtures',      type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },
  { code: '1593', name: 'Accumulated Depreciation — IT Equipment',              type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },
  { code: '1594', name: 'Accumulated Depreciation — Vehicles',                  type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },
  { code: '1595', name: 'Accumulated Depreciation — Leasehold Improvements',    type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },
  { code: '1596', name: 'Accumulated Depreciation — Buildings',                 type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },
  { code: '1597', name: 'Accumulated Depreciation — Power & Generation',        type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },
  { code: '1598', name: 'Accumulated Depreciation — Office Equipment',          type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },
  { code: '1599', name: 'Accumulated Depreciation — Smallwares',                type: 'asset', description: 'Contra-asset', controlledBy: 'fixed_asset' },

  // ── Liabilities ───────────────────────────────────────────────────────
  { code: '2010', name: 'Accounts Payable — Suppliers',       type: 'liability' },
  // Kept out of the AP aging (2010): what CapEx still owes a supplier when the
  // asset is capitalised.
  { code: '2012', name: 'Payables — Capital Suppliers',       type: 'liability', description: 'CapEx still owed to the supplier when the asset was capitalised', controlledBy: 'fixed_asset' },
  { code: '2015', name: 'Goods Received Not Invoiced',        type: 'liability', description: 'Stock received, supplier invoice not yet booked (H17)' },
  { code: '2020', name: 'Wages Payable',                      type: 'liability' },
  { code: '2030', name: 'GST Output (Payable to FBR)',        type: 'liability', description: 'Federal sales tax collected on sales — owed to FBR' },
  { code: '2032', name: 'SRB Sales Tax Output',               type: 'liability', description: 'Sindh service-sector sales tax' },
  { code: '2040', name: 'Income Tax Withholding Payable (suppliers, s.153)', type: 'liability', description: 'WHT deducted from supplier payments, owed to FBR. Salary tax is 2042.' },
  { code: '2041', name: 'Sales Tax Withholding Payable',      type: 'liability', description: 'STWH where we are the withholding agent' },
  { code: '2042', name: 'Salary Income Tax Payable (s.149)',  type: 'liability', description: 'Income tax deducted from salaries, owed to FBR (H7)' },
  { code: '2043', name: 'EOBI Payable',                       type: 'liability', description: 'Employee 1% + employer 5% EOBI contributions, until the PR-02 challan is paid' },
  { code: '2044', name: 'Social Security Payable (SESSI / PESSI)', type: 'liability', description: 'Employer provincial social security contributions, until paid' },
  { code: '2050', name: 'Customer Wallet Liability',          type: 'liability', description: 'Funds customers have loaded but not spent' },
  { code: '2060', name: 'Loyalty Points Liability',           type: 'liability', description: 'Accrued unredeemed loyalty points (breakage)' },
  { code: '2080', name: 'Gift Card Liability',                type: 'liability' },
  { code: '2090', name: 'Accrued Expenses',                   type: 'liability' },
  { code: '2095', name: 'Tips Payable to Staff',              type: 'liability', description: 'Customer-discretionary tips received, owed to staff' },
  // Related party, outside the reserved due-to ranges (2100–2199).
  { code: '2210', name: 'Due to Garibsons (related party)',   type: 'liability', description: 'Cash the Garibsons cashier hands to petty cash, owed back to Garibsons (H1)' },

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
  // The own-fleet delivery fee, before its sales tax; brand-tagged and taxable
  // (in the return per brand). A sale, so it stays in the labour % base.
  { code: '4110', name: 'Delivery Fee Income',                type: 'revenue',   description: 'Own-fleet delivery fees charged to customers, before sales tax' },
  // 42xx = OTHER income: shown below operating revenue, never in brand sales,
  // sales KPIs, the food-cost denominator or the labour % base.
  { code: '4200', name: 'Gift Card Breakage (Other Income)',  type: 'revenue',   description: 'Unused value of SOLD gift cards at expiry or forfeit, no sales tax (H11)' },
  { code: '4210', name: 'No-show Deposits Kept (Other Income)', type: 'revenue', description: 'Booking deposits kept on a no-show: compensation, not a supply, no sales tax (H10)' },

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
  { code: '6036', name: 'Gratuity / End-of-Service Benefits', type: 'expense',   description: 'Gratuity booked when a full & final settlement with gratuity is approved (H6)' },
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
  { code: '6155', name: 'Impairment of Fixed Assets',         type: 'expense',   description: 'Write-downs of fixed assets (CEO-approved)' },
  { code: '6160', name: 'Bad Debts Written Off',              type: 'expense',   description: 'Receivables written off directly, each one CEO-approved (H15)' },
  { code: '6170', name: 'Office & Stationery',                type: 'expense' },
  { code: '6175', name: 'Postage & Courier',                  type: 'expense' },
  { code: '6180', name: 'Staff Welfare & Refreshments',       type: 'expense' },
  // Credits only — the recovery side of a cost this company bore for another
  // group company (H30 shared-fleet recharges, D1 head-office recharges). The
  // fleet provider credits it, so 6035 stays gross rider wages.
  { code: '6990', name: 'Costs Recharged to Group Companies', type: 'expense',   description: 'Credits only: costs this company bore for another group company (shared fleet, head office) and recharged to it. Confirm with your CA.' },

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

/**
 * Codes the posting engine cannot run without — checked by /health, and a
 * required code can never be switched off in the chart. Codes posted only on
 * demand (1322, 1335, 1351, 1356, 1590, 6160, 6170, 6175, 6180, 6990)
 * are NOT here: their postings refuse cleanly (assertTemplateAccounts → 422,
 * nothing saved) when a company lacks them.
 */
export const REQUIRED_ACCOUNT_CODES = [
  // Money, receivables, stock, prepaid / advances, deposits
  '1010', '1011', '1015', '1020', '1030', '1110', '1115',
  '1210', '1220', '1230', '1290', '1310', '1320', '1340', '1355', '1360',
  // Fixed assets: class cost codes + accumulated depreciation per class
  '1500', '1505', '1510', '1515', '1520', '1525', '1530', '1540', '1550', '1560',
  '1591', '1592', '1593', '1594', '1595', '1596', '1597', '1598', '1599',
  // Payables, GRNI, tax and statutory payables, customer liabilities, related party
  '2010', '2012', '2015', '2020', '2030', '2040', '2042', '2043', '2044',
  '2050', '2060', '2080', '2095', '2210',
  '3010', '3020',
  '4001', '4090', '4100', '4110', '4200', '4210',
  // 5040 / 5050: waste and count differences, cleared into them from 1290 by
  // the CEO (H20; accounting/inventoryPosting.ts, modules/stockDifferences).
  '5010', '5020', '5030', '5040', '5050', '5060',
  '6010', '6030', '6036', '6080', '6110', '6150', '6155',
  '7010', '7040',
  '8010', '8030',
]

/**
 * The fixed-asset register's accounts (1500–1599 + 2012): only the register
 * and CapEx post to them (Account.controlledBy 'fixed_asset', enforced by
 * postJournalEntry); any other posting needs an override reason and raises
 * fixed_asset_gl_mismatch. Read by fixedAssets/classes.ts and the manual-JE /
 * bank-adjust guards. The same list as migration 20261014090000's backfill 9.
 */
export const REGISTER_CONTROLLED_CODES: string[] = CHART_OF_ACCOUNTS
  .filter((a) => a.controlledBy === 'fixed_asset')
  .map((a) => a.code)

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
      // Only on rows created here — an existing row keeps what it has
      // (migration backfill 9 set it on the register codes that existed).
      controlledBy: a.controlledBy ?? null,
      isActive: true,
    })),
    skipDuplicates: true,
  })
  return missing.length
}

type Db = Pick<typeof rlsPrisma, 'account'> | Prisma.TransactionClient

const TEMPLATE_BY_CODE = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a]))

/**
 * Before the first posting of a posting family that uses newer template codes
 * (statutory payables, gratuity, write-offs 6160, 1335, 4110 / 4200,
 * 1011 / 1355 / 2210, 2015 …): every code must exist in `tenantId`'s chart, be
 * active and — for a template code — have the template's type. An operator
 * who already used one of these codes for an account of their own gets a
 * clear 422 here (and the caller's transaction rolls back) instead of
 * resolveAccountIds' 500 or a posting onto the wrong kind of account.
 *
 *   422 ACCOUNT_CODE_TAKEN  — the code is the company's own account of another type
 *   422 ACCOUNT_INACTIVE    — switched off in Configuration → Chart of accounts
 *   422 ACCOUNT_NOT_FOUND   — missing from the company's chart
 */
export async function assertTemplateAccounts(db: Db, tenantId: string, codes: string[]): Promise<void> {
  const unique = Array.from(new Set(codes))
  if (unique.length === 0) return
  const rows = await db.account.findMany({
    where: { tenantId, code: { in: unique } },
    select: { code: true, name: true, type: true, isActive: true },
  })
  const byCode = new Map(rows.map((r) => [r.code, r]))

  const taken = rows.filter((r) => {
    const tmpl = TEMPLATE_BY_CODE.get(r.code)
    return !!tmpl && tmpl.type !== r.type
  })
  if (taken.length > 0) {
    throw new AppError(
      'ACCOUNT_CODE_TAKEN',
      taken.map((r) => {
        const tmpl = TEMPLATE_BY_CODE.get(r.code)!
        return `Code ${r.code} in this company's chart is a ${r.type} account named '${r.name}', but servd posts '${tmpl.name}' (${tmpl.type}) to it`
      }).join('; ') + '. Move your account to another code so servd can add its own.',
      422,
    )
  }
  const inactive = rows.filter((r) => !r.isActive)
  if (inactive.length > 0) {
    throw new AppError(
      'ACCOUNT_INACTIVE',
      `Account(s) ${inactive.map((r) => `${r.code} ${r.name}`).join(', ')} are deactivated — reactivate them in Configuration → Chart of accounts first`,
      422,
    )
  }
  const missing = unique.filter((c) => !byCode.has(c))
  if (missing.length > 0) {
    throw new AppError(
      'ACCOUNT_NOT_FOUND',
      `This company's chart of accounts is missing code(s): ${missing.join(', ')}. Add them in Configuration → Chart of accounts.`,
      422,
    )
  }
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
