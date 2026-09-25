// Rider assignment and delivery — dispatch/service.ts is the one set of rules.
//
// There used to be two route sets (/riders/assign|unassign and
// /dispatch/orders/:id/assign|unassign) that disagreed, and an auto-dispatch
// worker that assigned riders from any company. What this guards:
//   - a rider can only carry an order of their own company, and must be
//     active and not offline — for a manual assign AND the worker;
//   - unassigning frees the rider after their last active order (the
//     /dispatch unassign used to leave them 'busy' forever);
//   - "delivered" counts the delivery exactly once, frees the rider, keeps
//     the rider on the order for history, completes a 'ready' order through
//     updateOrderStatus (the ledger path) and refuses one the kitchen has not
//     finished.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { assignRider, unassignRider, markDelivered } from '../src/modules/dispatch/service.js'
import { runDispatchSweep } from '../src/workers/riderDispatch.js'

let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let n = 0

async function rider(tenantId: string, data: Partial<{ status: 'available' | 'busy' | 'offline'; isActive: boolean }> = {}) {
  n += 1
  return prisma.rider.create({
    data: { tenantId, name: `Rider ${n}`, phone: `+92311000${String(n).padStart(4, '0')}`, status: data.status ?? 'available', isActive: data.isActive ?? true },
  })
}

async function order(conceptId: string, status: 'received' | 'confirmed' | 'preparing' | 'ready' | 'completed' = 'ready', extra: Partial<{ riderId: string; deliveryOtp: string }> = {}) {
  return prisma.order.create({
    data: {
      conceptId, source: 'servd', status, totalCents: 50_000,
      riderId: extra.riderId ?? null, deliveryOtp: extra.deliveryOtp ?? null,
      ...(status === 'completed' && { completedAt: new Date() }),
    },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Fleet A', slug: 'fleet-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Fleet B', slug: 'fleet-b' } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'A Kitchen', slug: 'a-kitchen', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'B Kitchen', slug: 'b-kitchen', type: 'restaurant', tenantId: tenantB } })).id
})

describe('assignRider', () => {
  it("refuses another company's rider, an offline rider and an inactive rider", async () => {
    const o = await order(conceptA)
    const foreign = await rider(tenantB)
    await expect(assignRider(o.id, foreign.id)).rejects.toMatchObject({ code: 'RIDER_NOT_IN_COMPANY' })
    const off = await rider(tenantA, { status: 'offline' })
    await expect(assignRider(o.id, off.id)).rejects.toMatchObject({ code: 'RIDER_OFFLINE' })
    const gone = await rider(tenantA, { isActive: false })
    await expect(assignRider(o.id, gone.id)).rejects.toMatchObject({ statusCode: 404 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBeNull()
  })

  it('assigns and marks the rider busy', async () => {
    const o = await order(conceptA)
    const r = await rider(tenantA)
    await assignRider(o.id, r.id)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBe(r.id)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('busy')
  })
})

describe('unassignRider', () => {
  it('frees the rider after their last active order, not before', async () => {
    const r = await rider(tenantA)
    const o1 = await order(conceptA, 'preparing')
    const o2 = await order(conceptA, 'ready')
    await assignRider(o1.id, r.id)
    await assignRider(o2.id, r.id)

    await unassignRider(o1.id)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('busy')
    await unassignRider(o2.id)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('available')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o2.id } })).riderId).toBeNull()
  })
})

describe('markDelivered', () => {
  it('completes a ready order through the status path, counts the delivery once, frees the rider', async () => {
    const r = await rider(tenantA)
    const o = await order(conceptA, 'ready')
    await assignRider(o.id, r.id)

    const first = await markDelivered(o.id)
    expect(first.alreadyDelivered).toBe(false)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.status).toBe('completed')
    expect(after.completedAt).toBeInstanceOf(Date)
    expect(after.deliveredAt).toBeInstanceOf(Date)
    expect(after.riderId).toBe(r.id)   // stays on the order — rider history
    const rr = await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })
    expect(rr.totalDeliveries).toBe(1)
    expect(rr.status).toBe('available')

    const again = await markDelivered(o.id)
    expect(again.alreadyDelivered).toBe(true)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).totalDeliveries).toBe(1)
  })

  it('leaves an order expo already completed as it is, and still frees the rider', async () => {
    const r = await rider(tenantA, { status: 'busy' })
    const o = await order(conceptA, 'completed', { riderId: r.id })
    await markDelivered(o.id)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.status).toBe('completed')
    expect(after.deliveredAt).toBeInstanceOf(Date)
    const rr = await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })
    expect(rr.totalDeliveries).toBe(1)
    expect(rr.status).toBe('available')
  })

  it('refuses an order the kitchen has not finished, and one with no rider', async () => {
    const r = await rider(tenantA)
    const o = await order(conceptA, 'preparing')
    await assignRider(o.id, r.id)
    await expect(markDelivered(o.id)).rejects.toMatchObject({ code: 'NOT_READY' })
    const noRider = await order(conceptA, 'ready')
    await expect(markDelivered(noRider.id)).rejects.toMatchObject({ code: 'NO_RIDER' })
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).totalDeliveries).toBe(0)
  })
})

describe('auto-dispatch worker', () => {
  it("only hands an order to a rider of the order's company", async () => {
    // Clear the field so the sweep sees only this test's riders.
    await prisma.rider.updateMany({ data: { status: 'offline' } })
    const foreign = await rider(tenantB)
    const o = await order(conceptA, 'confirmed', { deliveryOtp: '1234' })

    // Only B's rider is free: A's order must wait rather than borrow them.
    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBeNull()
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe('available')

    const own = await rider(tenantA)
    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBe(own.id)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: own.id } })).status).toBe('busy')
  })
})
