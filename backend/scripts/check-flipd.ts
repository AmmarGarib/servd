import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const all = await prisma.concept.findMany({
    select: { id: true, name: true, slug: true, tenantId: true, deletedAt: true, isActive: true },
    orderBy: { name: 'asc' },
  })
  for (const c of all) {
    console.log(`  ${c.slug.padEnd(12)} ${c.name.padEnd(12)} tenant=${c.tenantId?.slice(0,8) ?? '(none)'}  deletedAt=${c.deletedAt ? c.deletedAt.toISOString() : 'null'}  active=${c.isActive}`)
  }
  await prisma.$disconnect()
}
main()
