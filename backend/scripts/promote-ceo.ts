/**
 * Renames + promotes the demo admin account into the real CEO. Idempotent.
 *
 *   npx tsx scripts/promote-ceo.ts
 *
 * The new CEO account has the same password as before (servd123) so the
 * existing session keeps working until you log out / log back in.
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const CEO_EMAIL = 'a.garib.pakistani@gmail.com'
const CEO_NAME  = 'AG'

async function main() {
  // If the CEO email already exists, just normalise it.
  let user = await prisma.user.findUnique({ where: { email: CEO_EMAIL } })
  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: { name: CEO_NAME, role: 'admin', isActive: true },
    })
    console.log(`✓ ${CEO_EMAIL} updated → 👑 CEO (${CEO_NAME})`)
    await prisma.$disconnect()
    return
  }

  // Otherwise, rename the demo admin@servd.pk account so the existing
  // session/password still works.
  const demoAdmin = await prisma.user.findUnique({ where: { email: 'admin@servd.pk' } })
  if (!demoAdmin) {
    console.error('No demo admin@servd.pk found and no CEO account exists. Run the seed first.')
    process.exit(1)
  }
  await prisma.user.update({
    where: { id: demoAdmin.id },
    data: { email: CEO_EMAIL, name: CEO_NAME, role: 'admin' },
  })
  console.log(`✓ Renamed demo admin → CEO account`)
  console.log(`  Email: ${CEO_EMAIL}`)
  console.log(`  Name:  ${CEO_NAME}`)
  console.log(`  Password: unchanged (servd123)`)
  console.log(`  Log out & back in to refresh your session.`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
