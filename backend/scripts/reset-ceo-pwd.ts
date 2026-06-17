import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
const prisma = new PrismaClient()

// Usage: NEW_PASSWORD='<strong password>' npx tsx scripts/reset-ceo-pwd.ts
//
// The password comes from the environment — NEVER hardcode credentials in a
// tracked file. (A previous version of this script shipped a hardcoded
// password to the repo; if it was ever run, that password must be rotated.)
async function main() {
  const email = process.env['CEO_EMAIL'] ?? 'a.garib.pakistani@gmail.com'
  const password = process.env['NEW_PASSWORD']
  if (!password || password.length < 12) {
    console.error('Set NEW_PASSWORD (min 12 chars):  NEW_PASSWORD=... npx tsx scripts/reset-ceo-pwd.ts')
    process.exit(1)
  }
  const hash = await bcrypt.hash(password, 12)
  const user = await prisma.user.update({
    where: { email },
    data: { password: hash },
  })
  console.log(`Password reset for ${user.name} (${user.email})`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
