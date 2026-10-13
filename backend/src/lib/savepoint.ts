// Run a statement block inside the caller's transaction behind a SAVEPOINT.
//
// Postgres aborts the WHOLE transaction on a failed statement; behind a
// savepoint only the block's own writes roll back and the transaction carries
// on. Used where a secondary write must never stop the main one — the
// completion claim's outbox writes (a fiscal bug can never stop a sale's
// ledger, loyalty and notice), stock and posting side-writes — and the caller
// flags the failure, never silently drops it.
//
// The name is interpolated into SQL, so it must be a plain identifier (a code
// constant, never user input) — anything else throws before touching the
// transaction.

import type { Prisma } from '@prisma/client'

const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

export async function withSavepoint<T>(
  tx: Prisma.TransactionClient,
  name: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  if (!SAVEPOINT_NAME.test(name)) throw new Error(`withSavepoint: bad savepoint name "${name}"`)
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`)
  try {
    const value = await fn()
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`)
    return { ok: true, value }
  } catch (err) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`)
    return { ok: false, error: err as Error }
  }
}
