import { PrismaClient } from '@prisma/client'
import { getRlsContext } from './rlsContext.js'

// Two clients backed by the same Postgres connection pool today; the split
// is here so we can wire them to different DB roles once policies land.
//
//   • `serviceClient` — raw Prisma. No RLS context, no session-var injection.
//                       For background workers, webhook handlers, startup
//                       code. Will eventually connect as a BYPASSRLS role.
//   • `prisma`        — extended Prisma. Every operation runs inside a
//                       tiny transaction that first sets `app.tenant_id`
//                       and `app.customer_id` Postgres session vars from
//                       the current request's RlsContext. Policies on
//                       tenant-scoped tables read those vars to decide
//                       which rows the caller may see / change.
//
// The extension is gated on `RLS_ENFORCE=1`. Until that flag flips in prod,
// the wrapper is a pure pass-through — no extra round-trips, no behaviour
// change — so this scaffolding can ship safely ahead of any policy. When
// we're ready to enforce, the flag goes on per-environment and the SET
// LOCAL statements start running.

const ENFORCE_RLS = process.env['RLS_ENFORCE'] === '1'

const globalForPrisma = globalThis as unknown as {
  basePrisma?: PrismaClient
}

const basePrisma = globalForPrisma.basePrisma ??
  new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.basePrisma = basePrisma
}

export const serviceClient = basePrisma

// Cast back to the bare PrismaClient type. The runtime is the extended
// client (the SET LOCAL wrapper fires when RLS_ENFORCE=1), but the public
// type stays compatible with every call site that passes prisma into
// helpers typed as PrismaClient or uses transaction-client features the
// extended type doesn't surface.
export const prisma = basePrisma.$extends({
  name: 'rls-session-vars',
  query: {
    async $allOperations({ args, query }) {
      if (!ENFORCE_RLS) return query(args)
      const ctx = getRlsContext()
      if (!ctx || (!ctx.tenantId && !ctx.customerId)) {
        return query(args)
      }
      // `set_config(name, value, is_local=true)` binds the var for the
      // current transaction only — no leakage between pooled connections.
      // Doing both vars in one SELECT keeps it to a single extra round-trip.
      const [, result] = await basePrisma.$transaction([
        basePrisma.$executeRaw`SELECT
          set_config('app.tenant_id',   ${ctx.tenantId   ?? ''}, true),
          set_config('app.customer_id', ${ctx.customerId ?? ''}, true)`,
        query(args),
      ])
      return result
    },
  },
}) as unknown as PrismaClient
