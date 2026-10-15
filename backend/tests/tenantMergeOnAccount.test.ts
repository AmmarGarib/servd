// Combining companies (POST /tenants/merge) — on-account clients.
//
//   - clients, their cards and their charges move to the target; a client
//     number the target already uses is renumbered after the target's highest
//     OA number (OA-NNNN); a card whose token hash the target already holds is
//     revoked and its hash retired;
//   - after the merge, a card scanned on the target company finds its client
//     there (the till's lookup: tenantId + sha256 of the normalised code);
//   - the same legal name in both companies → 422 ON_ACCOUNT_CLIENT_CLASH
//     listing the names, nothing moved.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { newCardCode, normalizeCardCode, hashCardCode } from '../src/lib/onAccountCard.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let seq = 0
let ceo: Who

interface Co { id: string; conceptId: string }
async function company(name: string): Promise<Co> {
  const id = (await prisma.tenant.create({ data: { name: `OA ${name}`, slug: `tmo-${++seq}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  await prisma.tenantMember.create({ data: { tenantId: id, userId: ceo.id } })
  const conceptId = (await prisma.concept.create({ data: { name: `OA ${name} ${seq}`, slug: `tmo-b-${seq}-${RUN}`, type: 'restaurant', tenantId: id } })).id
  return { id, conceptId }
}
const merge = (src: string, dst: string) =>
  app.inject({ method: 'POST', url: '/tenants/merge', headers: { authorization: `Bearer ${ceo.token}` }, payload: { sourceId: src, targetId: dst } })
const client = (tenantId: string, number: string, legalName: string) =>
  prisma.customerAccount.create({ data: { tenantId, number, legalName, creditLimitCents: 500_000, status: 'active', createdById: ceo.id } })
const card = (tenantId: string, accountId: string, hash: string, label = 'Reception') =>
  prisma.customerAccountCard.create({ data: { tenantId, accountId, label, tokenHash: hash, tokenHint: hash.slice(-4), issuedById: ceo.id } })
/** The till's lookup of a scanned code inside one company. */
const scan = (tenantId: string, code: string) =>
  prisma.customerAccountCard.findUnique({
    where: { tenantId_tokenHash: { tenantId, tokenHash: hashCardCode(normalizeCardCode(code)!) } },
    include: { account: true },
  })

beforeAll(async () => {
  ceo = await mkUser('tmo-ceo', 'admin', null)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('on-account clients, cards and charges move', () => {
  let S: Co, D: Co
  const ids: Record<string, string> = {}
  const code = newCardCode()
  const shared = newCardCode()

  beforeAll(async () => {
    S = await company('Source')
    D = await company('Target')
    // Target: OA-0001 and OA-0003.
    ids.dst1 = (await client(D.id, 'OA-0001', 'Target Client One')).id
    ids.dst3 = (await client(D.id, 'OA-0003', 'Target Client Three')).id
    // Source: OA-0001 (clashes) and OA-0002 (free).
    ids.src1 = (await client(S.id, 'OA-0001', 'Acme Offices (Pvt) Ltd')).id
    ids.src2 = (await client(S.id, 'OA-0002', 'Beta Traders')).id
    ids.card = (await card(S.id, ids.src1, code.hash)).id
    // The same code hash on both sides (practically impossible; tested anyway).
    ids.cardClash = (await card(S.id, ids.src2, shared.hash, 'Mr Khan')).id
    ids.cardDst = (await card(D.id, ids.dst1, shared.hash)).id
    ids.charge = (await prisma.customerAccountCharge.create({
      data: { tenantId: S.id, accountId: ids.src1, cardId: ids.card, orderId: randomUUID(), paymentId: randomUUID(), conceptId: S.conceptId, amountCents: 25_000, taxCents: 3_261, chargedById: ceo.id },
    })).id
  })

  it('merges, and reports what moved', async () => {
    const res = await merge(S.id, D.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      onAccountClientsMoved: 2, onAccountClientsRenumbered: 1,
      onAccountCardsMoved: 2, onAccountCardsRevoked: 1, onAccountChargesMoved: 1,
    })
  })

  it('clients are on the target; a clashing number continues after the target\'s highest', async () => {
    const rows = await prisma.customerAccount.findMany({ where: { tenantId: D.id }, orderBy: { number: 'asc' }, select: { id: true, number: true } })
    expect(rows).toEqual([
      { id: ids.dst1, number: 'OA-0001' },
      { id: ids.src2, number: 'OA-0002' },
      { id: ids.dst3, number: 'OA-0003' },
      { id: ids.src1, number: 'OA-0004' },
    ])
    expect(await prisma.customerAccount.count({ where: { tenantId: S.id } })).toBe(0)
  })

  it('cards and charges are on the target; the clashing card is revoked, the target\'s untouched', async () => {
    expect((await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: ids.card } })).tenantId).toBe(D.id)
    const revoked = await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: ids.cardClash } })
    expect(revoked.tenantId).toBe(D.id)
    expect(revoked.revokedAt).not.toBeNull()
    expect(revoked.tokenHash).not.toBe(shared.hash)
    const theirs = await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: ids.cardDst } })
    expect(theirs).toMatchObject({ tokenHash: shared.hash, revokedAt: null })
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: ids.charge } })).tenantId).toBe(D.id)
    expect(await prisma.customerAccountCard.count({ where: { tenantId: S.id } })).toBe(0)
    expect(await prisma.customerAccountCharge.count({ where: { tenantId: S.id } })).toBe(0)
  })

  it('a card scanned on the target company finds its client there', async () => {
    const hit = await scan(D.id, code.code)
    expect(hit?.id).toBe(ids.card)
    expect(hit?.revokedAt).toBeNull()
    expect(hit?.account).toMatchObject({ id: ids.src1, tenantId: D.id, status: 'active' })
    expect(await scan(S.id, code.code)).toBeNull()
    // The shared code still finds only the target's own card.
    expect((await scan(D.id, shared.code))?.id).toBe(ids.cardDst)
  })
})

describe('the same legal client in both companies', () => {
  it('→ 422 ON_ACCOUNT_CLIENT_CLASH listing the names; nothing moved', async () => {
    const S = await company('ClashSource')
    const D = await company('ClashTarget')
    const a = await client(S.id, 'OA-0001', 'Gamma Holdings')
    await client(S.id, 'OA-0002', 'Delta Partners')
    await client(D.id, 'OA-0001', 'Gamma Holdings')
    const c = await card(S.id, a.id, newCardCode().hash)
    const res = await merge(S.id, D.id)
    expect(res.statusCode).toBe(422)
    const err = res.json().error as { code: string; details: { legalNames: string[] } }
    expect(err.code).toBe('ON_ACCOUNT_CLIENT_CLASH')
    expect(err.details.legalNames).toEqual(['Gamma Holdings'])
    expect(await prisma.customerAccount.count({ where: { tenantId: S.id } })).toBe(2)
    expect((await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: c.id } })).tenantId).toBe(S.id)
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: S.id } })).deletedAt).toBeNull()
    expect(await prisma.concept.count({ where: { tenantId: S.id } })).toBe(1)
  })
})
