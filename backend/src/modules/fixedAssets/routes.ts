// /accounting/fixed-assets — register, depreciation runs, disposal.
// Mounted under /accounting so the `accounting` module permission gates it.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { assertLocationOfCompany } from '../financePlanning/companyRefs.js'
import {
  ASSET_CATEGORIES, FUNDING, postAcquisition, runDepreciation, disposeAsset, periodOf,
  type AssetCategory, type Funding,
} from './service.js'
import { toCents, zMoneyCents } from '../../lib/money.js'

const createSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(Object.keys(ASSET_CATEGORIES) as [AssetCategory, ...AssetCategory[]]),
  // 'advance' is capex capitalised against supplier advances — only through
  // POST /finance/capex/lines/:lineId/capitalise, which knows the advances.
  funding: z.enum(Object.keys(FUNDING).filter((k) => k !== 'advance') as [Funding, ...Funding[]]),
  acquiredAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  // BIGINT paisa (lib/money.ts): one amount ≤ PKR 900bn, else 422.
  costCents: zMoneyCents('The asset\'s cost', { sign: 'positive' }),
  salvageCents: zMoneyCents('The salvage value').default(0),
  usefulLifeMonths: z.number().int().min(1).max(600),
  conceptId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  assetTag: z.string().max(60).optional(),
  serialNumber: z.string().max(80).optional(),
  supplier: z.string().max(120).optional(),
  notes: z.string().max(1000).optional(),
}).refine((d) => d.salvageCents < d.costCents, { message: 'Salvage value must be less than cost', path: ['salvageCents'] })


export async function fixedAssetRoutes(fastify: FastifyInstance) {
  // GET /accounting/fixed-assets — the register, with book values.
  fastify.get('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const rows = await prisma.fixedAsset.findMany({
      where: await scopeTenantWhere(req, 'read'),
      include: { depreciation: { select: { amountCents: true, period: true } } },
      orderBy: [{ status: 'asc' }, { acquiredAt: 'desc' }],
    })
    const assets = rows.map(({ depreciation, ...row }) => {
      const a = { ...row, costCents: toCents(row.costCents), salvageCents: toCents(row.salvageCents), disposalProceedsCents: toCents(row.disposalProceedsCents) }
      const accumulated = depreciation.reduce((s, d) => s + toCents(d.amountCents), 0)
      const lastCharged = depreciation.map((d) => d.period).sort().at(-1) ?? null
      return {
        ...a,
        categoryLabel: ASSET_CATEGORIES[a.category as AssetCategory]?.label ?? a.category,
        accumulatedCents: accumulated,
        bookValueCents: a.costCents - accumulated,
        monthlyCents: Math.floor(Math.max(0, a.costCents - a.salvageCents) / a.usefulLifeMonths),
        lastChargedPeriod: lastCharged,
      }
    })
    const active = assets.filter((a) => a.status === 'active')
    return {
      assets,
      totals: {
        costCents: active.reduce((s, a) => s + a.costCents, 0),
        accumulatedCents: active.reduce((s, a) => s + a.accumulatedCents, 0),
        bookValueCents: active.reduce((s, a) => s + a.bookValueCents, 0),
        monthlyCents: active.reduce((s, a) => s + a.monthlyCents, 0),
      },
      categories: ASSET_CATEGORIES,
      funding: FUNDING,
      currentPeriod: periodOf(new Date()),
    }
  })

  // POST /accounting/fixed-assets — add to the register and capitalise it.
  fastify.post('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const body = createSchema.parse(req.body)
    const tenantId = activeTenantId(req, 'the ledger is per company')
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    // The asset sits in one of THIS company's kitchens, never another's.
    if (body.locationId) await assertLocationOfCompany(tenantId, body.locationId)

    const asset = await prisma.fixedAsset.create({
      data: {
        tenantId,
        name: body.name.trim(),
        category: body.category,
        acquisitionCreditCode: FUNDING[body.funding].account,
        acquiredAt: new Date(body.acquiredAt),
        costCents: body.costCents,
        salvageCents: body.salvageCents,
        usefulLifeMonths: body.usefulLifeMonths,
        conceptId: body.conceptId ?? null,
        locationId: body.locationId ?? null,
        assetTag: body.assetTag || null,
        serialNumber: body.serialNumber || null,
        supplier: body.supplier || null,
        notes: body.notes || null,
        createdById: req.staffUser!.id,
      },
    })
    try {
      await postAcquisition(asset.id, req.staffUser!.id)
    } catch (err) {
      // No asset in the register that is not on the books: if the ledger
      // refuses (closed period, missing account), the register refuses too.
      await prisma.fixedAsset.delete({ where: { id: asset.id } }).catch(() => {})
      throw err
    }
    await audit({
      category: 'accounting', action: 'fixed_asset.create', entity: 'FixedAsset', entityId: asset.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: asset,
    })
    return reply.status(201).send(asset)
  })

  // PATCH /accounting/fixed-assets/:id — descriptive fields only. Cost, life
  // and dates drive posted depreciation; changing them after the fact would
  // silently rewrite history, so they are fixed once the asset is created.
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const body = z.object({
      name: z.string().min(1).max(120).optional(),
      assetTag: z.string().max(60).nullable().optional(),
      serialNumber: z.string().max(80).nullable().optional(),
      supplier: z.string().max(120).nullable().optional(),
      locationId: z.string().uuid().nullable().optional(),
      notes: z.string().max(1000).nullable().optional(),
    }).parse(req.body)
    const found = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!found) throw new NotFoundError('FixedAsset', req.params.id)
    if (body.locationId) await assertLocationOfCompany(found.tenantId, body.locationId)
    return prisma.fixedAsset.update({ where: { id: found.id }, data: body })
  })

  // POST /accounting/fixed-assets/depreciate — charge a month. Idempotent.
  fastify.post('/depreciate', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const body = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body)
    const tenantId = activeTenantId(req, 'the ledger is per company')
    const result = await runDepreciation(tenantId, body.period, req.staffUser!.id)
    await audit({
      category: 'accounting', action: 'fixed_asset.depreciate', entity: 'FixedAssetDepreciation', entityId: body.period,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      after: { period: body.period, chargedCents: result.chargedCents },
    })
    return result
  })

  // POST /accounting/fixed-assets/:id/dispose — sold or scrapped.
  fastify.post<{ Params: { id: string } }>('/:id/dispose', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const body = z.object({
      disposedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
      proceedsCents: zMoneyCents('The disposal proceeds').default(0),
    }).parse(req.body)
    const found = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!found) throw new NotFoundError('FixedAsset', req.params.id)
    const result = await disposeAsset(found.id, {
      disposedAt: new Date(body.disposedAt), proceedsCents: body.proceedsCents, postedBy: req.staffUser!.id,
    })
    await audit({
      category: 'accounting', action: 'fixed_asset.dispose', entity: 'FixedAsset', entityId: found.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: found.tenantId, after: result,
    })
    return result
  })
}
