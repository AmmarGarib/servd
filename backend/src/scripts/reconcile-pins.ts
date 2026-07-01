// One-time, self-healing PIN reconciliation.
//
// Operator policy (product owner, 2026-07): every staff PIN IS the last 4
// digits of that person's phone number — that's also what the CEO view
// surfaces as their PIN. New accounts get this automatically at signup and via
// admin-create. This script brings EXISTING accounts into line so what the CEO
// reads off the workforce page actually matches the stored login PIN.
//
// It runs on every boot (from entrypoint.sh, after `prisma migrate deploy`) but
// is idempotent and cheap: it only writes when a user's stored PIN doesn't
// already match their phone's last-4, so after the first convergence pass every
// subsequent boot is a no-op (read-only bcrypt compares over a small userbase).
//
// It also clears `pinMustReset` on any account it touches — the phone-derived
// PIN is exactly what the legacy `user_pin_must_reset` gate was blocking, and
// the operator has explicitly chosen phone-last-4 over CSPRNG PINs.
//
// Non-fatal: a failure here logs and exits 0 so a reconcile hiccup never blocks
// the API from booting.

import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../lib/prisma.js'

async function main() {
  const users = await prisma.user.findMany({
    where: { deletedAt: null, phone: { not: null } },
    select: { id: true, name: true, phone: true, pin: true, pinMustReset: true },
  })

  let fixed = 0
  let skipped = 0

  for (const u of users) {
    const digits = (u.phone ?? '').replace(/\D/g, '')
    if (digits.length < 4) { skipped++; continue }
    const last4 = digits.slice(-4)

    const alreadyMatches = u.pin ? await bcrypt.compare(last4, u.pin) : false
    if (alreadyMatches && !u.pinMustReset) { skipped++; continue }

    await prisma.user.update({
      where: { id: u.id },
      data: { pin: await bcrypt.hash(last4, 10), pinMustReset: false },
    })
    fixed++
  }

  console.log(`[reconcile-pins] converged ${fixed} account(s) to phone-last-4; ${skipped} already correct or no usable phone.`)
}

main()
  .catch((err) => {
    console.error('[reconcile-pins] non-fatal error (continuing boot):', err)
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {})
    process.exit(0)
  })
