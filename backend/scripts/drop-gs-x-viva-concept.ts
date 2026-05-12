/**
 * `gs-x-viva` was created as a concept (brand) but it's actually the *tenant*
 * name for the Clifton operation (the GS x Viva JV). Real Clifton brand is
 * Flipd. Soft-delete this rogue concept so it stops showing up in the chain
 * leaderboard and pickers.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const updated = await prisma.concept.updateMany({
    where: { slug: 'gs-x-viva' },
    data:  { deletedAt: new Date(), isActive: false, storefrontVisible: false },
  })
  console.log(`Soft-deleted ${updated.count} concept(s) (slug=gs-x-viva).`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
