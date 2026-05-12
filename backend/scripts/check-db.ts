import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

async function main() {
  const concepts = await p.concept.findMany({ select: { id: true, name: true, slug: true } })
  console.log('Concepts:', concepts.length)
  for (const c of concepts) console.log(' ', c.slug.padEnd(12), c.name)

  const menu = await p.menuItem.groupBy({ by: ['conceptId'], _count: { _all: true } })
  console.log('\nMenu items per concept:')
  for (const m of menu) {
    const c = concepts.find(x => x.id === m.conceptId)
    console.log(' ', (c?.slug ?? m.conceptId).padEnd(12), m._count._all)
  }

  const staff = await p.kitchenStaff.count()
  const customers = await p.customer.count()
  const orders = await p.order.count()
  const reservations = await p.reservation.count()
  const inventory = await p.inventoryItem.count()
  const riders = await p.rider.count()
  const tables = await p.table.count()
  const stations = await p.station.count()
  const wage = await p.wageSettings.count()
  const payroll = await p.kitchenPayrollRun.count()
  console.log('\nCounts:', { staff, customers, orders, reservations, inventory, riders, tables, stations, wage, payroll })

  await p.$disconnect()
}
main()
