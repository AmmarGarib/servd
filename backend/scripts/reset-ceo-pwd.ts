import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
const prisma = new PrismaClient()

async function main() {
  const email = 'a.garib.pakistani@gmail.com'
  const password = 'servd123'
  const hash = await bcrypt.hash(password, 10)
  const user = await prisma.user.update({
    where: { email },
    data: { password: hash },
  })
  console.log(`Password reset for ${user.name} (${user.email}) → "${password}"`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
