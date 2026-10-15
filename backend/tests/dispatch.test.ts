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
//   - staff "Mark delivered" on a rider-app job is a manager's override, only
//     once the hand-over code has locked or if the rider never accepted —
//     checked up front AND in the delivered claim; pre-rider-app orders keep
//     the old rule; a second press is not an error;
//   - code-only delivery (lib/deliveryRules.ts) switched ON for a company:
//     no staff close at all (409 CODE_REQUIRED), only a verified code;
//   - the rider app's own location fix is a claim on the rider being on
//     shift: off shift, nothing is stored.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { assignRider, unassignRider, markDelivered, recordRiderFix } from '../src/modules/dispatch/service.js'
import { DELIVERY_OTP_MAX_ATTEMPTS } from '../src/lib/deliveryOtp.js'
import { runDispatchSweep } from '../src/workers/riderDispatch.js'
import { setCodeOnlyDelivery } from '../src/lib/deliveryRules.js'

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

async function order(conceptId: string, status: 'received' | 'confirmed' | 'preparing' | 'ready' | 'completed' = 'ready', extra: Partial<{ riderId: string; deliveryOtp: string; fulfilmentType: 'delivery' | 'takeout' }> = {}) {
  return prisma.order.create({
    data: {
      conceptId, source: 'servd', status, totalCents: 50_000,
      riderId: extra.riderId ?? null, deliveryOtp: extra.deliveryOtp ?? null,
      fulfilmentType: extra.fulfilmentType ?? 'takeout',
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

describe('markDelivered as a staff close (POST /dispatch/orders/:id/delivered)', () => {
  const manager = { staffClose: { manager: true } }
  const cashier = { staffClose: { manager: false } }

  it('on a rider-app job the rider has accepted: refused until the code locks, then a manager may close it', async () => {
    const r = await rider(tenantA)
    const o = await order(conceptA, 'ready', { deliveryOtp: '2580' })
    await assignRider(o.id, r.id)
    await prisma.order.update({ where: { id: o.id }, data: { riderAcceptedAt: new Date(), deliveryOtpAttempts: DELIVERY_OTP_MAX_ATTEMPTS - 1 } })

    await expect(markDelivered(o.id, cashier)).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 })
    await expect(markDelivered(o.id, manager)).rejects.toMatchObject({ code: 'RIDER_CLOSES_WITH_CODE', statusCode: 409 })
    // Refused before anything was written: not completed, not delivered.
    let after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.status).toBe('ready')
    expect(after.completedAt).toBeNull()
    expect(after.deliveredAt).toBeNull()
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).totalDeliveries).toBe(0)

    // The code locks: now it is a manager's to close (still not a cashier's).
    await prisma.order.update({ where: { id: o.id }, data: { deliveryOtpAttempts: DELIVERY_OTP_MAX_ATTEMPTS } })
    await expect(markDelivered(o.id, cashier)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const done = await markDelivered(o.id, manager)
    expect(done.alreadyDelivered).toBe(false)
    after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.status).toBe('completed')
    expect(after.deliveredAt).toBeInstanceOf(Date)
    expect(after.deliveryOtpVerifiedAt).toBeNull()      // closed without the code
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'delivered' } })
    expect(ev.note).toBe('marked delivered by a manager — hand-over code locked')
    const rr = await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })
    expect(rr.totalDeliveries).toBe(1)
    expect(rr.status).toBe('available')

    // Idempotent: a second press is the same answer, not a 409.
    const again = await markDelivered(o.id, manager)
    expect(again.alreadyDelivered).toBe(true)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).totalDeliveries).toBe(1)
  })

  it('a manager may close a job the rider never accepted (a rider without the app)', async () => {
    const r = await rider(tenantA)
    const o = await order(conceptA, 'ready')
    await assignRider(o.id, r.id)
    await expect(markDelivered(o.id, cashier)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await markDelivered(o.id, manager)).alreadyDelivered).toBe(false)
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'delivered' } })
    expect(ev.note).toBe('marked delivered by a manager — rider never accepted')
  })

  it('an order from before the rider app (no riderAssignedAt) keeps the old rule', async () => {
    const r = await rider(tenantA, { status: 'busy' })
    const o = await order(conceptA, 'ready', { riderId: r.id })
    const first = await markDelivered(o.id, cashier)
    expect(first.alreadyDelivered).toBe(false)
    expect(first.order.deliveredAt).toBeInstanceOf(Date)
    expect((await markDelivered(o.id, cashier)).alreadyDelivered).toBe(true)
  })

  it('the rider closing with the code first makes a late staff press a no-op, not an error', async () => {
    const r = await rider(tenantA)
    const o = await order(conceptA, 'ready', { deliveryOtp: '1470' })
    await assignRider(o.id, r.id)
    await prisma.order.update({ where: { id: o.id }, data: { riderAcceptedAt: new Date(), pickedUpAt: new Date() } })
    await markDelivered(o.id, { otpVerified: true })
    const late = await markDelivered(o.id, manager)
    expect(late.alreadyDelivered).toBe(true)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).totalDeliveries).toBe(1)
  })
})

describe('markDelivered with code-only delivery switched ON', () => {
  it('refuses every staff close, even the old-rule ones; a verified code still delivers', async () => {
    const tenantOn = (await prisma.tenant.create({ data: { name: 'Fleet On', slug: 'fleet-on' } })).id
    const conceptOn = (await prisma.concept.create({ data: { name: 'On Kitchen', slug: 'on-kitchen', type: 'restaurant', tenantId: tenantOn } })).id
    const ceo = await prisma.user.create({ data: { name: 'ceo-on', email: 'ceo-on.dispatch@gsfoods.pk', password: 'x', role: 'admin', tenantId: tenantOn } })
    await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: tenantOn, on: true, actorId: ceo.id, reason: 'code-only from today' }))

    // Pre-rider-app (no riderAssignedAt) and never-accepted: both were a staff close before.
    const r = await rider(tenantOn, { status: 'busy' })
    const legacy = await order(conceptOn, 'ready', { riderId: r.id })
    await expect(markDelivered(legacy.id, { staffClose: { manager: true } })).rejects.toMatchObject({ code: 'CODE_REQUIRED', statusCode: 409 })
    await expect(markDelivered(legacy.id)).rejects.toMatchObject({ code: 'CODE_REQUIRED' })
    const r2 = await rider(tenantOn)
    const neverAccepted = await order(conceptOn, 'ready')
    await assignRider(neverAccepted.id, r2.id)
    await expect(markDelivered(neverAccepted.id, { staffClose: { manager: true } })).rejects.toMatchObject({ code: 'CODE_REQUIRED' })
    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: neverAccepted.id } })
    expect(untouched.status).toBe('ready')
    expect(untouched.deliveredAt).toBeNull()

    const ok = await markDelivered(legacy.id, { otpVerified: true })
    expect(ok.alreadyDelivered).toBe(false)
    expect(ok.order.deliveryOtpVerifiedAt).toBeInstanceOf(Date)
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: legacy.id, type: 'delivered' } })
    expect(ev.note).toBe('hand-over code verified')

    // Company A (switch OFF) keeps the old staff close.
    const ra = await rider(tenantA, { status: 'busy' })
    const oa = await order(conceptA, 'ready', { riderId: ra.id })
    expect((await markDelivered(oa.id, { staffClose: { manager: false } })).alreadyDelivered).toBe(false)
  })
})

describe('recordRiderFix', () => {
  it("the rider app's fix is a claim on being on shift: off shift, nothing is stored", async () => {
    const r = await rider(tenantA, { status: 'offline' })
    // The guard read the rider on shift; they went off before the write.
    await expect(recordRiderFix(r, { lat: 24.8, lng: 67.05 }, { onShiftOnly: true }))
      .rejects.toMatchObject({ code: 'OFF_SHIFT', statusCode: 409 })
    expect(await prisma.riderLocation.count({ where: { riderId: r.id } })).toBe(0)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })).lastReportedAt).toBeNull()

    // The staff relay (no onShiftOnly) still records an off-shift rider's fix,
    // and neither path changes their status.
    await recordRiderFix(r, { lat: 24.8, lng: 67.05 })
    expect(await prisma.riderLocation.count({ where: { riderId: r.id } })).toBe(1)
    await prisma.rider.update({ where: { id: r.id }, data: { status: 'available' } })
    await expect(recordRiderFix(r, { lat: 24.81, lng: 67.06 }, { onShiftOnly: true })).resolves.toMatchObject({ ok: true })
    const after = await prisma.rider.findUniqueOrThrow({ where: { id: r.id } })
    expect(after.lastLat).toBe(24.81)
    expect(after.status).toBe('available')
    expect(await prisma.riderLocation.count({ where: { riderId: r.id } })).toBe(2)
  })
})

describe('auto-dispatch worker', () => {
  it("only hands an order to a rider of the order's company", async () => {
    // Clear the field so the sweep sees only this test's riders.
    await prisma.rider.updateMany({ data: { status: 'offline' } })
    const foreign = await rider(tenantB)
    // A delivery order (its fulfilment type, not the presence of a code, is
    // what makes it one — docs/rider-app.md).
    const o = await order(conceptA, 'confirmed', { deliveryOtp: '1234', fulfilmentType: 'delivery' })

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
