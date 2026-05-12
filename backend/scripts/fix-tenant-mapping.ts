/**
 * Rename + reassign tenants/concepts to match the real business structure.
 *
 *   GS Foods (Bukhari)   — sole prop, Stax + Simmer + Strata
 *   GS x Viva (Clifton)  — JV with pad el club, Flipd + gs-x-viva concept
 *
 * Idempotent — running twice does nothing different.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const BUKHARI_CONCEPTS = ['stax', 'simmer', 'strata']
const CLIFTON_CONCEPTS = ['flipd', 'gs-x-viva']

async function main() {
  // 1. Rename tenants (keep IDs stable — every downstream FK depends on them).
  const bukhari = await prisma.tenant.findFirst({ where: { slug: 'main' } })
                ?? await prisma.tenant.findFirst({ where: { name: 'GS Foods' } })
  const clifton = await prisma.tenant.findFirst({ where: { slug: 'gs-foods-x-viva' } })
                ?? await prisma.tenant.findFirst({ where: { name: 'GS Foods x Viva' } })

  if (!bukhari || !clifton) {
    console.error('Could not find both tenants — aborting.')
    process.exit(1)
  }

  await prisma.tenant.update({
    where: { id: bukhari.id },
    data: { name: 'GS Foods (Bukhari)', slug: 'gs-foods-bukhari' },
  })
  await prisma.tenant.update({
    where: { id: clifton.id },
    data: { name: 'GS x Viva (Clifton)', slug: 'gs-x-viva-clifton' },
  })
  console.log(`Tenant 1: ${bukhari.id} -> GS Foods (Bukhari)`)
  console.log(`Tenant 2: ${clifton.id} -> GS x Viva (Clifton)`)

  // 2. Reassign concepts.
  for (const slug of BUKHARI_CONCEPTS) {
    const c = await prisma.concept.findFirst({ where: { slug } })
    if (!c) { console.warn(`  concept "${slug}" not found, skipped`); continue }
    if (c.tenantId !== bukhari.id) {
      await prisma.concept.update({ where: { id: c.id }, data: { tenantId: bukhari.id } })
      console.log(`  ${slug} -> Bukhari`)
    } else {
      console.log(`  ${slug} already on Bukhari`)
    }
  }
  for (const slug of CLIFTON_CONCEPTS) {
    const c = await prisma.concept.findFirst({ where: { slug } })
    if (!c) { console.warn(`  concept "${slug}" not found, skipped`); continue }
    if (c.tenantId !== clifton.id) {
      await prisma.concept.update({ where: { id: c.id }, data: { tenantId: clifton.id } })
      console.log(`  ${slug} -> Clifton`)
    } else {
      console.log(`  ${slug} already on Clifton`)
    }
  }

  // 3. Sanity check.
  const concepts = await prisma.concept.findMany({
    select: { slug: true, tenant: { select: { slug: true } } },
    orderBy: { slug: 'asc' },
  })
  console.log('\nFinal mapping:')
  for (const c of concepts) console.log(`  ${c.slug.padEnd(15)} -> ${c.tenant?.slug ?? '(orphan)'}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
