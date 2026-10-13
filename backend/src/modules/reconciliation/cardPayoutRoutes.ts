// /reconciliation/card-payouts — card payouts at payout (H12, finance wave B).
//
// STUB registered by wave 0 so the prefix exists; the real plugin is built by
// the wave-B builder **w1-recon** (card sales grouped per machine and day,
// matched to the bank payout net of the MDR; the fee incl. its tax booked to
// 6080 at payout). Replace this file; keep the default export a Fastify plugin.

import type { FastifyInstance } from 'fastify'

export default async function plugin(_fastify: FastifyInstance): Promise<void> {}
