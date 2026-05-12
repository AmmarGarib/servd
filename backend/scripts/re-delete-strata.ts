// Confirm Strata is gone — earlier restoration was based on a wrong guess.
// User confirmed the delete was intentional. Re-soft-delete.
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const r = await prisma.concept.updateMany({
    where: { slug: 'strata' },
    data:  { deletedAt: new Date(), isActive: false, storefrontVisible: false },
  })
  console.log(`Strata re-deleted (${r.count} row).`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
