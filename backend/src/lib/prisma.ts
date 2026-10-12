import { PrismaClient } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getRlsContext } from './rlsContext.js'
import { moneyAsNumbers, installBigIntJson } from './money.js'

// Safety net only: a stray bigint still serialises as a JSON number. The
// money boundary below (moneyAsNumbers) is the mechanism of record.
installBigIntJson()

// Two clients backed by the same Postgres pool. They differ in whether
// they thread the active RLS context into each query:
//
//   • serviceClient — no RLS extension, no SET LOCAL (it does carry the
//                     money boundary — see below). For
//                     background workers, webhook handlers, adapters
//                     called from those, and the auth flow's pre-context
//                     lookups. Policies treat queries from this client as
//                     "service mode" (session vars NULL) and allow
//                     everything — that's how the cron/webhook surface
//                     keeps working with policies enabled.
//   • prisma        — extended. When RLS_ENFORCE=1, every query first
//                     runs SELECT set_config('app.tenant_ids', …, true)
//                     and set_config('app.customer_id', …, true) in
//                     whichever transaction the query will execute in.
//                     Policies on tenant- and customer-scoped tables
//                     read those vars to gate row visibility.
//
// Two execution shapes need handling:
//
//   1. A bare model op (prisma.foo.bar(…)) runs in Prisma's implicit
//      single-statement transaction. We wrap it in an explicit
//      $transaction([SET, query]) so the SET LOCAL persists for the
//      query that follows it on the same connection.
//
//   2. An interactive transaction (prisma.$transaction(async (tx) => …))
//      is the trickier case. The user's callback runs against `tx`, a
//      tx-scoped client. If we wrapped each tx-scoped op in its own
//      outer $transaction, we'd be reaching into a different connection
//      and the SET would be lost. Instead we override $transaction at
//      the client level: at the start of the callback, while still
//      inside Prisma's tx, we run the SET via tx.$executeRaw — that
//      writes the session var onto the same connection the rest of the
//      callback uses. A re-entrancy flag (inTxFlag) tells the per-query
//      wrapper to skip its own wrap while we're inside that callback.
//
// BIGINT money columns (BOOKS-06) come back as JS numbers on EVERY client:
// lib/money.ts's moneyAsNumbers is installed on the base client, UNDER the
// RLS extension. It has to sit there: the $transaction override below
// delegates to basePrisma, so the tx it hands out carries it too.

const ENFORCE_RLS = process.env['RLS_ENFORCE'] === '1'

const globalForPrisma = globalThis as unknown as {
  basePrisma?: PrismaClient
}

const rawPrisma = globalForPrisma.basePrisma ??
  new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.basePrisma = rawPrisma
}

// BIGINT money columns come back as JS numbers on every client (lib/money.ts).
// Typed as PrismaClient on purpose: exporting the extended type breaks the tx
// client's assignability across the app; Prisma still types the widened
// fields `bigint`, so code converts with toCents/sumCents where tsc asks.
const basePrisma = rawPrisma.$extends(moneyAsNumbers) as unknown as PrismaClient

export const serviceClient = basePrisma

// Tracks "we're inside a user-supplied $transaction callback that we
// already SET LOCAL'd at the top of." Per-query operations check this to
// avoid double-wrapping (which would acquire a different connection and
// lose the SET).
const inTxFlag = new AsyncLocalStorage<boolean>()

function setLocalSql(ctx: { tenantIds?: string[]; customerId?: string | null }) {
  const tenantIds = (ctx.tenantIds ?? []).join(',')
  // Returns the SQL fragment as a tagged-template result so callers can
  // execute it via either $executeRaw on the base client or on a tx.
  return { tenantIds, customerId: ctx.customerId ?? '' }
}

export const prisma = basePrisma.$extends({
  name: 'rls-session-vars',

  client: {
    // Override $transaction to insert the SET LOCAL on the transaction's
    // own connection, BEFORE any user query runs. Both shapes are
    // handled:
    //
    //   • Callback form — basePrisma.$transaction(async tx => …). We
    //     run the SET via tx.$executeRaw inside the wrapper, then yield
    //     to the user's callback with the same tx.
    //   • Array form — basePrisma.$transaction([p1, p2, …]). We prepend
    //     a $executeRaw promise that runs SET LOCAL on the same
    //     connection the other promises will use.
    //
    // The inTxFlag is set for the duration of either form so the
    // per-query wrapper skips its own SET (which would acquire a
    // different connection and lose the var).
    async $transaction(this: unknown, arg: unknown, opts?: unknown) {
      const ctx = getRlsContext()
      if (typeof arg === 'function') {
        return basePrisma.$transaction(async (tx) => {
          if (ENFORCE_RLS && ctx) {
            const { tenantIds, customerId } = setLocalSql(ctx)
            await tx.$executeRaw`SELECT
              set_config('app.tenant_ids',  ${tenantIds},  true),
              set_config('app.customer_id', ${customerId}, true)`
          }
          return inTxFlag.run(true, () => (arg as (tx: unknown) => unknown)(tx))
        }, opts as never)
      }
      if (Array.isArray(arg)) {
        if (ENFORCE_RLS && ctx) {
          const { tenantIds, customerId } = setLocalSql(ctx)
          const setPromise = basePrisma.$executeRaw`SELECT
            set_config('app.tenant_ids',  ${tenantIds},  true),
            set_config('app.customer_id', ${customerId}, true)`
          return inTxFlag.run(true, () =>
            (basePrisma.$transaction as (...a: unknown[]) => Promise<unknown[]>)(
              [setPromise, ...arg],
              opts,
            ).then((results) => results.slice(1)),
          )
        }
        return (basePrisma.$transaction as (...a: unknown[]) => Promise<unknown>)(arg, opts)
      }
      return (basePrisma.$transaction as (...a: unknown[]) => Promise<unknown>)(arg, opts)
    },
  },

  query: {
    async $allOperations({ args, query }) {
      if (!ENFORCE_RLS) return query(args)
      const ctx = getRlsContext()
      if (!ctx) return query(args)         // outside a request — service mode
      if (inTxFlag.getStore()) return query(args)  // SET already injected by our $transaction override

      const { tenantIds, customerId } = setLocalSql(ctx)
      const [, result] = await basePrisma.$transaction([
        basePrisma.$executeRaw`SELECT
          set_config('app.tenant_ids',  ${tenantIds},  true),
          set_config('app.customer_id', ${customerId}, true)`,
        query(args),
      ])
      return result
    },
  },
}) as unknown as PrismaClient
