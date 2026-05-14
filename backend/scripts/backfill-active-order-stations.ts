// Quick one-shot to bring already-placed orders in line with the menu item
// station assignments we just backfilled. Without this, orders created
// before the menu-item.stationId backfill still carry stationId=null on
// their items, so /expo fire would still mark them as unrouted.
//
// Only touches items on active orders (received | preparing) so completed
// history stays untouched.

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const items = await prisma.orderItem.findMany({
    where: {
      stationId: null,
      status: { in: ['pending', 'preparing'] },
      order: { status: { in: ['received', 'preparing'] } },
    },
    include: { menuItem: { select: { stationId: true, name: true } } },
  })

  let updated = 0
  for (const it of items) {
    if (it.menuItem?.stationId) {
      await prisma.orderItem.update({ where: { id: it.id }, data: { stationId: it.menuItem.stationId } })
      updated++
    }
  }
  console.log(`Backfilled stationId on ${updated} / ${items.length} active order items.`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
