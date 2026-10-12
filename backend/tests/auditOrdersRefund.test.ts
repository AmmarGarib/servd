// After-sale audit (2026-10-10 till + kitchen simulations).
//
// What this guards:
//   - FOH-18: a refunded (or cancelled) order leaves the customer's rollups at
//     once — lifetime spend, first / last order date are computed from
//     completed orders only, and they feed referral payouts and CRM segments.
//   - FOH-25: a refund of an order that was never invoiced does not log a false
//     "[invoice] auto credit-note failed" — the skip is decided on the error
//     code, so a real failure still logs.
//   - BOH-15: a dish the stock auto-86'd is recorded as such, and once its
//     ingredients are back in stock it is listed (company-scoped) at
//     GET /kds/auto-86/back-in-stock for a one-tap "back on". Nothing switches
//     it back on by itself; a dish 86'd by hand is not listed.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, NotFoundError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { recomputeCustomerRollups } from '../src/lib/customerRollups.js'
import {
  updateOrderStatus, cancelOrder, deductInventoryForOrder, isNoInvoiceToCredit,
} from '../src/modules/orders/service.js'
import { kdsRoutes } from '../src/modules/kds/routes.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let croissantId: string
let muffinId: string
let butterId: string
let staffA: string
let tokenA: string
let tokenB: string

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'After A', slug: 'after-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'After B', slug: 'after-b' } })).id
  await ensureChartOfAccounts(tenantA)
  conceptA = (await prisma.concept.create({
    data: { name: 'After Stackd', slug: 'after-stackd', type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  conceptB = (await prisma.concept.create({
    data: { name: 'After Other', slug: 'after-other', type: 'restaurant', tenantId: tenantB, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  const cat = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Bakes' } })).id
  croissantId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name: 'Butter Croissant', priceCents: 60_000 } })).id
  muffinId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name: 'Muffin', priceCents: 40_000 } })).id
  const frozen = (await prisma.inventoryItem.create({ data: { tenantId: tenantA, name: 'Croissant (frozen)', unit: 'pcs', currentStock: 3 } })).id
  butterId = frozen
  await prisma.recipe.create({
    data: { kind: 'plate', menuItemId: croissantId, servings: 1, ingredients: { create: [{ inventoryItemId: frozen, quantity: 1, yieldPct: 1, unit: 'pcs' }] } },
  })

  const mk = async (email: string, tenantId: string) => prisma.user.create({
    data: { name: email, email, password: 'x', role: 'admin', isActive: true, accountStatus: 'active', tenantId } as never,
  })
  const a = await mk('after-admin-a@test.local', tenantA)
  staffA = a.id
  tokenA = (issueStaffSession(a) as { accessToken: string }).accessToken
  tokenB = (issueStaffSession(await mk('after-admin-b@test.local', tenantB)) as { accessToken: string }).accessToken

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(kdsRoutes, { prefix: '/kds' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

// ─── FOH-18 / FOH-25 ──────────────────────────────────────────────────────────

describe('FOH-18 / FOH-25 — refunds', () => {
  it('a refunded order leaves the customer\'s rollups, and no false credit-note error is logged', async () => {
    const customer = await prisma.customer.create({ data: { name: 'Refund Guest', phone: `+92300${Math.floor(Math.random() * 1e7)}` } })
    const order = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', status: 'completed', completedAt: new Date(), totalCents: 156_600,
        customerId: customer.id,
        items: { create: [{ name: 'Butter Croissant', quantity: 1, unitPriceCents: 156_600, status: 'bumped' }] },
      },
    })
    await recomputeCustomerRollups(customer.id)
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })
    expect(before.totalSpentCents).toBe(156_600)
    expect(before.firstOrderAt).not.toBeNull()

    const errors = vi.spyOn(console, 'error')
    try {
      await updateOrderStatus(order.id, 'refunded')
      const after = await waitFor(
        () => prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }),
        (c) => c.totalSpentCents === 0,
      )
      expect(after.totalSpentCents).toBe(0)
      expect(after.firstOrderAt).toBeNull()
      expect(after.lastOrderAt).toBeNull()
      await settle()
      const creditNoteNoise = errors.mock.calls.filter((c) => String(c[0]).includes('[invoice] auto credit-note failed'))
      expect(creditNoteNoise).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  it('a cancel recomputes too (stale rollups converge)', async () => {
    const customer = await prisma.customer.create({ data: { name: 'Cancel Guest', phone: `+92301${Math.floor(Math.random() * 1e7)}` } })
    await prisma.customer.update({ where: { id: customer.id }, data: { totalSpentCents: 999, firstOrderAt: new Date() } })
    const order = await prisma.order.create({
      data: { conceptId: conceptA, source: 'servd', status: 'received', totalCents: 40_000, customerId: customer.id },
    })
    await cancelOrder(order.id, { reason: 'Customer called', actor: { id: staffA, tenantId: tenantA } })
    const after = await waitFor(() => prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }), (c) => c.totalSpentCents === 0)
    expect(after.totalSpentCents).toBe(0)
    expect(after.firstOrderAt).toBeNull()
  })

  it('the skip is decided on the error code: only "no tax invoice" is silent', () => {
    expect(isNoInvoiceToCredit(new NotFoundError('TaxInvoice', 'x'))).toBe(true)
    expect(isNoInvoiceToCredit(new NotFoundError('Concept', 'x'))).toBe(false)
    expect(isNoInvoiceToCredit(new Error('NOT_FOUND'))).toBe(false)
    expect(isNoInvoiceToCredit(new AppError('SRB_DOWN', 'TaxInvoice gateway down', 502))).toBe(false)
  })
})

// ─── BOH-15 ───────────────────────────────────────────────────────────────────

describe('BOH-15 — auto-86\'d dishes back in stock', () => {
  it('records the auto-86 and lists the dish once stock is back — to its own company only', async () => {
    const order = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', status: 'received', totalCents: 180_000,
        items: { create: [{ menuItemId: croissantId, name: 'Butter Croissant', quantity: 3, unitPriceCents: 60_000 }] },
      },
    })
    await deductInventoryForOrder(order.id)
    const off = await prisma.menuItem.findUniqueOrThrow({ where: { id: croissantId } })
    expect(off.isAvailable).toBe(false)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'menu.auto_86', entityId: croissantId } })
    expect(audit.tenantId).toBe(tenantA)
    expect(audit.category).toBe('stock')

    // A dish 86'd by hand is never suggested.
    await prisma.menuItem.update({ where: { id: muffinId }, data: { isAvailable: false } })

    // Stock still at zero: nothing to put back.
    let list = (await get('/kds/auto-86/back-in-stock', tokenA)).json() as { items: Array<{ menuItemId: string }> }
    expect(list.items).toEqual([])

    // The delivery comes in.
    await prisma.inventoryItem.update({ where: { id: butterId }, data: { currentStock: 40 } })
    list = (await get('/kds/auto-86/back-in-stock', tokenA)).json() as { items: Array<{ menuItemId: string; name: string }> }
    expect(list.items.map((i) => i.menuItemId)).toEqual([croissantId])
    // Still off: suggesting is not switching back on.
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: croissantId } })).isAvailable).toBe(false)

    // Company B sees none of it, and can't name A's brand.
    expect(((await get('/kds/auto-86/back-in-stock', tokenB)).json() as { items: unknown[] }).items).toEqual([])
    expect((await get(`/kds/auto-86/back-in-stock?conceptId=${conceptA}`, tokenB)).statusCode).toBe(404)
    expect(((await get(`/kds/auto-86/back-in-stock?conceptId=${conceptB}`, tokenB)).json() as { items: unknown[] }).items).toEqual([])

    // Once a manager puts it back on, it drops off the list.
    await prisma.menuItem.update({ where: { id: croissantId }, data: { isAvailable: true } })
    list = (await get('/kds/auto-86/back-in-stock', tokenA)).json() as { items: Array<{ menuItemId: string }> }
    expect(list.items).toEqual([])
  })
})
