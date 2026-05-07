// Backfills TenantMember rows for every (user, tenantId) pair already present
// on User.tenantId. Idempotent — safe to re-run. Run after the schema migration
// that introduced the M:N tenant_members table.

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const users = await prisma.user.findMany({
    where: { tenantId: { not: null } },
    select: { id: true, tenantId: true, role: true },
  })
  console.log(`Backfilling ${users.length} (user, tenant) memberships…`)

  let created = 0
  for (const u of users) {
    if (!u.tenantId) continue
    const result = await prisma.tenantMember.upsert({
      where: { userId_tenantId: { userId: u.id, tenantId: u.tenantId } },
      create: {
        userId:   u.id,
        tenantId: u.tenantId,
        role:     u.role === 'admin' ? 'owner' : (u.role ?? 'member'),
      },
      update: {},
    })
    if (result) created++
  }
  console.log(`Done. ${created} memberships ensured.`)
}

main().catch((err) => { console.error(err); process.exit(1) }).finally(() => prisma.$disconnect())
