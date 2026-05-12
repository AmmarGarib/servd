/**
 * Make sure the CEO has TenantMember rows for every tenant. Portfolio mode
 * works by looking up every tenant the user is a member of — without rows
 * the cross-tenant query falls back to "just the active tenant", which is
 * exactly the bug ("All companies" only showed Bukhari concepts).
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const ceo = await prisma.user.findUnique({ where: { email: 'a.garib.pakistani@gmail.com' } })
  if (!ceo) { console.error('CEO user not found'); process.exit(1) }

  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } })
  let created = 0, kept = 0
  for (const t of tenants) {
    const existing = await prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId: ceo.id, tenantId: t.id } },
    })
    if (existing) { kept++; continue }
    await prisma.tenantMember.create({
      data: { userId: ceo.id, tenantId: t.id, role: 'owner' },
    })
    created++
    console.log(`+ ${ceo.email} → owner of ${t.name} (${t.id})`)
  }
  console.log(`Done. ${created} new membership(s), ${kept} already in place.`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
