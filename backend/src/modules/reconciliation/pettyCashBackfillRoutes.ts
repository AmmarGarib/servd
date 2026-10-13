// /reconciliation/backfill-petty-cash — put the petty-cash boxes' history on
// the books (1011, finance wave B, H2).
//
// STUB registered by wave 0 so the prefix exists; the real plugin is built by
// the wave-B builder **w2-cash-ledger** (dry run + post, reusing
// backfillOrders.ts placeAndPost / withBackfillSlot). Replace this file; keep
// the default export a Fastify plugin.

import type { FastifyInstance } from 'fastify'

export default async function plugin(_fastify: FastifyInstance): Promise<void> {}
