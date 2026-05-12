/**
 * Flipd got soft-deleted at some point (deletedAt 2026-05-06). It's the JV
 * brand at Clifton — must exist for the GS x Viva tenant's chain rollup to
 * make sense. Un-delete + reactivate.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const updated = await prisma.concept.update({
    where: { slug: 'flipd' },
    data: { deletedAt: null, isActive: true },
    select: { id: true, name: true, slug: true, tenantId: true },
  })
  console.log(`Restored ${updated.name} (${updated.slug}) on tenant ${updated.tenantId}`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
