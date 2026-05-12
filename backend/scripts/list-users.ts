import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const users = await prisma.user.findMany({ select: { email: true, name: true, role: true, isActive: true } })
  console.log(`${users.length} user(s):`)
  for (const u of users) console.log(`  ${u.email.padEnd(35)} ${u.role.padEnd(10)} ${u.isActive ? '✓' : '✗'}  ${u.name}`)
  await prisma.$disconnect()
}
main()
