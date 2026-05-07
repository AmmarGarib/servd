import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
  const r = await prisma.concept.updateMany({
    where: { slug: 'flipd', deletedAt: null },
    data: { deletedAt: new Date(), isActive: false },
  })
  console.log(`Soft-deleted ${r.count} Flipd concept(s)`)
}
main().catch(console.error).finally(() => prisma.$disconnect())
