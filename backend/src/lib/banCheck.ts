// Naughty-list gate.
//
// Called at every "new customer touchpoint" to reject signups / orders /
// reservations from email + phone fingerprints we've already banned. IP is
// recorded as a forensic signal but NOT used to hard-reject — too many
// false-positives on shared cafe / family / corporate networks.
//
// The standard pattern at the call site:
//
//   const block = await assertNotBanned({ email, phone, ip, intent: 'signup' })
//   // → throws AppError(403, 'BANNED') if any active ban matches
//
// On match, we ALSO add the offender's current IP to the existing ban's
// IP list — silently extending the forensic graph without notifying them.

import { prisma } from './prisma.js'
import { AppError } from './errors.js'

interface CheckArgs {
  email?: string | null
  phone?: string | null
  ip?: string | null
  // Optional fingerprint hash from JS-side; if available, also matched.
  deviceFingerprint?: string | null
  // What the user is trying to do — surfaces in the rejection message
  // so they get a clear "you're banned" without a useless 500.
  intent?: 'signup' | 'reservation' | 'order'
}

export async function assertNotBanned(args: CheckArgs): Promise<void> {
  // Build OR list of active-ban matchers. We hard-match email + phone +
  // device fingerprint exact. IP arrays are checked too (after a re-ban
  // operators may explicitly want IP enforcement; default policy: soft).
  const orFilters: Array<Record<string, unknown>> = []
  if (args.email)             orFilters.push({ email: args.email.toLowerCase() })
  if (args.phone)             orFilters.push({ phone: args.phone })
  if (args.deviceFingerprint) orFilters.push({ deviceFingerprints: { has: args.deviceFingerprint } })
  if (orFilters.length === 0) return

  const now = new Date()
  const ban = await prisma.customerBan.findFirst({
    where: {
      AND: [
        { OR: orFilters },
        { liftedAt: null },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    select: { id: true, ipAddresses: true },
  })
  if (!ban) return

  // Forensic enrichment — add the new IP to the ban's IP list (if any).
  if (args.ip && !ban.ipAddresses.includes(args.ip)) {
    await prisma.customerBan.update({
      where: { id: ban.id },
      data:  { ipAddresses: { push: args.ip } },
    }).catch(() => { /* swallow */ })
  }

  const verb = args.intent === 'reservation' ? 'book' : args.intent === 'order' ? 'order' : 'sign up'
  throw new AppError(
    'BANNED',
    `This account can't ${verb} on servd. If you think this is a mistake, contact the venue directly.`,
    403,
  )
}
