import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    include: { concepts: { where: { deletedAt: null }, select: { id: true, name: true, slug: true, isActive: true } } },
  })
  for (const t of tenants) {
    console.log(`\nTenant: ${t.name} (${t.id})`)
    for (const c of t.concepts) console.log(`  - ${c.name} (slug=${c.slug}, active=${c.isActive})`)
  }
  // Also check where Flipd lives
  const flipd = await prisma.concept.findMany({
    where: { OR: [{ name: { contains: 'Flipd', mode: 'insensitive' } }, { slug: { contains: 'flipd', mode: 'insensitive' } }] },
    select: { id: true, name: true, slug: true, tenantId: true, deletedAt: true, isActive: true },
  })
  console.log('\n--- Flipd records (any tenant, including deleted) ---')
  for (const f of flipd) console.log(JSON.stringify(f))
}
main().catch(console.error).finally(() => prisma.$disconnect())
