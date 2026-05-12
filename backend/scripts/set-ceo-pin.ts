import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
const prisma = new PrismaClient()

async function main() {
  const email = 'a.garib.pakistani@gmail.com'
  // 6-digit PIN so it lives in the PAD's 6-dot field and the auto-submit at
  // length>=4 doesn't fire on a partial CEO PIN. Easy to remember; change it
  // any time via /configuration/users.
  const pin = '141414'
  const hashed = await bcrypt.hash(pin, 10)
  const user = await prisma.user.update({ where: { email }, data: { pin: hashed } })
  console.log(`PIN set for ${user.name} (${user.email}) -> ${pin}`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
