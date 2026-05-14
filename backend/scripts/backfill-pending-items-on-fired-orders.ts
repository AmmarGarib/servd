// Repair stuck legacy items: orders that were already fired BEFORE the
// legacy-flow fix landed have order.status = 'preparing' but item.status
// still 'pending' because the old fire path silently skipped them. Bump
// these forward to 'preparing' so the KDS bump action stops 409-ing.
//
// Idempotent — only touches items currently `pending` whose parent order
// is past the fire gate.

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const result = await prisma.orderItem.updateMany({
    where: {
      status: 'pending',
      order: { status: { in: ['preparing', 'ready'] } },
    },
    data:  { status: 'preparing', firedAt: new Date() },
  })
  console.log(`Promoted ${result.count} stuck 'pending' items to 'preparing'.`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
