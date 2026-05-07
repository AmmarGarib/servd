// Wipe-and-reset — return the database to a "fresh project" state.
//
// PRESERVES (so the app still boots and you can log in):
//   • Tenant rows
//   • Account / chart-of-accounts (required by journal posting)
//   • Permission seeds (RolePermission)
//   • Admin User rows
//
// WIPES EVERYTHING ELSE in FK-safe order. Idempotent; singletons auto-recreate.
//
// Run:  npx tsx scripts/wipe-and-reset.ts
// Pass --include-admins to also wipe admin users (true nuclear).

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({ log: ['warn', 'error'] })
const includeAdmins = process.argv.includes('--include-admins')

async function main() {
  console.log('\n━━━ Wipe & Reset ━━━')
  console.log(`  Admin users: ${includeAdmins ? 'WIPE' : 'PRESERVE'}\n`)

  const before = await snapshot()
  console.log('Before:')
  for (const [k, v] of Object.entries(before)) console.log(`  ${k.padEnd(28)} ${v.toString().padStart(7)}`)
  console.log('')

  // FK-safe order: leaves first, roots last.
  const ops: Array<[string, () => Promise<unknown>]> = [
    // ── Reviews / complaints (FKs to Order, Customer, MenuItem) ────
    ['orderReviews',                  () => prisma.orderReview.deleteMany()],
    ['orderComplaints',               () => prisma.orderComplaint.deleteMany()],

    // ── Order graph (children → parents) ────────────────────────────
    ['orderItemModifiers',            () => prisma.orderItemModifier.deleteMany()],
    ['payments',                      () => prisma.payment.deleteMany()],
    ['orderItems',                    () => prisma.orderItem.deleteMany()],
    ['financialEntries',              () => prisma.financialEntry.deleteMany()],   // BEFORE orders
    ['taxInvoiceLines',               () => prisma.taxInvoiceLine.deleteMany()],
    ['taxInvoices',                   () => prisma.taxInvoice.deleteMany()],
    ['orders',                        () => prisma.order.deleteMany()],

    // ── Group orders ────────────────────────────────────────────────
    ['groupOrderItems',               () => prisma.groupOrderItem.deleteMany()],
    ['groupOrderMembers',             () => prisma.groupOrderMember.deleteMany()],
    ['groupOrders',                   () => prisma.groupOrder.deleteMany()],

    // ── Tips ────────────────────────────────────────────────────────
    ['tipPoolMembers',                () => prisma.tipPoolMember.deleteMany()],
    ['tipPools',                      () => prisma.tipPool.deleteMany()],

    // ── Shifts / payroll / clocks / audit ──────────────────────────
    ['payrollRunLines',               () => prisma.payrollRunLine.deleteMany()],
    ['payrollRuns',                   () => prisma.payrollRun.deleteMany()],
    ['clockLogs',                     () => prisma.clockLog.deleteMany()],
    ['shifts',                        () => prisma.shift.deleteMany()],
    ['scheduledShifts',               () => prisma.scheduledShift.deleteMany()],

    // ── Journal / period locks / cost alloc ────────────────────────
    ['journalLines',                  () => prisma.journalLine.deleteMany()],
    ['journalEntries',                () => prisma.journalEntry.deleteMany()],
    ['periodLocks',                   () => prisma.periodLock.deleteMany()],
    ['costAllocationRuns',            () => prisma.costAllocationRun.deleteMany()],
    ['allocationRuleWeights',         () => prisma.allocationRuleWeight.deleteMany()],
    ['costAllocationRules',           () => prisma.costAllocationRule.deleteMany()],
    ['invoiceCounters',               () => prisma.invoiceCounter.deleteMany()],

    // ── Procurement ────────────────────────────────────────────────
    ['supplierPaymentApplications',   () => prisma.supplierPaymentApplication.deleteMany()],
    ['supplierPayments',              () => prisma.supplierPayment.deleteMany()],
    ['supplierBillLines',             () => prisma.supplierBillLine.deleteMany()],
    ['supplierBills',                 () => prisma.supplierBill.deleteMany()],
    ['receivingDiscrepancies',        () => prisma.receivingDiscrepancy.deleteMany()],
    ['poActivityLogs',                () => prisma.poActivityLog.deleteMany()],
    ['purchaseOrderLines',            () => prisma.purchaseOrderLine.deleteMany()],
    ['purchaseOrders',                () => prisma.purchaseOrder.deleteMany()],
    ['supplierMessages',              () => prisma.supplierMessage.deleteMany()],
    ['supplierConversations',         () => prisma.supplierConversation.deleteMany()],
    ['supplierPortalTokens',          () => prisma.supplierPortalToken.deleteMany()],
    ['suppliers',                     () => prisma.supplier.deleteMany()],

    // ── Bank reconciliation ────────────────────────────────────────
    ['bankStatementLines',            () => prisma.bankStatementLine.deleteMany()],
    ['bankStatementImports',          () => prisma.bankStatementImport.deleteMany()],
    ['foodpandaSettlements',          () => prisma.foodpandaSettlement.deleteMany()],

    // ── Inventory / recipes / components ───────────────────────────
    ['wasteLogs',                     () => prisma.wasteLog.deleteMany()],
    ['itemPriceHistory',              () => prisma.itemPriceHistory.deleteMany()],
    ['recipeIngredients',             () => prisma.recipeIngredient.deleteMany()],
    ['recipes',                       () => prisma.recipe.deleteMany()],
    ['componentBrandUses',            () => prisma.componentBrandUse.deleteMany()],
    ['components',                    () => prisma.component.deleteMany()],
    ['inventoryItems',                () => prisma.inventoryItem.deleteMany()],

    // ── Menu / pricing ─────────────────────────────────────────────
    ['modifiers',                     () => prisma.modifier.deleteMany()],
    ['modifierGroups',                () => prisma.modifierGroup.deleteMany()],
    ['modifierTemplateOptions',       () => prisma.modifierTemplateOption.deleteMany()],
    ['modifierTemplates',             () => prisma.modifierTemplate.deleteMany()],
    ['menuItems',                     () => prisma.menuItem.deleteMany()],
    ['categories',                    () => prisma.category.deleteMany()],
    ['sectionDiscounts',              () => prisma.sectionDiscount.deleteMany()],
    ['storefrontPromos',              () => prisma.storefrontPromo.deleteMany()],

    // ── Reservations / floor / tables ──────────────────────────────
    ['reservations',                  () => prisma.reservation.deleteMany()],
    ['conceptBlockouts',              () => prisma.conceptBlockout.deleteMany()],
    ['tables',                        () => prisma.table.deleteMany()],
    ['floors',                        () => prisma.floor.deleteMany()],

    // ── CRM / loyalty / wallet / promo ─────────────────────────────
    ['customerSegmentMemberships',    () => prisma.customerSegmentMembership.deleteMany()],
    ['customerSegments',              () => prisma.customerSegment.deleteMany()],
    ['guestTags',                     () => prisma.guestTag.deleteMany()],
    ['walletTransactions',            () => prisma.walletTransaction.deleteMany()],
    ['loyaltyTransactions',           () => prisma.loyaltyTransaction.deleteMany()],
    ['loyaltyAccounts',               () => prisma.loyaltyAccount.deleteMany()],
    ['promoCodeUsages',               () => prisma.promoCodeUsage.deleteMany()],
    ['promoCodes',                    () => prisma.promoCode.deleteMany()],
    ['giftCardRedemptions',           () => prisma.giftCardRedemption.deleteMany()],
    ['giftCards',                     () => prisma.giftCard.deleteMany()],
    ['abandonedCarts',                () => prisma.abandonedCart.deleteMany()],
    ['magicLinks',                    () => prisma.magicLink.deleteMany()],     // BEFORE customers
    ['customerAddresses',             () => prisma.customerAddress.deleteMany()],
    ['customers',                     () => prisma.customer.deleteMany()],

    // ── Riders / dispatch / QR ─────────────────────────────────────
    ['riderLocations',                () => prisma.riderLocation.deleteMany()],
    ['riders',                        () => prisma.rider.deleteMany()],
    ['qrCodes',                       () => prisma.qrCode.deleteMany()],

    // ── Marketing / content ────────────────────────────────────────
    ['campaignSends',                 () => prisma.campaignSend.deleteMany()],
    ['campaigns',                     () => prisma.campaign.deleteMany()],
    ['socialPosts',                   () => prisma.socialPost.deleteMany()],
    ['contentEvents',                 () => prisma.contentEvent.deleteMany()],
    ['triggerLogs',                   () => prisma.triggerLog.deleteMany()],
    ['automationTriggers',            () => prisma.automationTrigger.deleteMany()],
    ['analyticsEvents',               () => prisma.analyticsEvent.deleteMany()],
    ['mediaAssets',                   () => prisma.mediaAsset.deleteMany()],
    ['siteLayouts',                   () => prisma.siteLayout.deleteMany()],

    // ── Finance planning ───────────────────────────────────────────
    ['proFormaChannels',              () => prisma.proFormaChannel.deleteMany()],
    ['proFormaFixedCosts',            () => prisma.proFormaFixedCost.deleteMany()],
    ['proFormaMonths',                () => prisma.proFormaMonth.deleteMany()],
    ['proFormas',                     () => prisma.proForma.deleteMany()],
    ['capexLines',                    () => prisma.capexLine.deleteMany()],
    ['capexProjects',                 () => prisma.capexProject.deleteMany()],
    ['capitalLedgerEntries',          () => prisma.capitalLedgerEntry.deleteMany()],

    // ── Devices / KDS / stations ───────────────────────────────────
    ['kdsDevices',                    () => prisma.kdsDevice.deleteMany()],
    ['stations',                      () => prisma.station.deleteMany()],

    // ── Setup singletons + lookups ─────────────────────────────────
    ['deliveryZones',                 () => prisma.deliveryZone.deleteMany()],
    ['notificationTemplates',         () => prisma.notificationTemplate.deleteMany()],
    ['bankAccounts',                  () => prisma.bankAccount.deleteMany()],
    ['webhookSubscriptions',          () => prisma.webhookSubscription.deleteMany()],
    ['customFieldValues',             () => prisma.customFieldValue.deleteMany()],
    ['customFieldDefinitions',        () => prisma.customFieldDefinition.deleteMany()],
    ['scheduledReports',              () => prisma.scheduledReport.deleteMany()],
    ['paymentGatewayConfigs',         () => prisma.paymentGatewayConfig.deleteMany()],
    ['serviceHours',                  () => prisma.serviceHours.deleteMany()],
    ['settings',                      () => prisma.setting.deleteMany()],
    ['refundPolicies',                () => prisma.refundPolicy.deleteMany()],
    ['reservationPolicies',           () => prisma.reservationPolicy.deleteMany()],
    ['receiptConfigs',                () => prisma.receiptConfig.deleteMany()],
    ['operationsConfigs',             () => prisma.operationsConfig.deleteMany()],
    ['apiTokens',                     () => prisma.apiToken.deleteMany()],

    // ── Audit (fresh slate) ────────────────────────────────────────
    ['auditLogs',                     () => prisma.auditLog.deleteMany()],

    // ── Concept / location anchor ──────────────────────────────────
    ['conceptLocations',              () => prisma.conceptLocation.deleteMany()],
    ['concepts',                      () => prisma.concept.deleteMany()],
    ['locations',                     () => prisma.location.deleteMany()],

    // ── Domains ────────────────────────────────────────────────────
    ['domains',                       () => prisma.domain.deleteMany()],

    // ── Segments (cross-customer) ──────────────────────────────────
    ['segments',                      () => prisma.segment.deleteMany()],
  ]

  if (includeAdmins) {
    ops.push(['users (ALL)', () => prisma.user.deleteMany()])
  } else {
    ops.push(['users (non-admin)', () => prisma.user.deleteMany({ where: { role: { not: 'admin' } } })])
  }

  let totalRemoved = 0
  let totalFailed = 0
  for (const [label, fn] of ops) {
    try {
      const r = (await fn()) as { count?: number } | null
      const count = r && typeof r === 'object' && 'count' in r ? (r.count ?? 0) : 0
      if (count > 0) {
        console.log(`  ✓ ${label.padEnd(34)} ${count.toString().padStart(7)}  removed`)
        totalRemoved += count
      }
    } catch (err) {
      console.warn(`  ⚠ ${label.padEnd(34)}  ${(err as Error).message.slice(0, 100)}`)
      totalFailed++
    }
  }

  console.log('\nAfter:')
  const after = await snapshot()
  for (const [k, v] of Object.entries(after)) console.log(`  ${k.padEnd(28)} ${v.toString().padStart(7)}`)

  console.log(`\n━━━ Wipe complete · ${totalRemoved.toLocaleString()} rows removed${totalFailed > 0 ? ` · ${totalFailed} failed` : ''} ━━━`)
  console.log('  Tenants, admin users, chart-of-accounts and permission seeds preserved.')
  console.log('  Singletons (refund/reservation/receipt/operations) auto-recreate on first read.')
}

async function snapshot() {
  return {
    tenants:           await prisma.tenant.count(),
    users:             await prisma.user.count(),
    'users (admin)':   await prisma.user.count({ where: { role: 'admin' } }),
    accounts:          await prisma.account.count(),
    rolePermissions:   await prisma.rolePermission.count(),
    concepts:          await prisma.concept.count(),
    locations:         await prisma.location.count(),
    menuItems:         await prisma.menuItem.count(),
    inventoryItems:    await prisma.inventoryItem.count(),
    customers:         await prisma.customer.count(),
    suppliers:         await prisma.supplier.count(),
    orders:            await prisma.order.count(),
    shifts:            await prisma.shift.count(),
    journalEntries:    await prisma.journalEntry.count(),
    auditLogs:         await prisma.auditLog.count(),
  }
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
