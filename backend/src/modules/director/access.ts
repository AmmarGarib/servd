// Director logins (owner, 2026-10-18): WHICH brands a request may see.
//
// "I need to make a new category of login, 'Director'. For Yusuf and Ali,
// partners in Flipd, to be able to see how business is doing." A director
// sees ONLY the brands on their login (User.directorConceptIds), read-only.
//
// The ONE resolver of the brand list for the Director API (routes.ts) and the
// ONE validator of the brands the CEO gives a director (auth/routes.ts POST /
// PATCH /auth/users). The list always comes from the LOGIN, read live from the
// database on every request — never from the client. A conceptId the client
// names must be in that list (else 404, the same answer for another company's
// brand and for a brand id that does not exist).
//
//   director → the brands on their login that still exist, in a company the
//              login belongs to (a brand moved out of those companies drops
//              out — fails closed). No brands = sees nothing, never "all".
//   admin    → previews: any live brand of a company the CEO is a member of
//              (never a company only reached through a head office).
//   anyone else → nothing (the routes admit only these two roles anyway).

import type { FastifyRequest } from 'fastify'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { setRlsContext } from '../../lib/rlsContext.js'
import { formatBrandName } from '../../lib/brandName.js'

export interface DirectorBrand { id: string; name: string; slug: string; tenantId: string }

/** At most this many brands on one director login. */
export const MAX_DIRECTOR_BRANDS = 20

/** The brands this request may see (see the header). */
export async function directorBrands(req: FastifyRequest): Promise<DirectorBrand[]> {
  const su = req.staffUser
  if (!su) return []
  const companies = su.memberTenantIds
  if (companies.length === 0) return []
  let where: { id?: { in: string[] }; deletedAt: null; tenantId: { in: string[] } }
  if (su.role === 'director') {
    const u = await serviceClient.user.findUnique({ where: { id: su.id }, select: { directorConceptIds: true } })
    const ids = u?.directorConceptIds ?? []
    if (ids.length === 0) return []
    where = { id: { in: ids }, deletedAt: null, tenantId: { in: companies } }
  } else if (su.role === 'admin') {
    where = { deletedAt: null, tenantId: { in: companies } }
  } else {
    return []
  }
  const rows = await serviceClient.concept.findMany({
    where,
    select: { id: true, name: true, slug: true, tenantId: true },
    orderBy: { name: 'asc' },
  })
  return rows
    .filter((r): r is typeof r & { tenantId: string } => !!r.tenantId)
    .map((r) => ({ id: r.id, name: formatBrandName(r.name), slug: r.slug, tenantId: r.tenantId }))
}

/**
 * The brand a Director request reads: the one the client named (it must be in
 * the login's list — 404 otherwise), else the first in the list, else null
 * (a director with no brands: every answer is empty). Narrows the request's
 * row-level-security scope to that brand's company.
 */
export async function pickDirectorBrand(req: FastifyRequest, conceptId: string | undefined): Promise<DirectorBrand | null> {
  const brands = await directorBrands(req)
  let brand: DirectorBrand | null
  if (conceptId) {
    brand = brands.find((b) => b.id === conceptId) ?? null
    if (!brand) throw new NotFoundError('Brand', conceptId)
  } else {
    brand = brands[0] ?? null
  }
  setRlsContext({ tenantIds: brand ? [brand.tenantId] : [] })
  return brand
}

/**
 * The brands the CEO gives a director (POST / PATCH /auth/users): at least
 * one, at most MAX_DIRECTOR_BRANDS, each a live brand of a company the CEO is
 * a member of (422 BRAND_NOT_IN_COMPANY — another company's brand, a deleted
 * one or an id that does not exist all get the same answer). Returns the ids
 * (deduplicated, in the order given) and the companies they belong to — the
 * director's companies are exactly those (first = primary).
 */
export async function validateDirectorBrands(req: FastifyRequest, ids: readonly string[]): Promise<{ conceptIds: string[]; tenantIds: string[] }> {
  const conceptIds = Array.from(new Set(ids.map((s) => s.trim()).filter(Boolean)))
  if (conceptIds.length === 0) {
    throw new AppError('DIRECTOR_NEEDS_BRAND', 'Pick at least one brand this director may see.', 422)
  }
  if (conceptIds.length > MAX_DIRECTOR_BRANDS) {
    throw new AppError('TOO_MANY_BRANDS', `A director may see at most ${MAX_DIRECTOR_BRANDS} brands.`, 422)
  }
  const mine = new Set(req.staffUser?.memberTenantIds ?? [])
  const rows = await serviceClient.concept.findMany({
    where: { id: { in: conceptIds }, deletedAt: null },
    select: { id: true, tenantId: true },
  })
  const companyOf = new Map(rows.map((r) => [r.id, r.tenantId]))
  const tenantIds: string[] = []
  for (const id of conceptIds) {
    const t = companyOf.get(id)
    if (!t || !mine.has(t)) {
      throw new AppError('BRAND_NOT_IN_COMPANY', 'A director can only be given brands of your own companies.', 422)
    }
    if (!tenantIds.includes(t)) tenantIds.push(t)
  }
  return { conceptIds, tenantIds }
}
