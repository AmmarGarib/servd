// Customer rollup tests.
//
// What this guards:
//   - recomputeCustomerRollups counts no-shows correctly
//   - It correctly updates lastVisitAt to MAX(lastOrderAt, last seated reservation)
//   - It computes avgReviewRating from reviews
//   - It's idempotent — calling it twice yields the same result
//
// Requires a test database.

import { beforeEach, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { recomputeCustomerRollups } from '../src/lib/customerRollups.js'

const prisma = (globalThis as { __TEST_PRISMA__?: PrismaClient }).__TEST_PRISMA__ ?? new PrismaClient()

describe('customerRollups: cross-module aggregation', () => {
  let customerId: string
  let conceptId: string

  beforeEach(async () => {
    await prisma.orderReview.deleteMany({})
    await prisma.orderComplaint.deleteMany({})
    await prisma.orderItem.deleteMany({})
    await prisma.order.deleteMany({})
    await prisma.reservation.deleteMany({})
    await prisma.customer.deleteMany({})
    await prisma.concept.deleteMany({})

    const concept = await prisma.concept.create({
      data: { name: 'Rollup Test', slug: `rollup-${Date.now()}`, type: 'restaurant' },
    })
    conceptId = concept.id
    const customer = await prisma.customer.create({
      data: { name: 'Rollup Customer', email: `rollup-${Date.now()}@test.local` },
    })
    customerId = customer.id
  })

  test('counts no-shows from reservations', async () => {
    const start = new Date('2026-08-01T19:00:00')
    await prisma.reservation.createMany({
      data: [
        { conceptId, customerId, partySize: 2, startTime: start, endTime: new Date(start.getTime() + 90*60_000), guestName: 'A', source: 'staff', status: 'no_show' },
        { conceptId, customerId, partySize: 2, startTime: new Date(start.getTime() + 86_400_000), endTime: new Date(start.getTime() + 86_400_000 + 90*60_000), guestName: 'B', source: 'staff', status: 'no_show' },
        { conceptId, customerId, partySize: 2, startTime: new Date(start.getTime() + 172_800_000), endTime: new Date(start.getTime() + 172_800_000 + 90*60_000), guestName: 'C', source: 'staff', status: 'completed' },
      ],
    })
    await recomputeCustomerRollups(customerId)
    const c = await prisma.customer.findUnique({ where: { id: customerId } })
    expect(c?.noShowCount).toBe(2)
    expect(c?.lastNoShowAt).toBeInstanceOf(Date)
  })

  test('avgReviewRating computes correctly', async () => {
    // Need real orders to attach reviews to.
    const o1 = await prisma.order.create({ data: { conceptId, customerId, source: 'pos', externalId: 'r1', status: 'completed', totalCents: 100_00, taxCents: 0, completedAt: new Date() } })
    const o2 = await prisma.order.create({ data: { conceptId, customerId, source: 'pos', externalId: 'r2', status: 'completed', totalCents: 100_00, taxCents: 0, completedAt: new Date() } })
    const o3 = await prisma.order.create({ data: { conceptId, customerId, source: 'pos', externalId: 'r3', status: 'completed', totalCents: 100_00, taxCents: 0, completedAt: new Date() } })
    await prisma.orderReview.createMany({
      data: [
        { orderId: o1.id, customerId, conceptId, rating: 5, isPositive: true, source: 'storefront' },
        { orderId: o2.id, customerId, conceptId, rating: 4, isPositive: true, source: 'storefront' },
        { orderId: o3.id, customerId, conceptId, rating: 3, isPositive: false, source: 'storefront' },
      ],
    })
    await recomputeCustomerRollups(customerId)
    const c = await prisma.customer.findUnique({ where: { id: customerId } })
    expect(c?.reviewCount).toBe(3)
    expect(c?.avgReviewRating).toBeCloseTo(4, 1)
  })

  test('lastVisitAt is the MAX of lastOrderAt and last seated reservation', async () => {
    // Set lastOrderAt to 7 days ago, a seated reservation 2 days ago.
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000)
    const twoDaysAgo   = new Date(Date.now() - 2 * 86_400_000)
    await prisma.customer.update({
      where: { id: customerId },
      data: { lastOrderAt: sevenDaysAgo },
    })
    await prisma.reservation.create({
      data: {
        conceptId, customerId, partySize: 2,
        startTime: twoDaysAgo, endTime: new Date(twoDaysAgo.getTime() + 90*60_000),
        guestName: 'X', source: 'staff', status: 'completed', seatedAt: twoDaysAgo,
      },
    })
    await recomputeCustomerRollups(customerId)
    const c = await prisma.customer.findUnique({ where: { id: customerId } })
    // The seated reservation is more recent → should win.
    expect(c?.lastVisitAt?.getTime()).toBe(twoDaysAgo.getTime())
  })

  test('idempotent: running twice gives the same result', async () => {
    await prisma.reservation.create({
      data: {
        conceptId, customerId, partySize: 2,
        startTime: new Date(), endTime: new Date(Date.now() + 90*60_000),
        guestName: 'idempotent', source: 'staff', status: 'no_show',
      },
    })
    await recomputeCustomerRollups(customerId)
    const a = await prisma.customer.findUnique({ where: { id: customerId } })
    await recomputeCustomerRollups(customerId)
    const b = await prisma.customer.findUnique({ where: { id: customerId } })
    expect(b?.noShowCount).toBe(a?.noShowCount)
  })
})
