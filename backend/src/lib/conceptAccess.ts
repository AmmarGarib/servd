import type { UserRole } from '@prisma/client'
import { prisma } from './prisma.js'
import { ForbiddenError } from './errors.js'

// Roles that bypass the per-concept ACL — admin/CEO + every management tier.
// Management is still scoped by `tenantFilter` so a floor or head chef only
// sees their own brand's concepts; the bypass just skips the extra
// concept-id whitelist check on writes.
const CONCEPT_BYPASS_ROLES = [
  'admin', 'manager', 'management', 'foh_management', 'boh_management',
] as UserRole[]

const cache = new Map<string, { ids: Set<string>; expires: number }>()
const CACHE_TTL_MS = 30_000

async function getUserConceptIds(userId: string): Promise<Set<string>> {
  const now = Date.now()
  const hit = cache.get(userId)
  if (hit && hit.expires > now) return hit.ids

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { conceptIds: true },
  })
  const ids = new Set(user?.conceptIds ?? [])
  cache.set(userId, { ids, expires: now + CACHE_TTL_MS })
  return ids
}

export function invalidateConceptAccessCache(userId: string): void {
  cache.delete(userId)
}

export async function assertConceptAccess(
  staff: { id: string; role: UserRole },
  conceptId: string,
): Promise<void> {
  if (CONCEPT_BYPASS_ROLES.includes(staff.role)) return

  const allowed = await getUserConceptIds(staff.id)
  if (!allowed.has(conceptId)) {
    throw new ForbiddenError(`Access to concept ${conceptId} is not granted for this user`)
  }
}

export async function filterConceptIdsForStaff(
  staff: { id: string; role: UserRole },
  conceptIds?: string[] | null,
): Promise<string[] | null> {
  if (CONCEPT_BYPASS_ROLES.includes(staff.role)) return conceptIds ?? null

  const allowed = await getUserConceptIds(staff.id)
  if (allowed.size === 0) {
    throw new ForbiddenError('No concept access granted for this user')
  }
  if (!conceptIds || conceptIds.length === 0) {
    return Array.from(allowed)
  }
  const intersection = conceptIds.filter((id) => allowed.has(id))
  if (intersection.length === 0) {
    throw new ForbiddenError('No overlap between requested concepts and granted concepts')
  }
  return intersection
}
