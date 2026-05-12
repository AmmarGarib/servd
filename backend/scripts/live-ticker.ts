/**
 * LIVE TICKER
 *
 * Keeps the GS Foods system feeling alive. Every ~20-60 seconds it either:
 *   • drops a new order (60% chance)
 *   • bumps an item on an existing preparing order (25%)
 *   • marks an order complete + records payment (15%)
 *
 * Designed to be left running in a terminal while the operator browses
 * the admin panel. Stop with Ctrl-C. Idempotent on restart (no cleanup
 * needed — every action is a forward step).
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]! }
function pickN<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length))
}
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

let totalDropped = 0
let totalBumped = 0
let totalCompleted = 0

async function placeOrder() {
  const concepts = await prisma.concept.findMany({ where: { isActive: true } })
  const conc = pick(concepts)
  const menu = await prisma.menuItem.findMany({ where: { conceptId: conc.id, isAvailable: true } })
  if (!menu.length) return
  const items = pickN(menu, rand(1, 4))

  const customers = await prisma.customer.findMany({ take: 20 })
  const tables = await prisma.table.findMany({ where: { conceptId: conc.id } })
  const locations = await prisma.location.findMany({ where: { isActive: true } })
  const openShifts = await prisma.shift.findMany({ where: { status: 'open' } })
  const users = await prisma.user.findMany({ where: { isActive: true } })
  const manager = users.find((u) => u.role === 'manager') ?? users[0]!

  const subtotal = items.reduce((s, it) => s + it.priceCents * rand(1, 3), 0)
  const tax = Math.round(subtotal * 0.17)
  const total = subtotal + tax

  const r = Math.random()
  const source = r < 0.5 ? 'pos' : r < 0.8 ? 'servd' : r < 0.92 ? 'foodpanda' : 'careem'
  const isDineIn = source === 'pos' && (conc.slug === 'simmer' || conc.slug === 'gs-x-viva') && Math.random() < 0.6
  const tableId = isDineIn ? pick(tables)?.id : undefined
  const cust = Math.random() < 0.4 && customers.length ? pick(customers) : null
  const shift = source === 'pos' && openShifts.length ? pick(openShifts) : null

  const order = await prisma.order.create({
    data: {
      source: source as any,
      status: 'received',
      conceptId: conc.id,
      locationId: locations[0]!.id,
      customerId: cust?.id,
      customerName: cust?.name ?? (source === 'foodpanda' ? `Foodpanda #${rand(1000, 9999)}` : source === 'careem' ? `Careem #${rand(1000, 9999)}` : 'Walk-in'),
      tableId,
      shiftId: shift?.id,
      posStaffId: shift ? manager.id : null,
      totalCents: total, taxCents: tax,
      placedAt: new Date(),
    },
  })

  await prisma.orderItem.createMany({
    data: items.map((it) => ({
      orderId: order.id, menuItemId: it.id,
      name: it.name, quantity: rand(1, 3), unitPriceCents: it.priceCents,
      status: 'pending' as any, course: 1,
    })),
  })
  totalDropped++
  console.log(`[+] new ${source.padEnd(9)} order @ ${conc.slug.padEnd(10)} — ${items.length} items, PKR ${(total / 100).toFixed(0)}`)
}

async function bumpAnItem() {
  // Find an order that's currently preparing and bump one of its items
  const order = await prisma.order.findFirst({
    where: { status: { in: ['received', 'confirmed', 'preparing'] } },
    include: { items: true },
    orderBy: { placedAt: 'asc' },     // bump the oldest first
  })
  if (!order) return
  const pending = order.items.find((i) => !['bumped', 'voided'].includes(i.status as any))
  if (!pending) return
  await prisma.orderItem.update({ where: { id: pending.id }, data: { status: 'bumped' as any } })
  // If all items are bumped → mark order ready/preparing
  const refreshed = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } })
  const allDone = refreshed?.items.every((i) => ['bumped', 'voided'].includes(i.status as any))
  if (allDone && order.status !== 'completed') {
    await prisma.order.update({ where: { id: order.id }, data: { status: 'ready' } })
  } else if (order.status === 'received') {
    await prisma.order.update({ where: { id: order.id }, data: { status: 'preparing' } })
  }
  totalBumped++
  console.log(`[✓] bumped ${pending.name} on order ${order.id.slice(-5).toUpperCase()}`)
}

async function completeOrder() {
  // Find an order in 'ready' state and close it out
  const order = await prisma.order.findFirst({
    where: { status: 'ready' },
    orderBy: { placedAt: 'asc' },
  })
  if (!order) return
  await prisma.order.update({ where: { id: order.id }, data: { status: 'completed' } })
  // Add payment if there isn't one
  const existing = await prisma.payment.findFirst({ where: { orderId: order.id } })
  if (!existing) {
    await prisma.payment.create({
      data: {
        orderId: order.id, shiftId: order.shiftId ?? undefined,
        method: (Math.random() < 0.5 ? 'cash' : 'card') as any,
        amountCents: order.totalCents, status: 'paid',
        processedAt: new Date(),
      },
    })
  }
  totalCompleted++
  console.log(`[$] completed order ${order.id.slice(-5).toUpperCase()} — PKR ${(order.totalCents / 100).toFixed(0)}`)
}

async function tick() {
  const r = Math.random()
  try {
    if (r < 0.6) await placeOrder()
    else if (r < 0.85) await bumpAnItem()
    else await completeOrder()
  } catch (e) {
    console.error('Tick failed:', (e as Error).message)
  }
}

async function main() {
  console.log('━━━ Live ticker running (Ctrl-C to stop) ━━━\n')
  console.log('Drops orders, bumps items, completes tickets every 20-60s\n')

  // Initial burst — get something happening immediately
  for (let i = 0; i < 3; i++) await placeOrder()

  while (true) {
    await tick()
    const delay = rand(20_000, 60_000)
    await sleep(delay)
    if (totalDropped + totalBumped + totalCompleted > 0 && Math.random() < 0.1) {
      console.log(`\n--- Stats: ${totalDropped} new orders, ${totalBumped} bumped, ${totalCompleted} completed ---\n`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
