// One-off: hard-reset the admin (CEO) staff login — display name + PIN.
//
// The PIN portal matches the typed identifier against a user's name
// (case-insensitive) OR email, then bcrypt-compares the PIN. This sets the
// admin account's name + PIN so you can sign in with them.
//
// No secrets are committed — name and PIN are read at runtime:
//
//   cd backend
//   ADMIN_NEW_NAME='AG' ADMIN_NEW_PIN='197312' npx tsx scripts/reset-admin-login.ts
//
// Optional: ADMIN_EMAIL=you@example.com to target a specific admin when more
// than one admin account exists.
//
// Requires DATABASE_URL in the environment (it talks straight to Postgres, so
// it works even while the API container is down).
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const name  = (process.env['ADMIN_NEW_NAME'] ?? process.argv[2] ?? '').trim()
  const pin   = (process.env['ADMIN_NEW_PIN']  ?? process.argv[3] ?? '').trim()
  const email = (process.env['ADMIN_EMAIL'] ?? '').trim().toLowerCase()

  if (!name) throw new Error('ADMIN_NEW_NAME (or first arg) is required')
  if (!/^\d{4,8}$/.test(pin)) throw new Error('ADMIN_NEW_PIN must be 4–8 digits')

  // Resolve the target account: an explicit email wins; otherwise the single
  // admin. Refuse to guess when several admins exist.
  let target: { id: string; email: string | null; name: string; role: string }
  if (email) {
    const u = await prisma.user.findFirst({ where: { email } })
    if (!u) throw new Error(`No user with email ${email}`)
    target = u
  } else {
    const admins = await prisma.user.findMany({ where: { role: 'admin', deletedAt: null } })
    if (admins.length === 0) throw new Error('No admin user found — pass ADMIN_EMAIL=… to target one.')
    if (admins.length > 1) {
      throw new Error(
        'Multiple admin accounts found — re-run with ADMIN_EMAIL set:\n' +
        admins.map((a) => `  • ${a.email ?? '(no email)'} — "${a.name}"`).join('\n'),
      )
    }
    target = admins[0]!
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      name,
      pin: await bcrypt.hash(pin, 10),
      isActive: true,
      accountStatus: 'active',
      pinMustReset: false,
      deletedAt: null,
    },
  })

  console.info(
    `✓ Login reset for ${updated.email ?? updated.id} → name "${updated.name}", role ${updated.role}. ` +
    `Sign in with that name (or email) and your new PIN.`,
  )
}

main()
  .catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1) })
  .finally(() => void prisma.$disconnect())
