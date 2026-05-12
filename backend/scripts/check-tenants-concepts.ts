/**
 * Read-only audit: shows current tenant ↔ concept mapping so we can fix the
 * "which tenant?" nonsense the user is hitting in the orders flow.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, slug: true } })
  console.log(`Tenants: ${tenants.length}`)
  for (const t of tenants) console.log(`  ${t.slug.padEnd(20)} ${t.name.padEnd(30)} ${t.id}`)

  const concepts = await prisma.concept.findMany({
    select: { id: true, name: true, slug: true, tenantId: true },
  })
  console.log(`\nConcepts: ${concepts.length}`)
  for (const c of concepts) {
    const t = tenants.find((x) => x.id === c.tenantId)
    console.log(`  ${c.slug.padEnd(15)} → tenant=${t?.slug ?? '(none)'}`)
  }

  const locations = await prisma.location.findMany({ select: { id: true, name: true, slug: true, tenantId: true } })
  console.log(`\nLocations: ${locations.length}`)
  for (const l of locations) {
    const t = tenants.find((x) => x.id === l.tenantId)
    console.log(`  ${l.slug.padEnd(20)} ${l.name.padEnd(30)} tenant=${t?.slug ?? '(none)'}`)
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
