// Backfill: grant existing non-admin/non-manager staff access to all active
// concepts. Without this, the IDOR scoping introduced in the user_concept_scoping
// migration locks every existing kitchen / cashier / expediter user out of every
// concept-scoped endpoint, because their conceptIds default to [].
//
// Run once after applying the migration:
//   pnpm --filter @servd/api exec tsx scripts/backfill-concept-access.ts
//
// Safe to re-run — only updates users with empty conceptIds. Admin and manager
// roles are not touched (they bypass the scoping check at the middleware layer).

import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const concepts = await prisma.concept.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, slug: true },
  })
  if (concepts.length === 0) {
    console.error('No active concepts found — aborting (would grant access to nothing).')
    process.exit(1)
  }
  const allConceptIds = concepts.map((c) => c.id)

  const usersToBackfill = await prisma.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      role: { in: ['cashier', 'kitchen', 'expediter'] },
      conceptIds: { isEmpty: true },
    },
    select: { id: true, name: true, email: true, role: true },
  })

  if (usersToBackfill.length === 0) {
    console.info('✓ No users to backfill — every active staff already has at least one concept.')
    return
  }

  console.info(`Backfilling concept access for ${usersToBackfill.length} user(s) → ${concepts.map((c) => c.slug).join(', ')}`)

  for (const u of usersToBackfill) {
    await prisma.user.update({
      where: { id: u.id },
      data: { conceptIds: allConceptIds },
    })
    console.info(`  ✓ ${u.role.padEnd(9)} ${u.name} <${u.email}>`)
  }

  console.info('')
  console.info('Done. Tighten access per-user via PATCH /auth/users/:id once you know who works where.')

  await prisma.$disconnect()
}

void main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
