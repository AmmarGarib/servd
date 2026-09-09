// Set (or reset) a staff member's password from the server console.
//
// This is the break-glass path for the accounts that can no longer sign in
// with a PIN — owner, management and finance sign in with email + password,
// and if nobody remembers that password there has to be a way back in that
// doesn't involve editing the database by hand.
//
// It runs ON the production box, so possession of a shell IS the authorisation.
// There is deliberately no HTTP endpoint for this: a "reset anyone's password"
// route is exactly the thing an attacker looks for.
//
// Usage (from the directory holding docker-compose.yml):
//
//   docker compose exec api node dist/src/scripts/set-staff-password.js \
//     ceo@example.com 'a long passphrase you will remember'
//
// Quote the password so the shell doesn't eat spaces or special characters.
// It never appears in the app logs; it is read from argv and hashed in memory.

import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../lib/prisma.js'

const MIN_LENGTH = 12

async function main() {
  const [email, password] = process.argv.slice(2)

  if (!email || !password) {
    console.error('Usage: node dist/src/scripts/set-staff-password.js <email> <password>')
    process.exit(1)
  }
  if (password.length < MIN_LENGTH) {
    console.error(`Password must be at least ${MIN_LENGTH} characters. A passphrase of three or four words is easier to remember and much harder to guess than a short scramble.`)
    process.exit(1)
  }

  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), deletedAt: null },
    select: { id: true, name: true, email: true, role: true, accountStatus: true, isActive: true },
  })
  if (!user) {
    console.error(`No account found for ${email}. Existing staff emails:`)
    const all = await prisma.user.findMany({
      where: { deletedAt: null, email: { not: null } },
      select: { email: true, role: true },
      orderBy: { createdAt: 'asc' },
    })
    for (const u of all) console.error(`  ${u.email}  (${u.role})`)
    process.exit(1)
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { password: await bcrypt.hash(password, 12) },
  })

  console.log(`✓ Password set for ${user.name} <${user.email}> (${user.role})`)
  if (!user.isActive || user.accountStatus !== 'active') {
    console.log(`⚠ Account status is "${user.accountStatus}"${user.isActive ? '' : ' and inactive'} — sign-in stays blocked until it is active.`)
  }
  console.log('  Sign in at the admin site → "Sign in with password".')
}

main()
  .catch((err) => {
    console.error('Failed:', (err as Error).message)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {})
  })
