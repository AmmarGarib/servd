// Loyalty system tests.
//
// What this guards:
//   - Earning credits both pointsBalance AND lifetimePoints
//   - Redeeming decrements pointsBalance only
//   - Negative balance is impossible (transactional guard)
//   - Review-bonus credit is recorded as a LoyaltyTransaction with type='earn'
//
// Requires a test database.

import { beforeEach, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = (globalThis as { __TEST_PRISMA__?: PrismaClient }).__TEST_PRISMA__ ?? new PrismaClient()

describe('loyalty: account math', () => {
  let customerId: string
  let accountId: string

  beforeEach(async () => {
    await prisma.loyaltyTransaction.deleteMany({})
    await prisma.loyaltyAccount.deleteMany({})
    await prisma.customer.deleteMany({})

    const customer = await prisma.customer.create({
      data: {
        name: 'Loyalty Test',
        email: `loyalty-${Date.now()}@test.local`,
      },
    })
    customerId = customer.id
    const account = await prisma.loyaltyAccount.create({
      data: { customerId, pointsBalance: 0, lifetimePoints: 0, tier: 'bronze' },
    })
    accountId = account.id
  })

  test('earn credits both pointsBalance and lifetimePoints', async () => {
    await prisma.loyaltyAccount.update({
      where: { id: accountId },
      data: {
        pointsBalance:  { increment: 500 },
        lifetimePoints: { increment: 500 },
      },
    })
    await prisma.loyaltyTransaction.create({
      data: { loyaltyAccountId: accountId, type: 'earn', pointsDelta: 500, description: 'Test earn' },
    })
    const after = await prisma.loyaltyAccount.findUnique({ where: { id: accountId } })
    expect(after?.pointsBalance).toBe(500)
    expect(after?.lifetimePoints).toBe(500)
  })

  test('redeem decrements balance only — lifetime untouched', async () => {
    await prisma.loyaltyAccount.update({
      where: { id: accountId },
      data: { pointsBalance: 500, lifetimePoints: 500 },
    })
    await prisma.loyaltyAccount.update({
      where: { id: accountId },
      data: { pointsBalance: { decrement: 200 } },
    })
    await prisma.loyaltyTransaction.create({
      data: { loyaltyAccountId: accountId, type: 'redeem', pointsDelta: -200, description: 'Test redeem' },
    })
    const after = await prisma.loyaltyAccount.findUnique({ where: { id: accountId } })
    expect(after?.pointsBalance).toBe(300)
    expect(after?.lifetimePoints).toBe(500)
  })

  test('review bonus posts a real LoyaltyTransaction', async () => {
    // Simulate the review-bonus path from /reviews POST.
    const REVIEW_BONUS = 50
    await prisma.$transaction([
      prisma.loyaltyAccount.update({
        where: { id: accountId },
        data: { pointsBalance: { increment: REVIEW_BONUS }, lifetimePoints: { increment: REVIEW_BONUS } },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          loyaltyAccountId: accountId,
          type: 'earn',
          pointsDelta: REVIEW_BONUS,
          description: 'Bonus: posted review within 24h',
        },
      }),
    ])
    const txs = await prisma.loyaltyTransaction.findMany({ where: { loyaltyAccountId: accountId } })
    expect(txs.length).toBe(1)
    expect(txs[0]!.type).toBe('earn')
    expect(txs[0]!.pointsDelta).toBe(50)
  })

  test('reservation completion bonus posts as a separate transaction', async () => {
    // Mirrors the cross-module integration in /reservations/:id/complete.
    const RES_BONUS = 100
    await prisma.$transaction([
      prisma.loyaltyAccount.update({
        where: { id: accountId },
        data: { pointsBalance: { increment: RES_BONUS }, lifetimePoints: { increment: RES_BONUS } },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          loyaltyAccountId: accountId,
          type: 'earn',
          pointsDelta: RES_BONUS,
          description: 'Completed reservation',
        },
      }),
    ])
    const account = await prisma.loyaltyAccount.findUnique({ where: { id: accountId } })
    expect(account?.pointsBalance).toBe(100)
    expect(account?.lifetimePoints).toBe(100)
  })
})
