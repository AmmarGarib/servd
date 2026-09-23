// Global brand filter — the admin's "Brand" picker, applied server-side.
//
// The admin sends `x-servd-brand: <conceptId>` on reads when a brand is picked.
// Two mechanisms carry it into modules without editing all 258 read routes:
//
//   1. Default `?conceptId`. Many list endpoints already accept a conceptId
//      query param (and validate ownership). On a GET that does not pass one,
//      the picked brand becomes the default. A page's own brand dropdown, when
//      used, still wins — an explicit choice beats a global default.
//
//   2. The scope helpers. conceptIdsInScope / conceptWhere in read mode narrow
//      to the picked brand, so endpoints built on them follow it too.
//
// HONESTY. Not every module is brand-shaped (payroll, the ledger's company
// totals, staff) and not every endpoint has been taught. A filter that
// silently does nothing would be worse than none: "Simmer" in the header over
// numbers for every brand. So the response says whether the brand was actually
// used — `x-servd-brand-applied: 1` — and the admin shows "not filtered here"
// on pages where it was not.
//
// Reads only. A write must never be narrowed by a view filter — editing a
// Stackd item while "Simmer" is picked would otherwise 404.

import type { FastifyInstance, FastifyRequest } from 'fastify'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type BrandReq = FastifyRequest & { __brandApplied?: boolean }

/** The brand picked in the admin, for a read. Null for writes or no pick. */
export function requestedBrand(req: FastifyRequest): string | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  const raw = req.headers['x-servd-brand']
  const v = Array.isArray(raw) ? raw[0] : raw
  return v && UUID.test(v) ? v : null
}

export function markBrandApplied(req: FastifyRequest): void {
  ;(req as BrandReq).__brandApplied = true
}

export function registerBrandScope(fastify: FastifyInstance): void {
  fastify.addHook('preValidation', async (req) => {
    const brand = requestedBrand(req)
    if (!brand) return
    const q = (req.query ?? {}) as Record<string, unknown>
    if (typeof q['conceptId'] === 'string' && q['conceptId']) return // page's own choice wins
    // A proxy rather than a plain assignment, so the brand is only reported as
    // applied if the handler actually READ conceptId. Routes that ignore the
    // param must not claim to be filtered.
    req.query = new Proxy({ ...q, conceptId: brand }, {
      get(target, prop, receiver) {
        if (prop === 'conceptId') markBrandApplied(req)
        return Reflect.get(target, prop, receiver)
      },
    })
  })

  fastify.addHook('onSend', async (req, reply, payload) => {
    if ((req as BrandReq).__brandApplied) reply.header('x-servd-brand-applied', '1')
    return payload
  })
}
