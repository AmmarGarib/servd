/**
 * End-to-end smoke test for the order pipeline.
 *
 * What it does:
 *   1. Sets up a "Smoke Test Cafe" concept with stations, menu, recipes, inventory.
 *   2. Calls ingestOrder() — the same path POS/storefront/aggregators use.
 *   3. Verifies: order persisted, items routed to stations, inventory deducted,
 *      course pacing schedules computed, auto-86 fires when stock hits zero.
 *   4. Walks an order through the full lifecycle: pending → preparing → ready
 *      → bumped → completed.
 *   5. Cleans up — no stale data left behind.
 *
 * Run with:  npm run smoke
 *
 * Exit codes:
 *   0  — all assertions passed
 *   1  — one or more failures (full stack traces dumped on first error)
 */

import { PrismaClient, type OrderStatus } from '@prisma/client'
import { ingestOrder, scheduleCoursePacing, processCoursePacingTick, deductInventoryForOrder, updateItemStatus, updateOrderStatus } from '../src/modules/orders/service.js'

const prisma = new PrismaClient()

// ─── Tiny assertion harness ────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`)
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

function header(s: string) {
  console.log(`\n━━━ ${s} ━━━`)
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

const SMOKE_SLUG = 'smoke-test-cafe'

async function cleanup() {
  // Delete in dependency order to avoid FK violations
  const concept = await prisma.concept.findUnique({ where: { slug: SMOKE_SLUG } })
  if (!concept) return

  const orders = await prisma.order.findMany({ where: { conceptId: concept.id }, select: { id: true } })
  const orderIds = orders.map((o) => o.id)
  if (orderIds.length > 0) {
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: orderIds } } } })
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.financialEntry.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  }

  // Wipe recipes + ingredients
  const recipes = await prisma.recipe.findMany({
    where: { menuItem: { conceptId: concept.id } },
    select: { id: true },
  })
  if (recipes.length > 0) {
    await prisma.recipeIngredient.deleteMany({ where: { recipeId: { in: recipes.map((r) => r.id) } } })
    await prisma.recipe.deleteMany({ where: { id: { in: recipes.map((r) => r.id) } } })
  }

  await prisma.modifierGroup.deleteMany({ where: { menuItem: { conceptId: concept.id } } })
  await prisma.menuItem.deleteMany({ where: { conceptId: concept.id } })
  await prisma.category.deleteMany({ where: { conceptId: concept.id } })
  await prisma.station.deleteMany({ where: { conceptId: concept.id } })
  // Inventory is global — match by our naming prefix to keep cleanup safe
  await prisma.inventoryItem.deleteMany({ where: { name: { startsWith: 'Smoke-Test ' } } })
  await prisma.concept.delete({ where: { id: concept.id } })
}

async function setup() {
  await cleanup()

  const concept = await prisma.concept.create({
    data: {
      slug: SMOKE_SLUG,
      name: 'Smoke Test Cafe',
      type: 'restaurant',
      taxRate: 17,
      isActive: true,
    },
  })

  const grill = await prisma.station.create({
    data: { conceptId: concept.id, name: 'Grill' },
  })
  const cold = await prisma.station.create({
    data: { conceptId: concept.id, name: 'Cold Bar' },
  })

  const cat = await prisma.category.create({
    data: { conceptId: concept.id, name: 'Mains', sortOrder: 0 },
  })

  // Inventory ingredients (we'll deplete one to test auto-86).
  // Note: inventory is global (no conceptId in schema).
  const chicken = await prisma.inventoryItem.create({
    data: {
      name: 'Smoke-Test Chicken', unit: 'kg',
      currentStock: 5.0, parLevel: 2, unitCostCents: 800_00,
    },
  })
  const lettuce = await prisma.inventoryItem.create({
    data: {
      name: 'Smoke-Test Lettuce', unit: 'kg',
      currentStock: 0.05, parLevel: 1, unitCostCents: 100_00,
    },
  })

  // Three menu items with progressively longer cook times — to validate pacing
  const burger = await prisma.menuItem.create({
    data: {
      conceptId: concept.id, categoryId: cat.id,
      name: 'Smoked Chicken Burger', priceCents: 850_00,
      stationId: grill.id, isAvailable: true,
    },
  })
  const salad = await prisma.menuItem.create({
    data: {
      conceptId: concept.id, categoryId: cat.id,
      name: 'Caesar Salad', priceCents: 650_00,
      stationId: cold.id, isAvailable: true,
    },
  })
  const drink = await prisma.menuItem.create({
    data: {
      conceptId: concept.id, categoryId: cat.id,
      name: 'Mint Lemonade', priceCents: 250_00,
      stationId: cold.id, isAvailable: true,
    },
  })

  // Recipes — burger uses 0.2 kg chicken (12 min cook), salad uses 0.1 kg lettuce (5 min)
  await prisma.recipe.create({
    data: {
      menuItemId: burger.id, servings: 1, laborMinutes: 12,
      ingredients: { create: [{ inventoryItemId: chicken.id, quantity: 0.2, unit: 'kg', yieldPct: 0.95 }] },
    },
  })
  await prisma.recipe.create({
    data: {
      menuItemId: salad.id, servings: 1, laborMinutes: 5,
      ingredients: { create: [{ inventoryItemId: lettuce.id, quantity: 0.1, unit: 'kg', yieldPct: 0.95 }] },
    },
  })
  // No recipe for the drink — should still work and fire instantly

  return { conceptId: concept.id, grillId: grill.id, coldId: cold.id, burgerId: burger.id, saladId: salad.id, drinkId: drink.id, chickenId: chicken.id, lettuceId: lettuce.id }
}

// ─── Test runs ────────────────────────────────────────────────────────────────

async function testOrderIngestion(ctx: Awaited<ReturnType<typeof setup>>) {
  header('Test 1: order ingestion + station routing')

  const result = await ingestOrder({
    source: 'pos',
    external_id: `smoke-pos-${Date.now()}`,
    concept_id: ctx.conceptId,
    placed_at: new Date().toISOString(),
    customer_id: null,
    customer_name: 'Smoke Test Customer',
    items: [
      { externalItemId: 'burger', menuItemId: ctx.burgerId, name: 'Smoked Chicken Burger', quantity: 1, unitPriceCents: 850_00, modifiers: [] },
      { externalItemId: 'salad',  menuItemId: ctx.saladId,  name: 'Caesar Salad',          quantity: 1, unitPriceCents: 650_00, modifiers: [] },
      { externalItemId: 'drink',  menuItemId: ctx.drinkId,  name: 'Mint Lemonade',         quantity: 1, unitPriceCents: 250_00, modifiers: [] },
    ],
    payment: { provider: 'cash', amountCents: 1750_00, status: 'paid' },
    loyalty_points_earned: null,
    delivery_notes: null,
    estimated_pickup: null,
  } as Parameters<typeof ingestOrder>[0])

  // ingestOrder fires deduction + pacing fire-and-forget. For deterministic
  // assertions against a cloud DB, await the same calls explicitly here.
  // (deductInventoryForOrder is now race-safe via atomic SQL clamp, so calling
  // it twice no-ops the second time once stock is already drained.)
  await scheduleCoursePacing(result.order.id)
  // Give the fire-and-forget deduction time to land
  await new Promise((r) => setTimeout(r, 1500))

  check('Order created', !!result.order)
  check('Returned as new (not duplicate)', result.created === true)

  const order = await prisma.order.findUnique({
    where: { id: result.order.id },
    include: { items: { include: { station: true } } },
  })
  check('Persisted with 3 items', order?.items.length === 3)

  // Each item routed to its menuItem.stationId
  const burgerItem = order?.items.find((i) => i.menuItemId === ctx.burgerId)
  const saladItem  = order?.items.find((i) => i.menuItemId === ctx.saladId)
  check('Burger routed to grill', burgerItem?.stationId === ctx.grillId, `expected ${ctx.grillId}, got ${burgerItem?.stationId}`)
  check('Salad routed to cold bar', saladItem?.stationId === ctx.coldId)
  check('All items start as pending', order?.items.every((i) => i.status === 'pending') === true)

  return result.order.id
}

async function testCoursePacing(orderId: string) {
  header('Test 2: course pacing (smart fire timing)')

  // We've already awaited scheduleCoursePacing in the previous test.
  const items = await prisma.orderItem.findMany({
    where: { orderId },
    include: { menuItem: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })

  // Burger has highest labor (12min) → fires NOW (earliest scheduledFireAt or null)
  // Salad (5min) fires +7min later
  // Drink (0min, no recipe) fires +12min later
  const burger = items.find((i) => i.menuItem?.name === 'Smoked Chicken Burger')
  const salad  = items.find((i) => i.menuItem?.name === 'Caesar Salad')
  const drink  = items.find((i) => i.menuItem?.name === 'Mint Lemonade')

  check('All items have scheduledFireAt set', items.every((i) => i.scheduledFireAt !== null))

  if (burger?.scheduledFireAt && salad?.scheduledFireAt && drink?.scheduledFireAt) {
    const burgerT = burger.scheduledFireAt.getTime()
    const saladT = salad.scheduledFireAt.getTime()
    const drinkT = drink.scheduledFireAt.getTime()

    check('Burger (longest cook) fires earliest',
      burgerT <= saladT && burgerT <= drinkT,
      `burger=${new Date(burgerT).toISOString()}, salad=${new Date(saladT).toISOString()}, drink=${new Date(drinkT).toISOString()}`)
    check('Salad fires ~7min after burger',
      Math.abs((saladT - burgerT) / 60000 - 7) < 0.5,
      `delta = ${((saladT - burgerT) / 60000).toFixed(1)} min`)
    check('Drink fires ~12min after burger',
      Math.abs((drinkT - burgerT) / 60000 - 12) < 0.5,
      `delta = ${((drinkT - burgerT) / 60000).toFixed(1)} min`)
  }

  // Force burger's fire time to past, run the worker tick
  await prisma.orderItem.update({
    where: { id: burger!.id },
    data: { scheduledFireAt: new Date(Date.now() - 1_000) },
  })
  const fired = await processCoursePacingTick()
  check('Worker fires due items (status → preparing)', fired >= 1, `fired count = ${fired}`)

  const burgerAfter = await prisma.orderItem.findUnique({ where: { id: burger!.id } })
  check('Burger status now "preparing"', burgerAfter?.status === 'preparing')
  check('Burger firedAt timestamp set', burgerAfter?.firedAt !== null)
}

async function testInventoryDeduction(ctx: Awaited<ReturnType<typeof setup>>) {
  header('Test 3: inventory deduction + auto-86')

  // The first order already deducted both. We capture *current* stock here as
  // the post-deduction baseline. The first order needed 0.2kg chicken + 0.1kg
  // lettuce; lettuce started at 0.05kg so it was clamped to 0 → auto-86.
  const before = await prisma.inventoryItem.findMany({
    where: { id: { in: [ctx.chickenId, ctx.lettuceId] } },
  })
  const chickenBefore = before.find((i) => i.id === ctx.chickenId)!
  const lettuceBefore = before.find((i) => i.id === ctx.lettuceId)!

  console.log(`  → After first order: chicken=${chickenBefore.currentStock}kg, lettuce=${lettuceBefore.currentStock}kg`)

  check('Chicken decreased from initial 5kg', chickenBefore.currentStock < 5)
  check('Lettuce drained to zero (auto-clamp prevented negative)', lettuceBefore.currentStock <= 0)

  // Auto-86 should have flipped the salad menu item to unavailable after the first order
  const saladItem = await prisma.menuItem.findUnique({ where: { id: ctx.saladId } })
  check('Salad auto-86\'d (isAvailable: false)', saladItem?.isAvailable === false)

  const burgerItem = await prisma.menuItem.findUnique({ where: { id: ctx.burgerId } })
  check('Burger NOT auto-86\'d (chicken still in stock)', burgerItem?.isAvailable === true)

  // Now place another order to verify chicken keeps deducting + lettuce stays clamped
  const stockBefore = chickenBefore.currentStock
  const result = await ingestOrder({
    source: 'pos',
    external_id: `smoke-deduct-${Date.now()}`,
    concept_id: ctx.conceptId,
    placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null,
    items: [
      { externalItemId: 'burger', menuItemId: ctx.burgerId, name: 'Smoked Chicken Burger', quantity: 1, unitPriceCents: 850_00, modifiers: [] },
    ],
    payment: { provider: 'cash', amountCents: 850_00, status: 'paid' },
    loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
  } as Parameters<typeof ingestOrder>[0])
  await deductInventoryForOrder(result.order.id)

  const after = await prisma.inventoryItem.findUnique({ where: { id: ctx.chickenId } })
  check('Second order deducts chicken further', (after?.currentStock ?? 999) < stockBefore)
}

async function testLifecycle(orderId: string) {
  header('Test 4: full order lifecycle')

  // Expo confirms & fires the order: received → preparing.
  await updateOrderStatus(orderId, 'preparing' as OrderStatus)

  const items = await prisma.orderItem.findMany({ where: { orderId } })
  const itemIds = items.map((i) => i.id)

  // Stations bump every dish. When the last dish is bumped, the kitchen path
  // hands the order up to expo's "ready" queue — it must NOT auto-complete.
  for (const id of itemIds) {
    await updateItemStatus(id, 'bumped' as never)
  }
  const afterBump = await prisma.orderItem.findMany({ where: { orderId } })
  check('All items bumped', afterBump.every((i) => i.status === 'bumped'))
  check('All items have completedAt timestamp', afterBump.every((i) => i.completedAt !== null))

  const ready = await prisma.order.findUnique({ where: { id: orderId } })
  check('Order handed to expo as "ready" (not auto-completed)', ready?.status === 'ready')

  // Expo hands off (serve / dispatch / pickup): ready → completed.
  await updateOrderStatus(orderId, 'completed' as OrderStatus)
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  check('Order completed by expo hand-off', order?.status === 'completed')
  check('Order has completedAt timestamp', order?.completedAt !== null)
}

async function testConcurrencyRaceSafety(ctx: Awaited<ReturnType<typeof setup>>) {
  header('Test 5: concurrency — atomic stock decrement under load')

  // Reset chicken stock to a known small value so concurrent orders fight over it
  await prisma.inventoryItem.update({
    where: { id: ctx.chickenId },
    data: { currentStock: 1.0 }, // 5 burgers worth (each uses 0.21 kg post-yield)
  })
  // Re-enable burger if previous tests 86'd it
  await prisma.menuItem.update({ where: { id: ctx.burgerId }, data: { isAvailable: true } })

  // Fire 10 concurrent burger orders. Only ~5 should fully deduct;
  // the rest should clamp at zero. None should drive stock negative.
  const orders = await Promise.all(
    Array.from({ length: 10 }).map((_, i) =>
      ingestOrder({
        source: 'pos',
        external_id: `smoke-race-${Date.now()}-${i}`,
        concept_id: ctx.conceptId,
        placed_at: new Date().toISOString(),
        customer_id: null, customer_name: null,
        items: [
          { externalItemId: 'b', menuItemId: ctx.burgerId, name: 'Smoked Chicken Burger', quantity: 1, unitPriceCents: 850_00, modifiers: [] },
        ],
        payment: { provider: 'cash', amountCents: 850_00, status: 'paid' },
        loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
      } as Parameters<typeof ingestOrder>[0])
    )
  )
  // Wait for all fire-and-forget deductions to settle
  await Promise.all(orders.map((o) => deductInventoryForOrder(o.order.id)))

  const final = await prisma.inventoryItem.findUnique({ where: { id: ctx.chickenId } })
  check('Stock never went negative under concurrent load', (final?.currentStock ?? -1) >= 0,
    `final stock = ${final?.currentStock}`)
  check('Burger auto-86\'d once stock was depleted',
    !(await prisma.menuItem.findUnique({ where: { id: ctx.burgerId } }))?.isAvailable)
}

async function testIdempotency(ctx: Awaited<ReturnType<typeof setup>>) {
  header('Test 5: webhook idempotency (duplicate ingestion)')

  const externalId = `smoke-idempotent-${Date.now()}`
  const dto = {
    source: 'foodpanda' as const,
    external_id: externalId,
    concept_id: ctx.conceptId,
    placed_at: new Date().toISOString(),
    customer_id: null, customer_name: 'Foodpanda Customer',
    items: [
      { externalItemId: 'b', menuItemId: ctx.burgerId, name: 'Smoked Chicken Burger', quantity: 1, unitPriceCents: 850_00, modifiers: [] },
    ],
    payment: { provider: 'platform' as const, amountCents: 850_00, status: 'paid' as const },
    loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
  } as Parameters<typeof ingestOrder>[0]

  const r1 = await ingestOrder(dto)
  const r2 = await ingestOrder(dto)

  check('First ingestion creates new order', r1.created === true)
  check('Second ingestion returns existing (idempotent)', r2.created === false)
  check('Same order ID on both calls', r1.order.id === r2.order.id)
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗')
  console.log('║                  servd order pipeline smoke test               ║')
  console.log('╚════════════════════════════════════════════════════════════════╝')

  try {
    header('Setup: creating Smoke Test Cafe with stations, menu, recipes')
    const ctx = await setup()
    console.log(`  ✓ Concept ${ctx.conceptId.slice(0, 8)}…  Burger=${ctx.burgerId.slice(0, 8)}…  Salad=${ctx.saladId.slice(0, 8)}…`)

    const orderId = await testOrderIngestion(ctx)
    await testCoursePacing(orderId)
    await testInventoryDeduction(ctx)
    await testLifecycle(orderId)
    await testConcurrencyRaceSafety(ctx)
    await testIdempotency(ctx)

    header('Cleanup')
    await cleanup()
    console.log('  ✓ Removed all smoke test data')
  } catch (err) {
    console.error('\n✗ FATAL — test threw:')
    console.error(err)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }

  console.log('\n━━━ Summary ━━━')
  console.log(`  ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    failures.forEach((f) => console.log(`  • ${f}`))
    process.exitCode = 1
  }
}

main()
