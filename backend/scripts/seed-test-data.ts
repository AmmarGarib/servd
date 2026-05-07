// UAT test-data seeder.
//
// Idempotent: only inserts when its own marker rows are missing. Designed to
// give a freshly-deployed environment enough realistic activity that testers
// can immediately exercise the ledger, payroll, supplier, and reconciliation
// flows without hand-curating data.
//
// Run AFTER the main seed (pnpm db:seed):
//   pnpm --filter @servd/api exec tsx scripts/seed-test-data.ts
//
// What it creates:
//   • 4 staff (1 manager, 1 cashier, 2 kitchen) with hourly rates + concept
//     scoping. Predictable PINs so testers can sign in.
//   • 2 weeks of clock-in/out events for those staff
//   • A supplier with one open bill, one paid bill, one bill awaiting payment
//   • A handful of completed orders across 3 concepts (cash + card + Foodpanda)
//   • One refunded order (so reversal posting is visible in the ledger)
//   • One closed POS shift with a small cash variance
//   • A simple cost-allocation rule (rent, fixed_pct)

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { ingestOrder } from '../src/modules/orders/service.js'
import { updateOrderStatus, updateItemStatus } from '../src/modules/orders/service.js'
import { createBill, createPayment } from '../src/modules/procurement/service.js'

const TEST_MARKER = 'uat-test-data'

const prisma = new PrismaClient()

async function alreadySeeded(): Promise<boolean> {
  const u = await prisma.user.findFirst({ where: { email: 'manager.uat@servd.pk' } })
  return !!u
}

async function main() {
  if (await alreadySeeded()) {
    console.info('✓ Test data already present — skipping.')
    return
  }

  console.info('Seeding UAT test data…')

  const concepts = await prisma.concept.findMany({
    where: { isActive: true },
    select: { id: true, slug: true, name: true, taxRate: true },
    orderBy: { slug: 'asc' },
  })
  if (concepts.length < 2) {
    throw new Error('Need at least 2 active concepts before seeding test data — run the main seed first.')
  }
  const conceptBySlug = new Map(concepts.map((c) => [c.slug, c]))

  // ─── Staff ────────────────────────────────────────────────────────────
  const allConceptIds = concepts.map((c) => c.id)
  const staff = [
    { email: 'manager.uat@servd.pk',  name: 'UAT Manager',  pin: '1010', role: 'manager' as const, hourlyRateCents: 80000, wageAccountCode: '6032', conceptIds: allConceptIds },
    { email: 'cashier.uat@servd.pk',  name: 'UAT Cashier',  pin: '2020', role: 'cashier' as const, hourlyRateCents: 35000, wageAccountCode: '6031', conceptIds: [conceptBySlug.get('simmer')?.id ?? allConceptIds[0]!] },
    { email: 'kitchen1.uat@servd.pk', name: 'UAT Kitchen 1', pin: '3030', role: 'kitchen' as const, hourlyRateCents: 30000, wageAccountCode: '6030', conceptIds: [conceptBySlug.get('stax')?.id ?? allConceptIds[0]!] },
    { email: 'kitchen2.uat@servd.pk', name: 'UAT Kitchen 2', pin: '4040', role: 'kitchen' as const, hourlyRateCents: 30000, wageAccountCode: '6030', conceptIds: [conceptBySlug.get('strata')?.id ?? allConceptIds[0]!] },
  ]

  const created: Record<string, string> = {}
  for (const s of staff) {
    const password = await bcrypt.hash('TestPass123!', 12)
    const pin = await bcrypt.hash(s.pin, 10)
    const u = await prisma.user.create({
      data: {
        name: s.name, email: s.email, password, pin,
        role: s.role, isActive: true,
        conceptIds: s.conceptIds,
        hourlyRateCents: s.hourlyRateCents,
        wageAccountCode: s.wageAccountCode,
      },
      select: { id: true, name: true },
    })
    created[s.email] = u.id
    console.info(`  ✓ staff: ${s.role.padEnd(8)} ${s.name} (PIN ${s.pin}, password TestPass123!)`)
  }

  // ─── Clock log: 2 weeks of 8-hour days ─────────────────────────────────
  const now = new Date()
  const days = 14
  for (const email of Object.keys(created)) {
    const userId = created[email]!
    if (email === 'manager.uat@servd.pk') continue   // managers don't clock in here
    for (let d = days; d >= 1; d--) {
      const dayStart = new Date(now.getTime() - d * 86_400_000)
      dayStart.setHours(11, 0, 0, 0)   // 11:00 PKT
      const dayEnd = new Date(dayStart.getTime() + 8 * 3600_000) // 19:00
      await prisma.clockLog.createMany({
        data: [
          { userId, type: 'in',  recordedAt: dayStart },
          { userId, type: 'out', recordedAt: dayEnd },
        ],
      })
    }
  }
  console.info(`  ✓ clock logs: ${days} days × 3 staff`)

  // ─── Supplier + bills + payment ────────────────────────────────────────
  const supplier = await prisma.supplier.create({
    data: { name: 'UAT Test Supplier Co.', paymentTermsDays: 14, isActive: true },
  })
  const inventoryItem = await prisma.inventoryItem.findFirst({ where: { deletedAt: null } })
  if (inventoryItem) {
    const billLines = [
      { description: 'Smoke test SKU', quantity: 10, unitCostCents: 5000, inventoryItemId: inventoryItem.id },
    ]
    await createBill({
      supplierId: supplier.id, billNumber: 'UAT-001',
      billDate: new Date(now.getTime() - 20 * 86_400_000).toISOString(),
      dueDate:  new Date(now.getTime() -  5 * 86_400_000).toISOString(),
      taxCents: 8500,
      lines: billLines,
      createdBy: created['manager.uat@servd.pk']!,
    })
    await createBill({
      supplierId: supplier.id, billNumber: 'UAT-002',
      billDate: new Date(now.getTime() -  3 * 86_400_000).toISOString(),
      taxCents: 8500,
      lines: billLines,
      createdBy: created['manager.uat@servd.pk']!,
    })
    const paid = await createBill({
      supplierId: supplier.id, billNumber: 'UAT-003',
      billDate: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      taxCents: 8500,
      lines: billLines,
      createdBy: created['manager.uat@servd.pk']!,
    })
    await createPayment({
      supplierId: supplier.id,
      paymentDate: new Date().toISOString(),
      method: 'bank_transfer',
      reference: 'TEST-PAY-001',
      amountCents: paid.totalCents,
      applications: [{ billId: paid.id, amountAppliedCents: paid.totalCents }],
      createdBy: created['manager.uat@servd.pk']!,
    })
    console.info('  ✓ supplier, 3 bills (1 overdue, 1 open, 1 paid)')
  }

  // ─── Orders: a mix of channels and outcomes ────────────────────────────
  const conceptsToUse = concepts.slice(0, 3)
  const orderTemplates: Array<{
    conceptSlug: string; source: 'servd'|'foodpanda'|'pos'|'manual'; payment: 'cash'|'card'; total: number; willRefund?: boolean
  }> = [
    { conceptSlug: conceptsToUse[0]!.slug, source: 'servd',     payment: 'card', total: 117000 },
    { conceptSlug: conceptsToUse[0]!.slug, source: 'servd',     payment: 'card', total:  85000 },
    { conceptSlug: conceptsToUse[1]!.slug, source: 'foodpanda', payment: 'card', total: 250000 },
    { conceptSlug: conceptsToUse[1]!.slug, source: 'manual',    payment: 'cash', total:  90000 },
    { conceptSlug: conceptsToUse[2]!.slug, source: 'servd',     payment: 'card', total: 175000, willRefund: true },
  ]

  for (const t of orderTemplates) {
    const concept = conceptBySlug.get(t.conceptSlug)
    if (!concept) continue
    const taxRate = concept.taxRate / 100
    const taxCents = Math.round(t.total * taxRate / (1 + taxRate))

    const result = await ingestOrder({
      source: t.source as never,
      external_id: `uat-${TEST_MARKER}-${Math.random().toString(36).slice(2, 10)}`,
      concept_id: concept.id,
      placed_at: new Date().toISOString(),
      customer_id: null,
      customer_name: 'UAT Test Customer',
      items: [
        { externalItemId: 'uat', menuItemId: null, name: 'UAT Test Item', quantity: 1, unitPriceCents: t.total, modifiers: [] },
      ],
      payment: { provider: t.payment === 'cash' ? 'cash' : 'keenu', amountCents: t.total, status: 'paid' },
      loyalty_points_earned: null,
      delivery_notes: null,
      estimated_pickup: null,
    } as never)

    // Record tax on the order (ingestOrder doesn't set it — it's storefront-only)
    await prisma.order.update({
      where: { id: result.order.id },
      data: { taxCents, status: 'received' },
    })

    // Bump items to mark complete (this triggers postOrderCompletion via the KDS path)
    const items = await prisma.orderItem.findMany({ where: { orderId: result.order.id } })
    for (const it of items) {
      await updateItemStatus(it.id, 'bumped' as never)
    }

    if (t.willRefund) {
      await updateOrderStatus(result.order.id, 'refunded' as never)
      console.info(`  ✓ order: ${t.source}/${t.conceptSlug}/${t.payment} ${(t.total/100).toFixed(0)} PKR (REFUNDED)`)
    } else {
      console.info(`  ✓ order: ${t.source}/${t.conceptSlug}/${t.payment} ${(t.total/100).toFixed(0)} PKR`)
    }
  }

  // ─── Cost allocation rule ──────────────────────────────────────────────
  const conceptsForRule = concepts.slice(0, 4)
  if (conceptsForRule.length >= 2) {
    const baseBps = Math.floor(10_000 / conceptsForRule.length)
    const weights = conceptsForRule.map((c, i) => ({
      conceptId: c.id,
      weightBps: i === conceptsForRule.length - 1
        ? 10_000 - baseBps * (conceptsForRule.length - 1) // give residue to last
        : baseBps,
    }))
    await prisma.costAllocationRule.upsert({
      where: { sourceAccountCode: '6010' },
      create: {
        name: 'Rent — equal split across active concepts',
        sourceAccountCode: '6010',
        driver: 'fixed_pct',
        isActive: true,
        weights: { create: weights },
      },
      update: {},
    })
    console.info('  ✓ allocation rule: rent (6010) → equal split')
  }

  console.info('')
  console.info('UAT test data seeded. Sign in as one of:')
  console.info('  manager.uat@servd.pk  / TestPass123!  (PIN 1010)')
  console.info('  cashier.uat@servd.pk  / TestPass123!  (PIN 2020)')
  console.info('  kitchen1.uat@servd.pk / TestPass123!  (PIN 3030)')
  console.info('  kitchen2.uat@servd.pk / TestPass123!  (PIN 4040)')
}

void main()
  .catch((err) => {
    console.error('Test data seed failed:', err)
    process.exit(1)
  })
  .finally(() => {
    void prisma.$disconnect()
  })
