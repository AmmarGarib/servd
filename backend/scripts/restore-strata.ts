/**
 * Strata was soft-deleted at 2026-05-12T08:37 — likely an accidental click on
 * the new Delete button. Restore it (un-soft-delete + reactivate).
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const updated = await prisma.concept.update({
    where: { slug: 'strata' },
    data:  { deletedAt: null, isActive: true },
    select: { id: true, name: true, tenantId: true },
  })
  console.log(`Restored ${updated.name} (${updated.tenantId})`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
