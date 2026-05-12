import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
const prisma = new PrismaClient()

async function main() {
  const email = 'a.garib.pakistani@gmail.com'
  // CEO PIN is set by request — staff PINs are auto-derived from their phone
  // (last 4 digits) on self-signup. The CEO's PIN is a special static value.
  const pin = '1973'
  const hashed = await bcrypt.hash(pin, 10)
  const user = await prisma.user.update({
    where: { email },
    data: { pin: hashed, accountStatus: 'active' },
  })
  console.log(`PIN set for ${user.name} (${user.email}) -> ${pin}`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
