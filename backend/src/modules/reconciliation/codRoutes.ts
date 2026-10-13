// /reconciliation/cod — cash-on-delivery money with the rider (H5, finance
// wave B).
//
// STUB registered by wave 0 so the prefix exists; the real plugin is built by
// the wave-B builder **w2-dlv-cod** (delivered COD a rider has not paid in —
// own riders on 1351, another company's fleet riders through an inter-company
// transfer). Replace this file; keep the default export a Fastify plugin.

import type { FastifyInstance } from 'fastify'

export default async function plugin(_fastify: FastifyInstance): Promise<void> {}
