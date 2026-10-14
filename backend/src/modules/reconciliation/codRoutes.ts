// /reconciliation/cod — cash-on-delivery money with the rider (H5, finance
// wave B).
//
// EMPTY STUB registered by wave 0 so the prefix exists. COD custody
// (delivered COD a rider has not paid in — own riders on 1351, another
// company's fleet riders through an inter-company transfer) is PARKED with
// delivery and customers (owner, 2026-10-13; .handoff/parked/2026-10-14/).
// Build nothing here until the owner resumes it; keep the default export a
// Fastify plugin.

import type { FastifyInstance } from 'fastify'

export default async function plugin(_fastify: FastifyInstance): Promise<void> {}
