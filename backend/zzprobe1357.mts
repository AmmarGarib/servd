import { prisma } from './src/lib/prisma.js'
import { closeChecklist } from './src/modules/accounting/closeChecks.js'
import { trialBalance } from './src/modules/accounting/reports.js'
const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } })
await prisma.account.updateMany({ where: { code: '1357' }, data: { name: 'Owner-renamed test account' } })
for (const t of tenants) {
  const acct = await prisma.account.findFirst({ where: { tenantId: t.id, code: '1357' }, select: { name: true, isActive: true } })
  const cl = await closeChecklist(prisma as never, t.id, new Date('2026-10-31T18:59:59Z'))
  const all = [...cl.blocks, ...cl.warnings]
  const v = all.filter((p: any) => /voucher|1357/i.test(p.key + ' ' + (p.message ?? p.title ?? '')))
  const tb = await trialBalance([t.id], new Date('2026-10-31T18:59:59Z'))
  const row = (tb as any).rows?.find((r: any) => r.code === '1357')
  console.log(JSON.stringify({ company: t.name, acct, blocks: cl.blocks.map((p: any) => p.key), voucherChecks: v.map((p: any) => [p.key, p.severity]), tb1357: row ?? 'not listed (zero)', tbBalanced: (tb as any).totals ?? null }))
}
await prisma.$disconnect()
