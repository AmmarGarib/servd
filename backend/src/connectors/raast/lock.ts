// The ONE per-company Raast lock (amendments M2/M3). Every Raast write path
// takes it FIRST inside its own short transaction, before lockOrderTx or any
// row lock, so the SMS matcher, the cashier's confirm / typed reference, an
// attach, a reference fix and an intent cancel / expiry for the same company
// are serialised and can never overwrite each other's receipt state:
//
//   processPayment / settlePayment with a raast tender, intent create /
//   confirm / cancel / expiry, alert attach / dismiss, applyBankCredit's claim
//   and finish steps, finance's reference fix / match / unreceived.
//
// Transaction-scoped (pg_advisory_xact_lock): released at commit/rollback.
// Never hold an interactive transaction across processPayment to keep it
// (M3) — take it again in each short transaction instead.

import type { Prisma } from '@prisma/client'

export async function lockRaastTx(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('raast-match'))`
}
