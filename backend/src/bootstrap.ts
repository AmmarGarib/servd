// Boot-time, idempotent data seeds / backfills.
//
// Run once per process by the long-running Docker entry (src/index.ts) before
// the workers start. Every block is safe to repeat: it only creates what is
// missing and logs-and-continues on failure, so a seed problem never stops the
// API from booting.
//
// NOT run per request on the serverless function — cold starts would pay for
// it and concurrent instances would race each other. On Vercel, run it from a
// deploy hook or the internal cron route instead.

import { serviceClient as prisma } from './lib/prisma.js'
import { ensureChartOfAccounts, retireAggregatorAccounts } from './lib/chartOfAccounts.js'

export interface BootstrapLogger {
  info(msg: string): void
  warn(msg: string): void
}

export async function runBootstrap(log: BootstrapLogger): Promise<void> {
  // (The role × permission matrix seed is gone with the matrix — owner
  // decision 34. The role_permissions table is kept as history.)

  // Tenants bootstrap: if no tenant exists, create a "main" tenant and attach
  // every existing concept + user to it. Idempotent — safe to run on every boot.
  try {
    const tenantCount = await prisma.tenant.count({ where: { deletedAt: null } })
    if (tenantCount === 0) {
      const main = await prisma.tenant.create({
        data: { slug: 'main', name: 'Main Tenant', isActive: true },
      })
      await prisma.concept.updateMany({ where: { tenantId: null }, data: { tenantId: main.id } })
      await prisma.user.updateMany({ where: { tenantId: null }, data: { tenantId: main.id } })
      log.info(`[tenants] seeded default tenant + linked existing concepts/users`)
    } else {
      // Defensive: any concept/user without a tenant gets attached to the
      // first active tenant (in case migrations created loose rows).
      const orphanConcepts = await prisma.concept.count({ where: { tenantId: null } })
      const orphanUsers    = await prisma.user.count({ where: { tenantId: null } })
      if (orphanConcepts > 0 || orphanUsers > 0) {
        const first = await prisma.tenant.findFirst({ where: { isActive: true, deletedAt: null }, orderBy: { createdAt: 'asc' } })
        if (first) {
          await prisma.concept.updateMany({ where: { tenantId: null }, data: { tenantId: first.id } })
          await prisma.user.updateMany({ where: { tenantId: null }, data: { tenantId: first.id } })
          log.info(`[tenants] linked ${orphanConcepts} orphan concepts + ${orphanUsers} orphan users to tenant "${first.slug}"`)
        }
      }
    }
  } catch (err) {
    log.warn(`[tenants] seed/backfill skipped: ${(err as Error).message}`)
  }

  // Locations bootstrap: if no locations exist yet, create one default
  // location PER COMPANY and link that company's brands to it. Locations are
  // company master data — one shared "Main Location" linking every brand
  // across every company is exactly the cross-company overlap the Locations
  // page used to show. Existing orders stay locationId=null; POS/storefront
  // paths populate locationId on new orders going forward.
  try {
    const count = await prisma.location.count({ where: { deletedAt: null } })
    if (count === 0) {
      const tenants = await prisma.tenant.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, slug: true },
      })
      for (const [idx, tenant] of tenants.entries()) {
        const concepts = await prisma.concept.findMany({
          where: { deletedAt: null, tenantId: tenant.id }, select: { id: true },
        })
        const loc = await prisma.location.create({
          data: {
            slug: idx === 0 ? 'main' : `main-${tenant.slug}`,
            name: 'Main Location', isActive: true, tenantId: tenant.id,
          },
        })
        if (concepts.length > 0) {
          await prisma.conceptLocation.createMany({
            data: concepts.map((c) => ({ conceptId: c.id, locationId: loc.id, isPrimary: true })),
            skipDuplicates: true,
          })
        }
        log.info(`[locations] seeded default location for "${tenant.slug}" with ${concepts.length} concept links`)
      }
    }
  } catch (err) {
    log.warn(`[locations] seed skipped: ${(err as Error).message}`)
  }

  // Ledger bootstrap: every company needs its own chart of accounts before a
  // single order can post (Account.tenantId; codes are unique per company).
  // Adds only what a company is missing, so operator edits are never touched.
  try {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, slug: true },
    })
    for (const t of tenants) {
      const added = await ensureChartOfAccounts(t.id)
      if (added > 0) log.info(`[ledger] seeded ${added} account(s) for "${t.slug}"`)
      const retired = await retireAggregatorAccounts(t.id)
      if (retired.length > 0) log.info(`[ledger] deactivated zero-balance aggregator account(s) ${retired.join(', ')} for "${t.slug}"`)
    }
  } catch (err) {
    log.warn(`[ledger] chart-of-accounts bootstrap skipped: ${(err as Error).message}`)
  }
  // Supplier opening balances live in the ledger (Dr 3020 / Cr 2010). Post any
  // that predate this, so AP aging and the ledger agree from the first boot.
  try {
    const { syncAllSupplierOpeningBalances } = await import('./modules/procurement/openingBalance.js')
    const r = await syncAllSupplierOpeningBalances()
    if (r.synced || r.failed.length) log.info(`[ap] supplier opening balances: ${r.synced} posted, ${r.failed.length} failed`)
  } catch (err) {
    log.warn(`[ap] supplier opening-balance sync skipped: ${(err as Error).message}`)
  }
}
