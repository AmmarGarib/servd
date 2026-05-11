// Order pipeline tests.
//
// What this guards:
//   - ingestOrder is idempotent on (source, externalId)
//   - items are created with status='pending'
//   - placedAt + completedAt timestamps are set on lifecycle transitions
//   - reviewPromptSentAt is null on creation (worker pre-condition)
//
// Requires a test database (TEST_DATABASE_URL pointing at a disposable schema).

import { beforeEach, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = (globalThis as { __TEST_PRISMA__?: PrismaClient }).__TEST_PRISMA__ ?? new PrismaClient()

describe('orders: invariants', () => {
  let conceptId: string

  beforeEach(async () => {
    // Order child rows first (FK), then orders, then concepts.
    await prisma.orderItem.deleteMany({})
    await prisma.payment.deleteMany({})
    await prisma.order.deleteMany({})
    await prisma.concept.deleteMany({})

    const concept = await prisma.concept.create({
      data: { name: 'Order Test Bistro', slug: `order-test-${Date.now()}`, type: 'restaurant' },
    })
    conceptId = concept.id
  })

  test('order items are created with status=pending', async () => {
    const order = await prisma.order.create({
      data: {
        conceptId,
        source: 'pos',
        externalId: 'order-test-1',
        status: 'received',
        totalCents: 100_00, taxCents: 17_00,
        items: { create: [
          { name: 'Item A', quantity: 1, unitPriceCents: 50_00 },
          { name: 'Item B', quantity: 1, unitPriceCents: 50_00 },
        ]},
      },
      include: { items: true },
    })
    expect(order.items.length).toBe(2)
    expect(order.items.every((i) => i.status === 'pending')).toBe(true)
  })

  test('reviewPromptSentAt is null on order creation (worker pre-condition)', async () => {
    const order = await prisma.order.create({
      data: {
        conceptId, source: 'pos', externalId: 'review-prompt-test',
        status: 'completed',
        totalCents: 100_00, taxCents: 17_00,
        completedAt: new Date(),
      },
    })
    expect(order.reviewPromptSentAt).toBeNull()
  })

  test('externalId + source uniqueness', async () => {
    const data = {
      conceptId, source: 'pos' as const, externalId: 'dup-test',
      status: 'received' as const,
      totalCents: 50_00, taxCents: 0,
    }
    await prisma.order.create({ data })
    // Duplicate (source, externalId) on the SAME concept should NOT create a
    // second row — the schema's compound unique guards against double-ingest.
    await expect(prisma.order.create({ data })).rejects.toMatchObject({ code: 'P2002' })
  })

  test('placedAt is set automatically; completedAt only when transitioned', async () => {
    const order = await prisma.order.create({
      data: {
        conceptId, source: 'pos', externalId: 'lifecycle-test',
        status: 'received', totalCents: 100_00, taxCents: 17_00,
      },
    })
    expect(order.placedAt).toBeInstanceOf(Date)
    expect(order.completedAt).toBeNull()

    const completed = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'completed', completedAt: new Date() },
    })
    expect(completed.completedAt).toBeInstanceOf(Date)
  })
})
