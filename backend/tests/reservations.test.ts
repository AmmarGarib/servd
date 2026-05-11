// Reservation invariant tests.
//
// What this guards:
//   1. The DB-level exclusion constraint physically prevents two
//      reservations from claiming the same table at overlapping times,
//      even when both inserts happen concurrently (no app-layer check
//      can win that race; the DB has the final word).
//   2. Adjacent reservations (touching but not overlapping) DO succeed —
//      the range type uses '[)' bounds so endTime == startTime is allowed.
//   3. Cancelled / no_show / completed reservations release their slot —
//      another booking can grab the same time once the predecessor is
//      moved out of the active status set.
//   4. Waitlist reservations (no tableId) are exempt from the constraint
//      (host hand-places them).
//
// Requires a test database. Run with:
//   DATABASE_URL=postgresql://...test... npm test

import { beforeEach, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = (globalThis as { __TEST_PRISMA__?: PrismaClient }).__TEST_PRISMA__ ?? new PrismaClient()

describe('reservations: race-proof booking', () => {
  let conceptId: string
  let tableId: string

  beforeEach(async () => {
    await prisma.reservation.deleteMany({})
    await prisma.table.deleteMany({})
    await prisma.concept.deleteMany({})

    const concept = await prisma.concept.create({
      data: {
        name: 'Test Bistro',
        slug: `test-bistro-${Date.now()}`,
        type: 'restaurant',
      },
    })
    conceptId = concept.id

    const table = await prisma.table.create({
      data: { conceptId, label: 'T1', capacity: 4 },
    })
    tableId = table.id
  })

  test('exclusion constraint rejects overlapping inserts on the same table', async () => {
    const start = new Date('2026-08-01T19:00:00')
    const end   = new Date('2026-08-01T20:30:00')

    // First booking — succeeds.
    await prisma.reservation.create({
      data: {
        conceptId, tableId,
        partySize: 2, startTime: start, endTime: end,
        guestName: 'First', source: 'staff',
      },
    })

    // Second booking — fully overlapping, MUST fail.
    await expect(
      prisma.reservation.create({
        data: {
          conceptId, tableId,
          partySize: 2, startTime: start, endTime: end,
          guestName: 'Second', source: 'staff',
        },
      }),
    ).rejects.toMatchObject({
      // Prisma surfaces sqlstate 23P01 as P2010 with meta.code='23P01'
      code: 'P2010',
    })
  })

  test('exclusion constraint rejects partial overlap', async () => {
    await prisma.reservation.create({
      data: {
        conceptId, tableId,
        partySize: 2,
        startTime: new Date('2026-08-01T19:00:00'),
        endTime:   new Date('2026-08-01T20:30:00'),
        guestName: 'First', source: 'staff',
      },
    })
    // Starts during first, extends past — overlaps.
    await expect(
      prisma.reservation.create({
        data: {
          conceptId, tableId,
          partySize: 2,
          startTime: new Date('2026-08-01T20:00:00'),
          endTime:   new Date('2026-08-01T21:30:00'),
          guestName: 'Overlap', source: 'staff',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2010' })
  })

  test('adjacent (touching) reservations succeed — endTime == nextStartTime is OK', async () => {
    await prisma.reservation.create({
      data: {
        conceptId, tableId,
        partySize: 2,
        startTime: new Date('2026-08-01T19:00:00'),
        endTime:   new Date('2026-08-01T20:30:00'),
        guestName: 'Early', source: 'staff',
      },
    })
    // Starts exactly when first ends — '[)' bounds make this fine.
    await expect(
      prisma.reservation.create({
        data: {
          conceptId, tableId,
          partySize: 2,
          startTime: new Date('2026-08-01T20:30:00'),
          endTime:   new Date('2026-08-01T22:00:00'),
          guestName: 'Late', source: 'staff',
        },
      }),
    ).resolves.toMatchObject({ guestName: 'Late' })
  })

  test('cancelled reservation releases its slot', async () => {
    const start = new Date('2026-08-01T19:00:00')
    const end   = new Date('2026-08-01T20:30:00')

    const first = await prisma.reservation.create({
      data: {
        conceptId, tableId,
        partySize: 2, startTime: start, endTime: end,
        guestName: 'Original', source: 'staff',
      },
    })

    await prisma.reservation.update({
      where: { id: first.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    })

    // Same slot, fresh booking — now allowed.
    await expect(
      prisma.reservation.create({
        data: {
          conceptId, tableId,
          partySize: 2, startTime: start, endTime: end,
          guestName: 'Replacement', source: 'staff',
        },
      }),
    ).resolves.toMatchObject({ guestName: 'Replacement' })
  })

  test('no_show reservation releases its slot', async () => {
    const start = new Date('2026-08-01T19:00:00')
    const end   = new Date('2026-08-01T20:30:00')

    const first = await prisma.reservation.create({
      data: {
        conceptId, tableId,
        partySize: 2, startTime: start, endTime: end,
        guestName: 'Ghost', source: 'staff',
      },
    })
    await prisma.reservation.update({
      where: { id: first.id },
      data: { status: 'no_show' },
    })

    await expect(
      prisma.reservation.create({
        data: {
          conceptId, tableId,
          partySize: 2, startTime: start, endTime: end,
          guestName: 'Replacement', source: 'staff',
        },
      }),
    ).resolves.toMatchObject({ guestName: 'Replacement' })
  })

  test('reservations on different tables can fully overlap', async () => {
    const otherTable = await prisma.table.create({
      data: { conceptId, label: 'T2', capacity: 4 },
    })
    const start = new Date('2026-08-01T19:00:00')
    const end   = new Date('2026-08-01T20:30:00')

    await prisma.reservation.create({
      data: {
        conceptId, tableId,
        partySize: 2, startTime: start, endTime: end,
        guestName: 'Table 1', source: 'staff',
      },
    })
    await expect(
      prisma.reservation.create({
        data: {
          conceptId, tableId: otherTable.id,
          partySize: 2, startTime: start, endTime: end,
          guestName: 'Table 2', source: 'staff',
        },
      }),
    ).resolves.toMatchObject({ guestName: 'Table 2' })
  })

  test('waitlist reservations (no tableId) are exempt from the constraint', async () => {
    const start = new Date('2026-08-01T19:00:00')
    const end   = new Date('2026-08-01T20:30:00')

    // Two waitlist rows for the same time — DB allows both because tableId IS NULL
    await prisma.reservation.create({
      data: {
        conceptId,
        partySize: 2, startTime: start, endTime: end,
        guestName: 'Waitlist 1', source: 'walkin', waitlist: true,
      },
    })
    await expect(
      prisma.reservation.create({
        data: {
          conceptId,
          partySize: 4, startTime: start, endTime: end,
          guestName: 'Waitlist 2', source: 'walkin', waitlist: true,
        },
      }),
    ).resolves.toMatchObject({ guestName: 'Waitlist 2' })
  })

  test('concurrent inserts: only one wins under simulated race', async () => {
    const start = new Date('2026-08-01T19:00:00')
    const end   = new Date('2026-08-01T20:30:00')

    // Fire two creates without awaiting between them. The DB must serialize.
    const results = await Promise.allSettled([
      prisma.reservation.create({
        data: {
          conceptId, tableId,
          partySize: 2, startTime: start, endTime: end,
          guestName: 'A', source: 'staff',
        },
      }),
      prisma.reservation.create({
        data: {
          conceptId, tableId,
          partySize: 2, startTime: start, endTime: end,
          guestName: 'B', source: 'staff',
        },
      }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected  = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })
})
