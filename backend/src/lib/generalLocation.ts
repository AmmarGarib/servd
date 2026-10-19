import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * "General — to be assigned" (owner, 2026-10-19: "general category for temporary
 * location so we can move it later as per requirement"): ONE holding place per
 * company for equipment whose outlet is not decided yet. It is a real Location
 * of that company, so the shared-equipment rule (LOCATION_REQUIRED_FOR_SHARED),
 * the register and asset transfers treat it like any outlet — the asset is moved
 * to its outlet later with a normal transfer. It is created INACTIVE so it never
 * shows as a trading outlet (storefront, till, time clock read active ones only).
 * Idempotent: keyed by its slug (unique), never a second row per company.
 */
export const GENERAL_LOCATION_NAME = 'General — to be assigned'

export function generalLocationSlug(tenantId: string): string {
  return `general-${tenantId}`
}

export async function ensureGeneralLocation(db: PrismaClient | Prisma.TransactionClient, tenantId: string): Promise<{ id: string; name: string }> {
  const slug = generalLocationSlug(tenantId)
  return db.location.upsert({
    where: { slug },
    create: { slug, name: GENERAL_LOCATION_NAME, tenantId, isActive: false },
    // A row of another company can never sit on this slug (the id is in it); a deleted one comes back.
    update: { deletedAt: null },
    select: { id: true, name: true },
  })
}

/** Outlets for an equipment picker: the General holding place first, then the company's outlets. */
export async function equipmentLocationsOf(db: PrismaClient, tenantId: string): Promise<Array<{ id: string; name: string; general?: true }>> {
  const general = await ensureGeneralLocation(db, tenantId)
  const rest = await db.location.findMany({
    where: { tenantId, deletedAt: null, id: { not: general.id } },
    select: { id: true, name: true }, orderBy: { name: 'asc' },
  })
  return [{ ...general, general: true }, ...rest]
}
