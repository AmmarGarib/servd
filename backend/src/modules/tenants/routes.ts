import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { TEMPLATES, getTemplate, TEMPLATE_KEYS } from './templates.js'
import { audit } from '../../lib/audit.js'
import { closedAcrossYearEnd, DEFAULT_FISCAL_YEAR_END_MONTH } from '../accounting/fiscalYear.js'
import { ensureFifoReady, readFifoCutoverAt } from '../../lib/stockLedger.js'
import { assertInt4Fits } from '../../lib/money.js'
import { invalidateTestTenants } from '../../lib/testCompany.js'
import { setFiscalReportingRequired, seedFiscalReportingOffTx } from '../connectors/routes.js'
import { fiscalReportingRequired } from '../../connectors/config.js'

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

async function uniqueSlug(baseName: string, table: 'tenant' | 'concept'): Promise<string> {
  let slug = slugify(baseName) || (table === 'tenant' ? 'restaurant' : 'brand')
  let i = 1
  while (true) {
    const existing = table === 'tenant'
      ? await prisma.tenant.findUnique({ where: { slug } })
      : await prisma.concept.findUnique({ where: { slug } })
    if (!existing) return slug
    i++; slug = `${slugify(baseName)}-${i}`
  }
}

// ─── Combining companies: the finance wave B tables ──────────────────────────
//
// What the merge refuses before any write (422), and what it moves. Kept here
// beside the route so one file says what a merge does.

type MergeTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * A merge the books cannot absorb is refused (read-only; run before the FIFO
 * cut-over and again inside the merge transaction):
 *   422 TEST_COMPANY_MERGE           one company is a test company and the other is
 *                                    not (test data never lands in real books)
 *   422 MERGE_HAS_INTERCOMPANY       either company has inter-company activity (H30):
 *                                    a Due-from / Due-to account with entries, a
 *                                    transfer, or a shared-fleet rate
 *   422 FY_END_MISMATCH              the two fiscal year ends differ and a closed
 *                                    year would be re-presented: the source has
 *                                    closed across either year end, or the target
 *                                    has closed across its own and the source has
 *                                    entries inside the target's closed range (H29)
 *   422 MERGE_CARD_SETTLEMENT_CLASH  both companies claimed the same card-payout
 *                                    day for the same unit (H12)
 *   422 MERGE_TAX_PAYMENT_CLASH      both companies recorded a tax / statutory
 *                                    payment for the same authority and month
 *                                    (one challan per company, authority, month)
 *   422 MERGE_PAYMENT_REF_CLASH      the same Raast bank reference, Raast or card-
 *                                    machine idempotency key, or bank SMS is held
 *                                    by both companies (the same transfer would
 *                                    then pay two bills)
 *   422 MERGE_HR_CLASH               one login is an HR employee in both, or both
 *                                    ran HR payroll for the same month
 */
async function assertMergeable(db: typeof prisma | MergeTx, src: string, dst: string): Promise<void> {
  const pair = [src, dst]
  // Test company (lib/testCompany.ts): test data must never land in real
  // books, and a real company's books never become a test company's.
  const flags = await db.tenant.findMany({ where: { id: { in: pair } }, select: { id: true, isTest: true } })
  const testOf = (id: string) => flags.find((t) => t.id === id)?.isTest === true
  if (testOf(src) !== testOf(dst)) {
    throw new AppError(
      'TEST_COMPANY_MERGE',
      'One of these is a test company and the other is not. A test company\'s data must never land in a real company\'s books (or the reverse) — they cannot be combined.',
      422,
      { sourceIsTest: testOf(src), targetIsTest: testOf(dst) },
    )
  }
  const [icAccounts, transfers, fleetRates] = await Promise.all([
    db.account.count({
      where: {
        controlledBy: 'intercompany',
        OR: [{ tenantId: { in: pair } }, { counterpartyTenantId: { in: pair } }],
        journalLines: { some: {} },
      },
    }),
    db.intercompanyTransfer.count({ where: { OR: [{ tenantId: { in: pair } }, { counterpartyTenantId: { in: pair } }] } }),
    db.fleetRate.count({ where: { OR: [{ tenantId: { in: pair } }, { clientTenantId: { in: pair } }] } }),
  ])
  if (icAccounts + transfers + fleetRates > 0) {
    throw new AppError(
      'MERGE_HAS_INTERCOMPANY',
      'One of these companies has inter-company activity (Due-from / Due-to entries, transfers or shared-fleet rates). Merging would fold both sides of those balances into one company — settle them first, then ask finance how to close them.',
      422,
      { icAccountsWithEntries: icAccounts, transfers, fleetRates },
    )
  }
  const tenants = await db.tenant.findMany({ where: { id: { in: pair } }, select: { id: true, fiscalYearEndMonth: true } })
  const monthOf = (id: string) => tenants.find((t) => t.id === id)?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH
  if (monthOf(src) !== monthOf(dst)) {
    // The source's closed years would be re-presented on the target's year end
    // (its entries move): refused when the source has closed across EITHER year
    // end. The target's closed years would gain the source's entries: refused
    // when the target has closed across its own year end and the source has an
    // entry inside that closed range. (PATCH /tenants/:id needs a reason, an
    // audit row and a flag for the same change — a merge never does it silently.)
    let reason: 'source' | 'target' | null = null
    if (await closedAcrossYearEnd(db, src, [monthOf(src), monthOf(dst)])) reason = 'source'
    else if (await closedAcrossYearEnd(db, dst, [monthOf(dst)])) {
      const dstLock = await db.periodLock.findFirst({ where: { tenantId: dst }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
      if (dstLock && await db.journalEntry.count({ where: { tenantId: src, entryDate: { lte: dstLock.lockedThrough } } }) > 0) reason = 'target'
    }
    if (reason) {
      throw new AppError(
        'FY_END_MISMATCH',
        reason === 'source'
          ? `The two companies end their fiscal years in different months (${monthOf(src)} and ${monthOf(dst)}) and the company being merged has closed its books across a year end — merging would re-present its closed years on the other year end. Align the year ends first.`
          : `The two companies end their fiscal years in different months (${monthOf(src)} and ${monthOf(dst)}), the company being kept has closed its books across a year end, and the company being merged has entries inside that closed range — merging would change closed years. Align the year ends first.`,
        422,
        { sourceMonth: monthOf(src), targetMonth: monthOf(dst), closedYearsOf: reason },
      )
    }
  }
  const [clash] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM card_settlement_days a
      JOIN card_settlement_days b ON b.unit = a.unit AND b.day = a.day
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst}`
  if ((clash?.n ?? 0) > 0) {
    throw new AppError(
      'MERGE_CARD_SETTLEMENT_CLASH',
      `Both companies have card payouts claiming the same day(s) (${clash!.n}) — undo one side on Reconciliation → Card payouts before merging.`,
      422,
      { days: clash!.n },
    )
  }
  // One challan per (company, authority, month): two are never collapsed into one.
  const taxClash = await db.$queryRaw<Array<{ authority: string; periodFrom: Date }>>`
    SELECT a.authority, a."periodFrom"
      FROM sales_tax_payments a
      JOIN sales_tax_payments b ON b.authority = a.authority AND b."periodFrom" = a."periodFrom"
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst}
     ORDER BY a."periodFrom", a.authority`
  if (taxClash.length > 0) {
    // periodFrom is the Karachi month's first instant (UTC+5).
    const month = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 7)
    const list = taxClash.map((c) => `${c.authority.toUpperCase()} ${month(c.periodFrom)}`)
    throw new AppError(
      'MERGE_TAX_PAYMENT_CLASH',
      `Both companies have recorded a tax payment for the same authority and month (${list.join(', ')}) — a company holds one per authority per month. Remove the wrong record on Accounting → Sales tax return before merging.`,
      422,
      { clashes: taxClash.map((c) => ({ authority: c.authority, month: month(c.periodFrom) })) },
    )
  }
  // Payment references are unique per company: the same bank transfer must
  // never be able to pay a bill in each of the two halves.
  const refClash = await db.$queryRaw<Array<{ kind: string; ref: string }>>`
    SELECT 'raast_reference' AS kind, a."bankRef" AS ref FROM raast_receipts a
      JOIN raast_receipts b ON b."bankRef" = a."bankRef"
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst} AND a."bankRef" IS NOT NULL
    UNION ALL
    SELECT 'raast_key', a."idempotencyKey" FROM raast_receipts a
      JOIN raast_receipts b ON b."idempotencyKey" = a."idempotencyKey"
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst}
    UNION ALL
    SELECT 'card_machine_key', a."idempotencyKey" FROM terminal_charges a
      JOIN terminal_charges b ON b."idempotencyKey" = a."idempotencyKey"
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst}
    UNION ALL
    SELECT 'bank_sms', a."bodyHash" FROM bank_sms_alerts a
      JOIN bank_sms_alerts b ON b."bodyHash" = a."bodyHash"
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst}
    UNION ALL
    SELECT 'bank_sms_reference', a."claimedRef" FROM bank_sms_alerts a
      JOIN bank_sms_alerts b ON b."claimedRef" = a."claimedRef"
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst} AND a."claimedRef" IS NOT NULL
    LIMIT 20`
  if (refClash.length > 0) {
    const refs = refClash.filter((c) => c.kind === 'raast_reference' || c.kind === 'bank_sms_reference').map((c) => c.ref)
    throw new AppError(
      'MERGE_PAYMENT_REF_CLASH',
      `Both companies hold the same payment record${refs.length ? ` (bank reference ${[...new Set(refs)].join(', ')})` : ''} — one bank transfer cannot have paid a bill in each. Ask finance to resolve it on Reconciliation → Raast before merging.`,
      422,
      { clashes: refClash.map((c) => ({ kind: c.kind, ...(c.kind.endsWith('reference') ? { ref: c.ref } : {}) })) },
    )
  }
  // HR: one employee record per login per company, one payroll run per month.
  const hrClash = await db.$queryRaw<Array<{ kind: string; key: string }>>`
    SELECT 'login' AS kind, a."userId" AS key FROM hr_employees a
      JOIN hr_employees b ON b."userId" = a."userId"
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst} AND a."userId" IS NOT NULL
    UNION ALL
    SELECT 'payroll_month', a.period FROM hr_payroll_runs a
      JOIN hr_payroll_runs b ON b.period = a.period
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst}
    ORDER BY 1, 2
    LIMIT 50`
  if (hrClash.length > 0) {
    const months = hrClash.filter((c) => c.kind === 'payroll_month').map((c) => c.key)
    const logins = hrClash.filter((c) => c.kind === 'login').length
    throw new AppError(
      'MERGE_HR_CLASH',
      [
        logins > 0 ? `${logins} login(s) are an HR employee in both companies` : null,
        months.length > 0 ? `both companies ran HR payroll for ${months.join(', ')}` : null,
      ].filter(Boolean).join('; ') + ' — two people\'s (or two months\') payroll history is never collapsed into one. Resolve it in HR before merging.',
      422,
      { employeesInBoth: logins, payrollMonthsInBoth: months },
    )
  }
}

/** `base` made unique against `taken`: base, then base-2, base-3 … (added to `taken`). */
function freeName(base: string, taken: Set<string>): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
  taken.add(name)
  return name
}

/**
 * Move every finance wave B company table (and the finance-wave-A parents they
 * hang off) from `src` to `dst`, inside the merge transaction. Company-keyed
 * unique keys stay unique: a fixed-asset class the target already has (by
 * key) absorbs the source's (assets and pools name their class by key); a
 * colliding asset tag or receivable-invoice number gets '-<source slug>'; the
 * source's cash requests are renumbered after the target's (seq is per
 * company; the printed number keeps its old digits plus '-<source slug>').
 * PARKED (owner, 2026-10-13): customer_accounts / _cards / _charges and
 * customer_strikes / customer_bans are NOT moved — the on-account and
 * strikes / bans features are parked; the resume adds them here.
 */
async function mergeFinanceTables(tx: MergeTx, src: string, dst: string, srcSlug: string) {
  // Fixed assets — classes by key.
  const srcClasses = await tx.fixedAssetClass.findMany({ where: { tenantId: src }, select: { id: true, key: true } })
  if (srcClasses.length > 0) {
    const dstKeys = new Set((await tx.fixedAssetClass.findMany({ where: { tenantId: dst }, select: { key: true } })).map((c) => c.key))
    for (const c of srcClasses) {
      if (dstKeys.has(c.key)) await tx.fixedAssetClass.delete({ where: { id: c.id } })
      else await tx.fixedAssetClass.update({ where: { id: c.id }, data: { tenantId: dst } })
    }
  }
  // Asset tags are unique per company.
  let assetTagsRenamed = 0
  const srcTagged = await tx.fixedAsset.findMany({ where: { tenantId: src, assetTag: { not: null } }, select: { id: true, assetTag: true } })
  if (srcTagged.length > 0) {
    const taken = new Set((await tx.fixedAsset.findMany({ where: { tenantId: dst, assetTag: { not: null } }, select: { assetTag: true } }))
      .map((a) => a.assetTag!))
    for (const a of srcTagged) {
      if (!taken.has(a.assetTag!)) { taken.add(a.assetTag!); continue }
      await tx.fixedAsset.update({ where: { id: a.id }, data: { assetTag: freeName(`${a.assetTag}-${srcSlug}`, taken) } })
      assetTagsRenamed++
    }
  }
  // Receivable invoice numbers are unique per company.
  let invoiceNumbersRenamed = 0
  const srcInvoices = await tx.receivableInvoice.findMany({ where: { tenantId: src }, select: { id: true, number: true } })
  if (srcInvoices.length > 0) {
    const taken = new Set((await tx.receivableInvoice.findMany({ where: { tenantId: dst }, select: { number: true } })).map((i) => i.number))
    for (const inv of srcInvoices) {
      if (!taken.has(inv.number)) { taken.add(inv.number); continue }
      await tx.receivableInvoice.update({ where: { id: inv.id }, data: { number: freeName(`${inv.number}-${srcSlug}`, taken) } })
      invoiceNumbersRenamed++
    }
  }
  // Cash requests: seq is per company — the source's continue after the target's.
  let cashRequestsRenumbered = 0
  const dstMaxSeq = (await tx.cashVoucher.aggregate({ where: { tenantId: dst }, _max: { seq: true } }))._max.seq ?? 0
  if (dstMaxSeq > 0) {
    const srcVouchers = await tx.cashVoucher.findMany({ where: { tenantId: src }, select: { id: true, number: true }, orderBy: { seq: 'asc' } })
    let next = dstMaxSeq
    for (const v of srcVouchers) {
      await tx.cashVoucher.update({ where: { id: v.id }, data: { tenantId: dst, seq: ++next, number: `${v.number}-${srcSlug}` } })
      cashRequestsRenumbered++
    }
  }

  const repoint: Array<{
    updateMany(args: { where: { tenantId: string }; data: { tenantId: string } }): Promise<unknown>
  }> = [
    // Fixed assets (v2) and prepayment releases.
    tx.fixedAsset, tx.fixedAssetEvent, tx.fixedAssetPool, tx.fixedAssetTaxYear, tx.fixedAssetRun, tx.fixedAssetDepreciation,
    tx.prepaidRelease,
    // Food cost on FIFO lots: the lots and their movements, GRNI matches, and
    // the stock documents' own company columns.
    tx.stockLot, tx.stockMovement, tx.grniMatch, tx.goodsReceipt, tx.wasteLog, tx.physicalCount, tx.prepBatch,
    // Card payouts (H12).
    tx.cardSettlement, tx.cardSettlementDay,
    // Receivables (the invoices the bad-debt write-offs belong to) and G12 write-offs + evidence.
    tx.receivableInvoice, tx.receivablePayment, tx.receivableWriteOff, tx.receivableWriteOffAttachment,
    // Petty cash and cash requests (the boxes and requests the settlements, spend lines and movements belong to).
    tx.pettyCashBox, tx.cashVoucher, tx.cashVoucherAttachment, tx.cashVoucherSettlement, tx.pettyCashSpendLine, tx.pettyCashMovement,
  ]
  for (const model of repoint) {
    await model.updateMany({ where: { tenantId: src }, data: { tenantId: dst } })
  }
  return { assetTagsRenamed, invoiceNumbersRenamed, cashRequestsRenumbered }
}

/**
 * System suppliers (Supplier.systemKind, one per company — 'cash_purchases' is
 * created on first use by procurement/receiving.ts): when both companies have
 * one, the target's absorbs the source's — every document naming the source's
 * row is repointed to the target's, then the source's row is dropped. Runs
 * BEFORE the generic supplier repoint, which would otherwise hit
 * @@unique([tenantId, systemKind]) and roll the whole merge back.
 */
async function mergeSystemSuppliers(tx: MergeTx, src: string, dst: string, srcSlug: string): Promise<number> {
  const srcSys = await tx.supplier.findMany({ where: { tenantId: src, systemKind: { not: null } }, select: { id: true, systemKind: true } })
  let absorbed = 0
  for (const s of srcSys) {
    const twin = await tx.supplier.findFirst({ where: { tenantId: dst, systemKind: s.systemKind }, select: { id: true } })
    if (!twin) continue
    // Bill numbers are unique per supplier: a clash keeps its digits + '-<source slug>'.
    const srcBills = await tx.supplierBill.findMany({ where: { supplierId: s.id }, select: { id: true, billNumber: true } })
    if (srcBills.length > 0) {
      const taken = new Set((await tx.supplierBill.findMany({ where: { supplierId: twin.id }, select: { billNumber: true } })).map((b) => b.billNumber))
      for (const b of srcBills) {
        if (!taken.has(b.billNumber)) { taken.add(b.billNumber); continue }
        await tx.supplierBill.update({ where: { id: b.id }, data: { billNumber: freeName(`${b.billNumber}-${srcSlug}`, taken) } })
      }
    }
    const move = { where: { supplierId: s.id }, data: { supplierId: twin.id } }
    await tx.goodsReceipt.updateMany(move)
    await tx.purchaseOrder.updateMany(move)
    await tx.supplierBill.updateMany(move)
    await tx.supplierPayment.updateMany(move)
    await tx.inventoryItem.updateMany(move)
    await tx.itemPriceHistory.updateMany(move)
    await tx.capexLine.updateMany(move)
    await tx.opexLine.updateMany(move)
    await tx.fixedAsset.updateMany(move)
    await tx.supplierConversation.updateMany(move)
    await tx.supplierPortalToken.updateMany(move)
    await tx.supplier.delete({ where: { id: s.id } })
    absorbed++
  }
  return absorbed
}

/**
 * The company money, tax and HR tables that are not finance wave B (moved in
 * the merge transaction, after assertMergeable has refused the clashes it
 * cannot resolve — MERGE_TAX_PAYMENT_CLASH, MERGE_PAYMENT_REF_CLASH,
 * MERGE_HR_CLASH):
 *   - straight repoint: exception flags (open posting / stock failures follow
 *     their documents, so the target's backfill re-posts them), sales-tax and
 *     statutory payments, Raast receipts, card-machine charges, bank SMS
 *     devices and alerts, deposit drops, gift cards (code is globally unique),
 *     wallet transactions, tip pools, bank statement imports, supplier credit
 *     applications;
 *   - loyalty accounts and wallets (one per company and customer): a customer
 *     with one in each keeps the target's, with the source's points, lifetime
 *     points, stamps and balance added to it (loyalty transactions follow);
 *   - tax invoices: a colliding number gets '-<source slug>'; a numbering
 *     series both companies have keeps the higher counter;
 *   - HR: employees (a colliding employee code gets '-<source slug>'), payroll
 *     runs and payslips, records, documents, org units (a same-named unit of
 *     the same kind gets ' (<source slug>)' — ids are kept, records name units
 *     by id), form versions (a section both have is renumbered after the
 *     target's, the records with it, and stays inactive when the target has an
 *     active form) and letter templates (the target's wins on a key).
 */
async function mergeMoneyAndHrTables(tx: MergeTx, src: string, dst: string, srcSlug: string) {
  // Loyalty accounts: one per (company, customer).
  let loyaltyAccountsCombined = 0
  const srcLoyalty = await tx.loyaltyAccount.findMany({ where: { tenantId: src } })
  if (srcLoyalty.length > 0) {
    const dstBy = new Map((await tx.loyaltyAccount.findMany({
      where: { tenantId: dst, customerId: { in: srcLoyalty.map((a) => a.customerId) } },
    })).map((a) => [a.customerId, a]))
    for (const a of srcLoyalty) {
      const twin = dstBy.get(a.customerId)
      if (!twin) { await tx.loyaltyAccount.update({ where: { id: a.id }, data: { tenantId: dst } }); continue }
      const stamps: Record<string, number> = { ...((twin.stampCounts ?? {}) as Record<string, number>) }
      for (const [k, v] of Object.entries((a.stampCounts ?? {}) as Record<string, number>)) stamps[k] = (Number(stamps[k]) || 0) + (Number(v) || 0)
      await tx.loyaltyAccount.update({
        where: { id: twin.id },
        data: { pointsBalance: { increment: a.pointsBalance }, lifetimePoints: { increment: a.lifetimePoints }, stampCounts: stamps },
      })
      await tx.loyaltyTransaction.updateMany({ where: { loyaltyAccountId: a.id }, data: { loyaltyAccountId: twin.id } })
      await tx.loyaltyAccount.delete({ where: { id: a.id } })
      loyaltyAccountsCombined++
    }
  }
  // Wallets: one per (company, customer).
  let walletsCombined = 0
  const srcWallets = await tx.customerWallet.findMany({ where: { tenantId: src } })
  if (srcWallets.length > 0) {
    const dstBy = new Map((await tx.customerWallet.findMany({
      where: { tenantId: dst, customerId: { in: srcWallets.map((w) => w.customerId) } },
    })).map((w) => [w.customerId, w]))
    for (const w of srcWallets) {
      const twin = dstBy.get(w.customerId)
      if (!twin) { await tx.customerWallet.update({ where: { id: w.id }, data: { tenantId: dst } }); continue }
      assertInt4Fits(twin.balanceCents + w.balanceCents, 'combined wallet balance')
      await tx.customerWallet.update({ where: { id: twin.id }, data: { balanceCents: { increment: w.balanceCents } } })
      await tx.customerWallet.delete({ where: { id: w.id } })
      walletsCombined++
    }
  }
  // Tax invoices: numbers are unique per company.
  let taxInvoiceNumbersRenamed = 0
  const srcTaxInvoices = await tx.taxInvoice.findMany({ where: { tenantId: src }, select: { id: true, invoiceNumber: true } })
  if (srcTaxInvoices.length > 0) {
    const taken = new Set((await tx.taxInvoice.findMany({ where: { tenantId: dst }, select: { invoiceNumber: true } })).map((i) => i.invoiceNumber))
    for (const inv of srcTaxInvoices) {
      if (!taken.has(inv.invoiceNumber)) { taken.add(inv.invoiceNumber); continue }
      await tx.taxInvoice.update({ where: { id: inv.id }, data: { invoiceNumber: freeName(`${inv.invoiceNumber}-${srcSlug}`, taken) } })
      taxInvoiceNumbersRenamed++
    }
  }
  const srcSeries = await tx.taxInvoiceSeries.findMany({ where: { tenantId: src } })
  for (const s of srcSeries) {
    const twin = await tx.taxInvoiceSeries.findUnique({ where: { tenantId_head: { tenantId: dst, head: s.head } } })
    if (twin) {
      if (s.lastValue > twin.lastValue) {
        await tx.taxInvoiceSeries.update({ where: { tenantId_head: { tenantId: dst, head: s.head } }, data: { lastValue: s.lastValue } })
      }
      await tx.taxInvoiceSeries.delete({ where: { tenantId_head: { tenantId: src, head: s.head } } })
    } else {
      await tx.taxInvoiceSeries.update({ where: { tenantId_head: { tenantId: src, head: s.head } }, data: { tenantId: dst } })
    }
  }

  // HR — employee codes are unique per company.
  let employeeCodesRenamed = 0
  const srcEmployees = await tx.hrEmployee.findMany({ where: { tenantId: src }, select: { id: true, employeeCode: true } })
  if (srcEmployees.length > 0) {
    const taken = new Set((await tx.hrEmployee.findMany({ where: { tenantId: dst }, select: { employeeCode: true } })).map((e) => e.employeeCode))
    for (const e of srcEmployees) {
      if (!taken.has(e.employeeCode)) { taken.add(e.employeeCode); continue }
      await tx.hrEmployee.update({ where: { id: e.id }, data: { employeeCode: freeName(`${e.employeeCode}-${srcSlug}`, taken) } })
      employeeCodesRenamed++
    }
  }
  // Org units: unique per (company, kind, name). Records, employees and
  // positions name a unit by id, so a clash renames rather than collapses.
  const srcUnits = await tx.hrOrgUnit.findMany({ where: { tenantId: src }, select: { id: true, kind: true, name: true } })
  if (srcUnits.length > 0) {
    const dstUnits = await tx.hrOrgUnit.findMany({ where: { tenantId: dst }, select: { kind: true, name: true } })
    const takenByKind = new Map<string, Set<string>>()
    for (const u of dstUnits) {
      if (!takenByKind.has(u.kind)) takenByKind.set(u.kind, new Set())
      takenByKind.get(u.kind)!.add(u.name)
    }
    for (const u of srcUnits) {
      if (!takenByKind.has(u.kind)) takenByKind.set(u.kind, new Set())
      const taken = takenByKind.get(u.kind)!
      if (!taken.has(u.name)) { taken.add(u.name); continue }
      await tx.hrOrgUnit.update({ where: { id: u.id }, data: { name: freeName(`${u.name} (${srcSlug})`, taken) } })
    }
  }
  // Form versions: unique per (company, section, version); records carry the
  // version they were filled on.
  const srcForms = await tx.hrFormDefinition.findMany({ where: { tenantId: src }, select: { id: true, section: true, version: true } })
  if (srcForms.length > 0) {
    const dstForms = await tx.hrFormDefinition.findMany({ where: { tenantId: dst }, select: { section: true, version: true, isActive: true } })
    for (const section of new Set(srcForms.map((f) => f.section))) {
      const theirs = dstForms.filter((f) => f.section === section)
      if (theirs.length === 0) continue
      const offset = Math.max(...theirs.map((f) => f.version))
      const dstActive = theirs.some((f) => f.isActive)
      // Highest first, so a shifted version never lands on one not yet moved.
      for (const f of srcForms.filter((x) => x.section === section).sort((a, b) => b.version - a.version)) {
        await tx.hrFormDefinition.update({
          where: { id: f.id },
          data: { version: f.version + offset, ...(dstActive ? { isActive: false } : {}) },
        })
        await tx.hrRecord.updateMany({ where: { tenantId: src, section, formVersion: f.version }, data: { formVersion: f.version + offset } })
      }
    }
  }
  // Letter templates: the target's wins on a key.
  const srcLetters = await tx.hrLetterTemplate.findMany({ where: { tenantId: src }, select: { id: true, key: true } })
  if (srcLetters.length > 0) {
    const dstKeys = new Set((await tx.hrLetterTemplate.findMany({ where: { tenantId: dst }, select: { key: true } })).map((l) => l.key))
    for (const l of srcLetters) if (dstKeys.has(l.key)) await tx.hrLetterTemplate.delete({ where: { id: l.id } })
  }

  const repoint: Array<{
    updateMany(args: { where: { tenantId: string }; data: { tenantId: string } }): Promise<unknown>
  }> = [
    // Refused postings and stock failures follow their documents.
    tx.exceptionFlag,
    // Tax and statutory payments (clashes refused in assertMergeable).
    tx.salesTaxPayment,
    // Payments, references and the bank's own records.
    tx.raastReceipt, tx.terminalCharge, tx.bankSmsDevice, tx.bankSmsAlert, tx.depositDrop, tx.bankStatementImport,
    tx.supplierCreditApplication,
    // Customer money.
    tx.giftCard, tx.walletTransaction, tx.tipPool, tx.taxInvoice,
    // HR back office.
    tx.hrOrgUnit, tx.hrFormDefinition, tx.hrLetterTemplate, tx.hrEmployee, tx.hrPayrollRun, tx.hrPayslip, tx.hrRecord, tx.hrDocument,
  ]
  for (const model of repoint) {
    await model.updateMany({ where: { tenantId: src }, data: { tenantId: dst } })
  }
  return { loyaltyAccountsCombined, walletsCombined, taxInvoiceNumbersRenamed, employeeCodesRenamed }
}

export async function tenantRoutes(fastify: FastifyInstance) {
  // ── Templates catalogue (public — needed for signup wizard) ─────────────
  fastify.get('/templates', async () => {
    return TEMPLATES.map((t) => ({
      key: t.key, emoji: t.emoji, label: t.label, blurb: t.blurb,
      conceptType: t.conceptType, primaryColor: t.primaryColor,
      stationCount: t.stations.length, categoryCount: t.categories.length,
      itemCount: t.items.length,
    }))
  })

  // ── List tenants (admin only — internal dashboard for the SaaS owner).
  // Scoped to the companies the operator belongs to: a company they are not
  // a member of is not theirs to list, admin role or not.
  fastify.get('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    return prisma.tenant.findMany({
      where: { deletedAt: null, id: { in: req.staffUser!.memberTenantIds } },
      include: {
        _count: { select: { concepts: true, users: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  // ── Get current tenant (whoever the logged-in user belongs to) ──────────
  fastify.get('/me', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { tenantId: true },
    })
    if (!user?.tenantId) return null
    return prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { _count: { select: { concepts: true, users: true } } },
    })
  })

  // ── List tenants the current user is a member of (multi-tenant switcher)
  fastify.get('/mine', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { tenantId: true },
    })
    // Only the companies this person belongs to — the CEO role included
    // (UI-11). This used to hand every admin EVERY company, with its name,
    // slug, brand count and staff count, so each company's CEO could read the
    // others' and was offered them in Add staff. Belonging is the auth
    // middleware's memberTenantIds (TenantMember rows + the primary company),
    // the same set every write is scoped to — so a company that shows here is
    // exactly one the operator can act in. A CEO who runs several companies is
    // a member of each (POST /tenants makes the creator one). An empty set
    // lists nothing.
    const ids = req.staffUser!.memberTenantIds
    if (ids.length === 0) return []
    const [tenants, memberships] = await Promise.all([
      prisma.tenant.findMany({
        where: { id: { in: ids }, deletedAt: null },
        include: { _count: { select: { concepts: true, users: true } } },
      }),
      prisma.tenantMember.findMany({
        where: { userId: req.staffUser!.id, tenantId: { in: ids } },
        select: { tenantId: true, role: true, createdAt: true },
      }),
    ])
    const membership = new Map(memberships.map((m) => [m.tenantId, m]))
    // Membership order first (as before), then a primary with no member row.
    const order = (id: string) => membership.get(id)?.createdAt.getTime() ?? Number.MAX_SAFE_INTEGER
    return tenants
      .sort((a, b) => order(a.id) - order(b.id) || a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => ({
        ...t,
        role:     membership.get(t.id)?.role ?? 'member',
        isActive: t.id === user?.tenantId,
      }))
  })

  // ── Create a new tenant (authenticated operator only — used by the
  // in-house onboarding wizard for adding a new brand/JV). Switches the
  // user's active tenant to the newly created one so subsequent wizard
  // steps populate it.
  //
  // `isTest: true` makes a TEST company (owner, 2026-10-14; lib/testCompany.ts)
  // — the CEO (role admin) only, else 403 TEST_COMPANY_CEO_ONLY. Its fiscal
  // reporting is switched off at once (audited, reason "Test company").
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      name:        z.string().min(1).max(200),
      industry:    z.string().max(40).nullable().optional(),
      countryCode: z.string().length(2).default('PK'),
      timezone:    z.string().max(64).default('Asia/Karachi'),
      isTest:      z.boolean().optional(),
    }).parse(req.body)
    if (body.isTest === true && req.staffUser!.role !== 'admin') {
      throw new AppError('TEST_COMPANY_CEO_ONLY', 'Only the CEO can make a test company.', 403)
    }
    const isTest = body.isTest === true

    const slug = await uniqueSlug(body.name, 'tenant')

    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          slug, name: body.name,
          industry:    body.industry ?? null,
          countryCode: body.countryCode,
          currency:    body.countryCode === 'PK' ? 'PKR' : 'USD',
          timezone:    body.timezone,
          isTest,
        },
      })
      await tx.tenantMember.create({
        data: { userId: req.staffUser!.id, tenantId: t.id, role: 'owner' },
      })
      // Switch active tenant to the new one
      await tx.user.update({ where: { id: req.staffUser!.id }, data: { tenantId: t.id } })
      // A test company never files with FBR/SRB: its fiscal switch is
      // written OFF in the same transaction as the company (fr-3), so a test
      // company can never exist with reporting required.
      const fiscalRow = isTest ? await seedFiscalReportingOffTx(tx, t.id, req.staffUser!.id) : null
      return { ...t, fiscalRowId: fiscalRow?.id ?? null }
    })
    const { fiscalRowId, ...created } = tenant
    if (isTest) {
      invalidateTestTenants()
      await audit({
        category: 'identity', action: 'tenant.test_mode', entity: 'Tenant', entityId: created.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: created.id,
        before: null, after: { isTest: true }, metadata: { reason: 'Created as a test company' },
      })
      await audit({
        category: 'identity', action: 'fiscal.reporting_required', entity: 'PosConnector', entityId: fiscalRowId ?? created.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: created.id,
        before: { fiscalReportingRequired: true }, after: { fiscalReportingRequired: false },
        metadata: { reason: 'Test company', heldCount: 0 },
      })
    }
    return reply.status(201).send(created)
  })

  // ── Switch active tenant (verifies membership) ──────────────────────────
  //
  // Belonging = a TenantMember row OR the caller's own current users.tenantId
  // (the auth middleware's memberTenantIds). Switching overwrites
  // users.tenantId, so the company being switched AWAY from is first written
  // down as a real membership: a login tied to its company only through
  // users.tenantId used to lose that company on its first switch, with no
  // in-app way back (AUTH-R1). Records a company the caller already belongs
  // to — grants nothing new.
  fastify.post<{ Params: { id: string } }>('/switch/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const userId = req.staffUser!.id
    const target = req.params.id
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } })
    const membership = await prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId, tenantId: target } },
      select: { id: true },
    })
    if (!membership && me?.tenantId !== target) {
      return reply.status(403).send({ error: { code: 'NOT_A_MEMBER', message: 'You are not a member of this tenant' } })
    }
    const live = await prisma.tenant.findFirst({ where: { id: target, deletedAt: null }, select: { id: true } })
    if (!live) return reply.status(403).send({ error: { code: 'NOT_A_MEMBER', message: 'You are not a member of this tenant' } })
    await prisma.$transaction(async (tx) => {
      for (const tid of new Set([me?.tenantId, target])) {
        if (!tid) continue
        await tx.tenantMember.upsert({
          where:  { userId_tenantId: { userId, tenantId: tid } },
          create: { userId, tenantId: tid, role: 'member' },
          update: {},
        })
      }
      await tx.user.update({ where: { id: userId }, data: { tenantId: target } })
    })
    return { activeTenantId: target }
  })

  // ── Combine companies — moves everything from `sourceId` into `targetId`,
  // soft-deletes the source. Admin only, and the caller must be a member of
  // BOTH companies — a foreign id 404s rather than confirming it exists.
  // Everything anchored on a tenantId column moves in the same transaction:
  // brands, staff, memberships, locations, suppliers, inventory, riders, bank
  // accounts, modifier templates, webhooks, domains, capex/opex/pro-forma rows,
  // workforce rows, storefront content (pages, brand kits, pop-ups) and the
  // Library, and the per-company singleton configs. Concept-scoped data
  // (orders, items, etc.) follows its brand. Where the target already holds a
  // row with the same company-keyed unique key the target's row wins and the
  // source's duplicate is dropped — except kitchen staff, where the merge is
  // refused so two people's payroll history is never silently collapsed.
  // Finance wave B: the fixed-asset register, FIFO lots / movements / GRNI,
  // card payouts, receivables + bad-debt write-offs and petty cash / cash
  // requests move too (mergeFinanceTables), and so do exception flags, tax
  // payments, Raast / card-machine / bank-SMS records, deposit drops, gift
  // cards, loyalty and wallets, tip pools, tax invoices and the HR back office
  // (mergeMoneyAndHrTables); a system supplier both have is absorbed by the
  // target's (mergeSystemSuppliers). assertMergeable refuses a merge the books
  // cannot absorb (inter-company activity, a fiscal-year clash, clashing
  // card-payout days, tax payments, payment references or HR rows). When only one company holds its stock on FIFO
  // lots, the other is cut over first so the merged items all live on lots.
  fastify.post('/merge', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      sourceId: z.string().min(1),
      targetId: z.string().min(1),
    }).parse(req.body)
    if (body.sourceId === body.targetId) {
      return reply.status(400).send({ error: { code: 'SAME_TENANT', message: 'Source and target must differ' } })
    }
    const src = body.sourceId
    const dst = body.targetId
    // memberTenantIds = every company the operator belongs to (non-GET, so
    // never narrowed by the active-company header). Checked before any DB
    // read so a guessed id never confirms a company exists.
    for (const id of [src, dst]) {
      if (!req.staffUser!.memberTenantIds.includes(id)) throw new NotFoundError('Tenant', id)
    }
    const live = await prisma.tenant.findMany({
      where: { id: { in: [src, dst] }, deletedAt: null },
      select: { id: true },
    })
    for (const id of [src, dst]) {
      if (!live.some((t) => t.id === id)) throw new NotFoundError('Tenant', id)
    }

    await assertMergeable(prisma, src, dst)
    // FIFO lots: a company on lots and one not would leave the merged items
    // half on lots (or cut over twice) — cut the other one over first.
    const [srcFifo, dstFifo] = await Promise.all([readFifoCutoverAt(prisma, src), readFifoCutoverAt(prisma, dst)])
    if ((srcFifo || dstFifo) && !(srcFifo && dstFifo)) {
      await ensureFifoReady(src)
      await ensureFifoReady(dst)
    }
    const srcSlug = (await prisma.tenant.findUniqueOrThrow({ where: { id: src }, select: { slug: true } })).slug

    const result = await prisma.$transaction(async (tx) => {
      await assertMergeable(tx, src, dst)
      // Refuse before any write if a kitchen staffer (unique per company on
      // CNIC) exists on both sides.
      const srcStaff = await tx.kitchenStaff.findMany({ where: { tenantId: src }, select: { cnic: true } })
      if (srcStaff.length > 0) {
        const dstStaff = await tx.kitchenStaff.findMany({
          where: { tenantId: dst, cnic: { in: srcStaff.map((s) => s.cnic) } },
          select: { cnic: true },
        })
        if (dstStaff.length > 0) {
          throw new ConflictError(
            `Kitchen staff with CNIC ${dstStaff.map((s) => s.cnic).join(', ')} exist in both companies — resolve them before merging`,
          )
        }
      }

      const conceptsMoved = await tx.concept.updateMany({
        where: { tenantId: src }, data: { tenantId: dst },
      })
      const usersMoved = await tx.user.updateMany({
        where: { tenantId: src }, data: { tenantId: dst },
      })
      // Move memberships — but preserve unique (userId, tenantId). Drop members
      // already in target; otherwise repoint to target.
      const sourceMembers = await tx.tenantMember.findMany({ where: { tenantId: src } })
      for (const m of sourceMembers) {
        const exists = await tx.tenantMember.findUnique({
          where: { userId_tenantId: { userId: m.userId, tenantId: dst } },
        })
        if (exists) {
          await tx.tenantMember.delete({ where: { id: m.id } })
        } else {
          await tx.tenantMember.update({ where: { id: m.id }, data: { tenantId: dst } })
        }
      }

      // Company master data with no company-keyed unique constraint (kitchen
      // staff included — CNIC clashes were refused above): a straight repoint.
      // The ledger merges account-by-account: both companies run the same
      // code numbers (4001, 1010, …) on separate rows, so every journal line
      // pointing at a source account is repointed to the destination's account
      // with the same code before the entries move. A code the destination
      // doesn't have is carried across as-is. Source accounts are then retired.
      // Inter-company pair accounts with no entries (assertMergeable refused
      // any with entries) are lazy — ensurePairAccounts re-creates them — so
      // the source's, and the target's facing the source, are dropped first:
      // they would otherwise land on another pair's code or face themselves.
      await tx.account.deleteMany({
        where: { controlledBy: 'intercompany', OR: [{ tenantId: src }, { tenantId: dst, counterpartyTenantId: src }] },
      })
      const srcAccounts = await tx.account.findMany({
        where: { tenantId: src }, select: { id: true, code: true },
      })
      if (srcAccounts.length > 0) {
        const dstAccounts = await tx.account.findMany({
          where: { tenantId: dst, code: { in: srcAccounts.map((a) => a.code) } },
          select: { id: true, code: true },
        })
        const dstByCode = new Map(dstAccounts.map((a) => [a.code, a.id]))
        for (const a of srcAccounts) {
          const twin = dstByCode.get(a.code)
          if (twin) {
            await tx.journalLine.updateMany({ where: { accountId: a.id }, data: { accountId: twin } })
            await tx.account.delete({ where: { id: a.id } })
          } else {
            await tx.account.update({ where: { id: a.id }, data: { tenantId: dst } })
          }
        }
      }

      // A system supplier both companies have: the target's absorbs the source's
      // (before the supplier repoint, which would hit the per-company unique key).
      const systemSuppliersAbsorbed = await mergeSystemSuppliers(tx, src, dst, srcSlug)

      const repoint: Array<{
        updateMany(args: { where: { tenantId: string }; data: { tenantId: string } }): Promise<unknown>
      }> = [
        tx.location, tx.inventoryItem, tx.supplier, tx.rider, tx.modifierTemplate,
        tx.bankAccount, tx.kdsDevice, tx.webhookSubscription, tx.domain,
        tx.deliveryZone, tx.notificationTemplate, tx.scheduledReport, tx.shift,
        tx.journalEntry, tx.periodLock,
        tx.capitalLedgerEntry, tx.capexProject, tx.opexCategory, tx.proForma, tx.projection,
        tx.position, tx.kitchenStaff, tx.kitchenPayrollRun, tx.complianceViolation,
        // Storefront content (pages, brand kits, pop-ups) and the Library
        // (images, videos, fonts, copy): slug / id are global, so a straight
        // repoint — a brand kit's library: fonts move with it.
        tx.siteLayout, tx.mediaAsset,
      ]
      for (const model of repoint) {
        await model.updateMany({ where: { tenantId: src }, data: { tenantId: dst } })
      }

      // Finance wave B tables (see mergeFinanceTables).
      const finance = await mergeFinanceTables(tx, src, dst, srcSlug)
      // Flags, tax payments, payments / references, customer money, tax
      // invoices and the HR back office (see mergeMoneyAndHrTables).
      const money = await mergeMoneyAndHrTables(tx, src, dst, srcSlug)

      // Per-company singleton configs — unique on (tenantId, scope, scopeId).
      // The target's row wins on a clash; the source's duplicate is dropped.
      // Concept-scoped rows can't clash: their scopeId is a brand that just
      // moved with the source.
      const singletons: Array<{
        findMany(args: { where: { tenantId: string }; select: { id: true; scope: true; scopeId: true } }):
          Promise<Array<{ id: string; scope: string; scopeId: string | null }>>
        update(args: { where: { id: string }; data: { tenantId: string } }): Promise<unknown>
        delete(args: { where: { id: string } }): Promise<unknown>
      }> = [tx.refundPolicy, tx.reservationPolicy, tx.receiptConfig, tx.operationsConfig]
      const scopeKey = (r: { scope: string; scopeId: string | null }) => `${r.scope}:${r.scopeId ?? ''}`
      for (const model of singletons) {
        const srcRows = await model.findMany({ where: { tenantId: src }, select: { id: true, scope: true, scopeId: true } })
        if (srcRows.length === 0) continue
        const dstRows = await model.findMany({ where: { tenantId: dst }, select: { id: true, scope: true, scopeId: true } })
        const taken = new Set(dstRows.map(scopeKey))
        for (const r of srcRows) {
          if (taken.has(scopeKey(r))) await model.delete({ where: { id: r.id } })
          else await model.update({ where: { id: r.id }, data: { tenantId: dst } })
        }
      }

      // Wage settings: one row per company.
      const srcWages = await tx.wageSettings.findUnique({ where: { tenantId: src }, select: { id: true } })
      if (srcWages) {
        const dstWages = await tx.wageSettings.findUnique({ where: { tenantId: dst }, select: { id: true } })
        if (dstWages) await tx.wageSettings.delete({ where: { id: srcWages.id } })
        else await tx.wageSettings.update({ where: { id: srcWages.id }, data: { tenantId: dst } })
      }

      // Departments and shift bands are unique per (company, name) and are
      // referenced by positions: a same-named row on the target absorbs the
      // source's positions, otherwise the row itself moves.
      const srcDepts = await tx.department.findMany({ where: { tenantId: src }, select: { id: true, name: true } })
      if (srcDepts.length > 0) {
        const dstDepts = await tx.department.findMany({ where: { tenantId: dst }, select: { id: true, name: true } })
        const twinByName = new Map(dstDepts.map((d) => [d.name, d.id]))
        for (const d of srcDepts) {
          const twin = twinByName.get(d.name)
          if (twin) {
            await tx.position.updateMany({ where: { departmentId: d.id }, data: { departmentId: twin } })
            await tx.department.delete({ where: { id: d.id } })
          } else {
            await tx.department.update({ where: { id: d.id }, data: { tenantId: dst } })
          }
        }
      }
      const srcBands = await tx.shiftBand.findMany({ where: { tenantId: src }, select: { id: true, name: true } })
      if (srcBands.length > 0) {
        const dstBands = await tx.shiftBand.findMany({ where: { tenantId: dst }, select: { id: true, name: true } })
        const twinByName = new Map(dstBands.map((b) => [b.name, b.id]))
        for (const b of srcBands) {
          const twin = twinByName.get(b.name)
          if (twin) {
            await tx.position.updateMany({ where: { shiftBandId: b.id }, data: { shiftBandId: twin } })
            await tx.shiftBand.delete({ where: { id: b.id } })
          } else {
            await tx.shiftBand.update({ where: { id: b.id }, data: { tenantId: dst } })
          }
        }
      }

      // Component par levels — unique on (tenantId, componentId, date); the
      // target's figure wins for a day it already tracks.
      const srcPars = await tx.componentParLevel.findMany({
        where: { tenantId: src }, select: { id: true, componentId: true, date: true },
      })
      if (srcPars.length > 0) {
        const dstPars = await tx.componentParLevel.findMany({
          where: { tenantId: dst, componentId: { in: srcPars.map((p) => p.componentId) } },
          select: { componentId: true, date: true },
        })
        const parKey = (p: { componentId: string; date: Date }) => `${p.componentId}:${p.date.toISOString()}`
        const taken = new Set(dstPars.map(parKey))
        for (const p of srcPars) {
          if (taken.has(parKey(p))) await tx.componentParLevel.delete({ where: { id: p.id } })
          else await tx.componentParLevel.update({ where: { id: p.id }, data: { tenantId: dst } })
        }
      }

      // Inter-company contributions: repoint both ends. One that would now
      // pay the target from the target is meaningless and is closed out.
      await tx.tenantContribution.updateMany({ where: { sourceTenantId: src }, data: { sourceTenantId: dst } })
      await tx.tenantContribution.updateMany({ where: { destinationTenantId: src }, data: { destinationTenantId: dst } })
      await tx.tenantContribution.updateMany({
        where: { sourceTenantId: dst, destinationTenantId: dst, isActive: true },
        data: { isActive: false, endedAt: new Date() },
      })

      // Soft-delete the source tenant
      await tx.tenant.update({
        where: { id: src },
        data: { deletedAt: new Date(), isActive: false },
      })
      return { conceptsMoved: conceptsMoved.count, usersMoved: usersMoved.count, systemSuppliersAbsorbed, ...finance, ...money }
    }, {
      // Many sequential statements — the default 5s interactive-transaction
      // budget is too tight for a company with real history.
      maxWait: 10_000,
      timeout: 60_000,
    })
    return result
  })

  // ── Update tenant — owner edits company name, industry, timezone, etc.
  // No password / no signup; this only mutates safe profile fields. The
  // onboarding wizard hits this on every "Continue". Only a company the
  // operator belongs to — a foreign id 404s rather than confirming it exists.
  // ── Test mode on / off (owner, 2026-10-14; lib/testCompany.ts) — the CEO
  // only, a reason, audited `tenant.test_mode`. ON switches fiscal reporting
  // off; OFF makes it required again (audited), so the company files from its
  // next sale. Membership-checked like PATCH /:id (foreign id → 404).
  fastify.patch<{ Params: { id: string } }>('/:id/test-mode', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      isTest: z.boolean(),
      reason: z.string().trim().min(10).max(500),
    }).parse(req.body)
    if (!req.staffUser!.memberTenantIds.includes(req.params.id)) throw new NotFoundError('Tenant', req.params.id)
    const existing = await prisma.tenant.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, isTest: true },
    })
    if (!existing) throw new NotFoundError('Tenant', req.params.id)
    // The flag and the fiscal switch are written in ONE transaction under the
    // connector lock (fr-3) — PUT /connectors/fiscal/reporting-required takes
    // the same lock and re-reads isTest there, so the two never disagree.
    // ON switches reporting off; OFF makes it required again and stamps
    // reportingRequiredSince, so the test sales are never filed (fr-2).
    const wantRequired = !body.isTest
    // Nothing to change: no write, never a no-op audit row.
    if (existing.isTest === body.isTest && (await fiscalReportingRequired(existing.id)) === wantRequired) {
      return { ...(await prisma.tenant.findUniqueOrThrow({ where: { id: existing.id } })), fiscalReportingRequired: wantRequired }
    }
    let wasTest = existing.isTest
    const fiscal = await setFiscalReportingRequired(existing.id, wantRequired, {
      userId: req.staffUser!.id, userEmail: req.staffUser!.email,
      reason: body.isTest ? `Test company: ${body.reason}` : `Test mode off: ${body.reason}`,
    }, {
      underLock: async (tx) => {
        const cur = await tx.tenant.findUniqueOrThrow({ where: { id: existing.id }, select: { isTest: true } })
        wasTest = cur.isTest
        if (cur.isTest !== body.isTest) await tx.tenant.update({ where: { id: existing.id }, data: { isTest: body.isTest } })
        // A test company made real files from NOW, even if its switch was
        // somehow already on — never its test sales.
        return { stampSince: cur.isTest && !body.isTest }
      },
    })
    invalidateTestTenants()
    if (wasTest !== body.isTest) {
      await audit({
        category: 'identity', action: 'tenant.test_mode', entity: 'Tenant', entityId: existing.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: existing.id,
        before: { isTest: wasTest }, after: { isTest: body.isTest }, metadata: { reason: body.reason },
      })
    }
    const updated = await prisma.tenant.findUniqueOrThrow({ where: { id: existing.id } })
    return { ...updated, fiscalReportingRequired: fiscal.fiscalReportingRequired, heldCount: fiscal.heldCount, heldNote: fiscal.heldNote }
  })

  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      name:        z.string().min(1).max(200).optional(),
      industry:    z.string().max(40).nullable().optional(),
      countryCode: z.string().length(2).optional(),
      currency:    z.string().length(3).optional(),
      timezone:    z.string().max(64).optional(),
      // JV config: flip a tenant into JV mode and supply the partner shares.
      // Empty jvPartners (null) when isJointVenture=false. Frontend uses
      // this to render "Viva 60% / GS 40%" chips on every cost line.
      isJointVenture: z.boolean().optional(),
      jvPartners: z.array(z.object({
        label: z.string().min(1).max(80),
        pct:   z.number().min(0).max(100),
      })).nullable().optional(),
      // H29: the last month of the company's fiscal year (6 = 30 June). The
      // roll-forward is virtual, so a change re-presents every year at once.
      fiscalYearEndMonth: z.number().int().min(1).max(12).optional(),
      // Required to move the year end once the books were closed across one.
      reason: z.string().trim().max(500).optional(),
    }).parse(req.body)
    // memberTenantIds = every company the operator belongs to (non-GET, so
    // never narrowed by the active-company header).
    if (!req.staffUser!.memberTenantIds.includes(req.params.id)) throw new NotFoundError('Tenant', req.params.id)
    const existing = await prisma.tenant.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true, fiscalYearEndMonth: true },
    })
    if (!existing) throw new NotFoundError('Tenant', req.params.id)
    const { reason, fiscalYearEndMonth, ...profile } = body
    const fromMonth = existing.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH
    const fyChange = fiscalYearEndMonth !== undefined && fiscalYearEndMonth !== fromMonth
    // Once a close has spanned a year end (under the old or the new month),
    // a change re-presents closed years: the CEO says why, it is audited and
    // flagged.
    const afterYearEndClose = fyChange && await closedAcrossYearEnd(prisma, existing.id, [fromMonth, fiscalYearEndMonth!])
    if (afterYearEndClose && (reason?.length ?? 0) < 10) {
      throw new AppError(
        'FY_CHANGE_AFTER_YEAR_END_CLOSE',
        `${existing.name}'s books are already closed across a fiscal year end — moving the year end re-presents those closed years. Give a reason (at least 10 characters) to change it.`,
        409,
      )
    }
    const updated = await prisma.tenant.update({
      where: { id: existing.id },
      data: {
        ...profile,
        ...(fyChange ? { fiscalYearEndMonth } : {}),
        jvPartners: profile.jvPartners === undefined ? undefined : (profile.jvPartners ?? undefined),
      },
    })
    if (fyChange) {
      await audit({ category: 'accounting',
        action: 'tenant.fiscal_year_end',
        entity: 'Tenant',
        entityId: existing.id,
        userId: req.staffUser!.id, tenantId: existing.id,
        userEmail: req.staffUser!.email,
        before: { fiscalYearEndMonth: fromMonth },
        after: { fiscalYearEndMonth },
        metadata: { ip: req.ip, reason: reason ?? null, afterYearEndClose },
      })
      if (afterYearEndClose) {
        const { flagException } = await import('../../lib/exceptions.js')
        await flagException({
          tenantId: existing.id,
          kind: 'period_close_override',
          severity: 'high',
          title: `Fiscal year end moved after a year-end close (month ${fromMonth} → ${fiscalYearEndMonth})`,
          description: `${req.staffUser!.email} changed ${existing.name}'s fiscal year end from month ${fromMonth} to ${fiscalYearEndMonth} after its books were closed across a year end. `
            + `Retained earnings b/f and profit for the year are now split on the new boundary for every year, closed ones included. Reason: ${reason}.`,
          entityType: 'Tenant',
          entityId: existing.id,
          actorId: req.staffUser!.id,
          metadata: { from: fromMonth, to: fiscalYearEndMonth, reason },
        })
      }
    }
    return updated
  })

  // ── Apply a template to the ACTIVE company (in-app — for owners who want
  // to bootstrap a new concept after the initial signup). Binds the new brand
  // to req.staffUser.tenantId, which honours x-servd-active-tenant — never to
  // the user's primary company, or a brand picked for GSX Viva would land in
  // GS Foods.
  fastify.post(
    '/apply-template',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = z.object({
        templateKey: z.enum(TEMPLATE_KEYS as [string, ...string[]]),
        conceptName: z.string().min(1).max(100).optional(),
        // The new brand's primary service vessel — a REQUIRED choice at brand
        // creation, no default (owner's FINAL packaging rule; same field as
        // POST /concepts): 'plate' or 'packaging' (packaging IS the vessel,
        // e.g. Stackd — a dish's Packaging section is used on every order).
        serviceVessel: z.enum(['plate', 'packaging']),
      }).parse(req.body)

      const tpl = getTemplate(body.templateKey)
      if (!tpl) return reply.status(400).send({ error: { code: 'BAD_TEMPLATE' } })

      const tenantId = req.staffUser!.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before applying a template', 422)

      const conceptName = body.conceptName ?? tpl.conceptName
      const conceptSlug = await uniqueSlug(conceptName, 'concept')

      const concept = await prisma.$transaction(async (tx) => {
        const c = await tx.concept.create({
          data: {
            tenantId,
            slug: conceptSlug, name: conceptName, type: tpl.conceptType, serviceVessel: body.serviceVessel,
            primaryColor: tpl.primaryColor, taxRate: tpl.taxRate,
            heroTagline: tpl.heroTagline, isActive: true, storefrontVisible: true,
          },
        })
        const stations = await Promise.all(
          tpl.stations.map((n) => tx.station.create({ data: { conceptId: c.id, name: n } })),
        )
        const stationByName = new Map(stations.map((s) => [s.name, s]))
        const cats = await Promise.all(
          tpl.categories.map((n, i) => tx.category.create({ data: { conceptId: c.id, name: n, sortOrder: i } })),
        )
        const catByName = new Map(cats.map((c) => [c.name, c]))
        for (const it of tpl.items) {
          const cat = catByName.get(it.category)
          if (!cat) continue
          const sid = it.station ? stationByName.get(it.station)?.id ?? null : null
          const m = await tx.menuItem.create({
            data: {
              conceptId: c.id, categoryId: cat.id, name: it.name, nameUrdu: it.nameUrdu ?? null,
              description: it.description ?? null, priceCents: it.priceCents, stationId: sid, isAvailable: true,
            },
          })
          if (it.recipe) {
            await tx.recipe.create({
              data: {
                menuItemId: m.id, servings: 1,
                laborMinutes: it.recipe.laborMinutes ?? 0,
                steps: it.recipe.steps ?? null,
                seasons: it.recipe.seasons ?? [],
                isActive: true,
              },
            })
          }
        }
        return c
      })

      return reply.status(201).send({ conceptId: concept.id, conceptSlug: concept.slug })
    },
  )
}
