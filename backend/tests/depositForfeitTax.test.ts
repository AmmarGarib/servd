// A kept no-show deposit is taxable (owner + accountant H10, wave B).
//
// 'reservation.deposit_capture:<reservationId>' (same sourceType, claim and
// re-poster as before) now books, in the reservation's brand's company, every
// line tagged with the brand:
//   Dr 1030 D / Cr revenueCodeForConcept(slug) D − T / Cr outputTaxCodeFor(brand) T
//   T = round(D × taxRateCard / (100 + taxRateCard))   — the tax is inside
// No fiscal document is created. A second capture is a no-op; a release after
// the capture is 409; company B cannot mark A's booking a no-show (404).
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { reservationRoutes } from '../src/modules/reservations/routes.js'
import { captureReservationDeposit } from '../src/modules/reservations/depositCapture.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let tenantA: string, tenantB: string
let sindhBrand: string, punjabBrand: string, brandB: string
const tokens: Record<string, string> = {}
const userIds: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${key} person`, email: `${key}.${RUN}@deposit.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
  userIds[key] = u.id
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: tokens[who]! }, ...(payload !== undefined && { payload: payload as object }) })

const booking = (conceptId: string, depositCents: number) => prisma.reservation.create({
  data: {
    conceptId, partySize: 2, guestName: 'Deposit Guest', source: 'staff', status: 'confirmed', depositCents, depositRef: 'KEENU-91',
    startTime: new Date(Date.now() - 3 * 3_600_000), endTime: new Date(Date.now() - 90 * 60_000),
  },
})

type Line = [code: string, type: string, amount: number, conceptId: string | null]
async function captureLines(tenantId: string, reservationId: string): Promise<Line[]> {
  const je = await prisma.journalEntry.findFirstOrThrow({
    where: { tenantId, reference: `reservation.deposit_capture:${reservationId}` },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je.lines.map((l): Line => [l.account.code, l.type, Number(l.amountCents), l.conceptId]).sort()
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (dep)', slug: `gs-dep-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (dep)', slug: `kb-dep-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  // Stackd (revenue 4002), a Sindh brand: SRB output 2032, card rate 8 %.
  sindhBrand = (await prisma.concept.create({ data: { name: 'Stackd', slug: 'stackd', type: 'restaurant', tenantId: tenantA, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id
  // A Punjab brand (PRA output 2031) at a 5 % card rate; its slug falls back to 4090.
  punjabBrand = (await prisma.concept.create({ data: { name: 'Lahore Grill', slug: `lahore-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'PB', taxRateCash: 16, taxRateCard: 5 } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Viva', slug: `viva-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('mgrA', 'manager', tenantA)
  await mkUser('mgrB', 'manager', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('a kept no-show deposit is brand revenue with the tax inside', () => {
  it('8 % on 5,000: tax 370 to SRB 2032, revenue 4,630 to Stackd 4002, Dr 1030 5,000 — all tagged with the brand', async () => {
    const r = await booking(sindhBrand, 5_000)
    const res = await call('mgrA', 'POST', `/reservations/${r.id}/no-show`)
    expect(res.statusCode, res.body).toBe(200)
    expect(await captureLines(tenantA, r.id)).toEqual([
      ['1030', 'debit', 5_000, sindhBrand],
      ['2032', 'credit', 370, sindhBrand],
      ['4002', 'credit', 4_630, sindhBrand],
    ].sort())
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'no_show', depositCents: 0 })
    // No fiscal document: a kept deposit is not an order.
    expect(await prisma.fiscalDocument.count({ where: { tenantId: tenantA } })).toBe(0)
    // Nothing in B's books.
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: `reservation.deposit_capture:${r.id}` } })).toBe(0)

    // A second capture is a no-op; one entry.
    expect(await captureReservationDeposit({ reservationId: r.id, postedBy: 'system' })).toEqual({ captured: false, reason: 'no-deposit' })
    expect(await prisma.journalEntry.count({ where: { reference: `reservation.deposit_capture:${r.id}` } })).toBe(1)

    // A release after the capture: 409, nothing left to release.
    const rel = await call('mgrA', 'POST', `/reservations/${r.id}/deposit-release`)
    expect(rel.statusCode).toBe(409)
    expect(rel.json().error.code).toBe('NO_DEPOSIT_HELD')
  })

  it('a Punjab brand at its own 5 % card rate: PRA 2031, the fallback revenue account', async () => {
    const r = await booking(punjabBrand, 10_000)
    const out = await captureReservationDeposit({ reservationId: r.id, postedBy: userIds['mgrA']! })
    expect(out).toEqual({ captured: true, amountCents: 10_000, reservationId: r.id })
    // T = round(10,000 × 5 / 105) = 476
    expect(await captureLines(tenantA, r.id)).toEqual([
      ['1030', 'debit', 10_000, punjabBrand],
      ['2031', 'credit', 476, punjabBrand],
      ['4090', 'credit', 9_524, punjabBrand],
    ].sort())
  })

  it('company B cannot mark A\'s booking a no-show (404): the deposit stays held, nothing is posted', async () => {
    const r = await booking(sindhBrand, 5_000)
    expect((await call('mgrB', 'POST', `/reservations/${r.id}/no-show`)).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', `/reservations/${r.id}/deposit-release`)).statusCode).toBe(404)
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'confirmed', depositCents: 5_000 })
    expect(await prisma.journalEntry.count({ where: { reference: `reservation.deposit_capture:${r.id}` } })).toBe(0)

    // B's own booking is captured in B's books.
    const rb = await booking(brandB, 5_000)
    expect((await call('mgrB', 'POST', `/reservations/${rb.id}/no-show`)).statusCode).toBe(200)
    expect(await captureLines(tenantB, rb.id)).toEqual([
      ['1030', 'debit', 5_000, brandB],
      ['2032', 'credit', 370, brandB],
      ['4090', 'credit', 4_630, brandB],
    ].sort())
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `reservation.deposit_capture:${rb.id}` } })).toBe(0)
  })
})
