// Smallwares pools (H21; owner: smallwares grouped, big items individual).
//
// A pool is one outlet × brand (optional) × class × type ("Plates — Clifton ·
// Simmer"). Each purchase capitalised into it is a LAYER: a FixedAsset of kind
// 'pool_layer' with a quantity, depreciated over the class life (24 months)
// from its own in-service month. Breakage, loss and unit transfers come out of
// the layers FIFO — oldest in-service first — so the units that leave are the
// most worn ones.

import type { FixedAsset, FixedAssetPool } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { SMALLWARE_TYPES, SMALLWARE_TYPE_LABELS, classOf, type Db } from './classes.js'

/**
 * The pool for (company, outlet, brand, class, type), created when missing.
 * The outlet and brand must belong to `tenantId` (422), the class must be a
 * pooled class of the company and the type a SMALLWARE_TYPES key. Serialised
 * on the pool's key with an advisory lock (the expression unique
 * fixed_asset_pools_key would otherwise abort the caller's transaction on a
 * race).
 */
export async function findOrCreatePool(
  tx: Db,
  a: { tenantId: string; locationId: string; conceptId: string | null; classKey: string; typeKey: string; createdById?: string | null },
): Promise<FixedAssetPool> {
  if (!SMALLWARE_TYPES.includes(a.typeKey)) {
    throw new AppError('POOL_TYPE', `Unknown smallwares type "${a.typeKey}" — one of ${SMALLWARE_TYPES.join(', ')}`, 422)
  }
  const cls = await classOf(a.tenantId, a.classKey, tx)
  if (!cls.pooled) throw new AppError('CLASS_NOT_POOLED', `${cls.label} is not a pooled class — its items go on the register one by one`, 422)
  const location = await tx.location.findUnique({ where: { id: a.locationId }, select: { tenantId: true, name: true } })
  if (!location || location.tenantId !== a.tenantId) {
    throw new AppError('LOCATION_NOT_IN_COMPANY', 'That outlet is not one of this company\'s locations', 422)
  }
  let brandName: string | null = null
  if (a.conceptId) {
    const concept = await tx.concept.findUnique({ where: { id: a.conceptId }, select: { tenantId: true, name: true } })
    if (!concept || concept.tenantId !== a.tenantId) {
      throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand is not one of this company\'s brands', 422)
    }
    brandName = concept.name
  }

  const key = `fixed_asset_pool:${a.tenantId}:${a.locationId}:${a.conceptId ?? ''}:${a.classKey}:${a.typeKey}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
  const existing = await tx.fixedAssetPool.findFirst({
    where: { tenantId: a.tenantId, locationId: a.locationId, conceptId: a.conceptId, classKey: a.classKey, typeKey: a.typeKey },
  })
  if (existing) return existing
  const label = `${SMALLWARE_TYPE_LABELS[a.typeKey] ?? a.typeKey} — ${location.name}${brandName ? ` · ${brandName}` : ''}`.slice(0, 160)
  return tx.fixedAssetPool.create({
    data: {
      tenantId: a.tenantId,
      locationId: a.locationId,
      conceptId: a.conceptId,
      classKey: a.classKey,
      typeKey: a.typeKey,
      label,
      createdById: a.createdById ?? null,
    },
  })
}

/** A pool's live layers, oldest in-service first (the FIFO order). */
export async function poolLayersFifo(tx: Db, poolId: string): Promise<FixedAsset[]> {
  return tx.fixedAsset.findMany({
    where: { poolId, kind: 'pool_layer', status: 'active', quantity: { gt: 0 } },
    orderBy: [{ inServiceAt: 'asc' }, { acquiredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** Units on hand in a pool (every live layer). */
export async function poolUnitsOnHand(tx: Db, poolId: string): Promise<number> {
  const layers = await poolLayersFifo(tx, poolId)
  return layers.reduce((t, l) => t + l.quantity, 0)
}

/** How many units each layer gives up, FIFO. 409 UNITS_EXCEED_POOL when the pool has fewer. */
export function allocateFifo(layers: ReadonlyArray<Pick<FixedAsset, 'id' | 'quantity'>>, units: number): Array<{ layerId: string; units: number }> {
  if (!Number.isInteger(units) || units <= 0) throw new AppError('BAD_UNITS', 'Units must be a whole number above 0', 422)
  const onHand = layers.reduce((t, l) => t + l.quantity, 0)
  if (units > onHand) {
    throw new AppError('UNITS_EXCEED_POOL', `The pool holds ${onHand} unit${onHand === 1 ? '' : 's'} — cannot take out ${units}`, 409, { onHand, units })
  }
  const out: Array<{ layerId: string; units: number }> = []
  let left = units
  for (const l of layers) {
    if (left <= 0) break
    const take = Math.min(left, l.quantity)
    if (take > 0) out.push({ layerId: l.id, units: take })
    left -= take
  }
  return out
}

/**
 * The slice of `totalCents` that `units` of `quantity` carry: proportional,
 * rounded, and the WHOLE remainder when the slice takes every unit left (so
 * the last unit out takes what remains and nothing is stranded).
 */
export function sliceCents(totalCents: number, units: number, quantity: number): number {
  if (quantity <= 0) return 0
  if (units >= quantity) return totalCents
  return Math.round((totalCents * units) / quantity)
}

/** A layer's money columns as numbers. */
export function layerMoney(l: Pick<FixedAsset, 'costCents' | 'salvageCents' | 'carriedAccumulatedCents'>): { cost: number; salvage: number; carried: number } {
  return { cost: toCents(l.costCents), salvage: toCents(l.salvageCents), carried: toCents(l.carriedAccumulatedCents) }
}
