// Who a campaign reaches.
//
// Opt-out, not opt-in: nothing in the system ever set marketingOptIn, so under
// the old rule every campaign reached nobody. Now everyone we can contact is
// reachable unless they unsubscribed — and the unsubscribe must actually work,
// or people report the messages as spam instead.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { reachableCustomer, brandAudience } from '../src/lib/marketingAudience.js'
import { trackingRoutes } from '../src/modules/tracking/routes.js'

let tenantId: string, brandA: string, brandB: string
const ids: Record<string, string> = {}
let app: FastifyInstance

async function cust(key: string, data: Record<string, unknown>) {
  const c = await prisma.customer.create({ data: { name: key, email: `${key}@aud.test`, ...data }, select: { id: true } })
  ids[key] = c.id
}

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'Audience Co', slug: 'audience-co' } })).id
  brandA = (await prisma.concept.create({ data: { name: 'A', slug: 'aud-a', tenantId, type: 'restaurant' } as never })).id
  brandB = (await prisma.concept.create({ data: { name: 'B', slug: 'aud-b', tenantId, type: 'restaurant' } as never })).id
  await cust('never_opted_in', {})                       // the old rule excluded this person
  await cust('unsubscribed', { marketingOptOutAt: new Date() })
  await cust('banned', { bannedAt: new Date() })
  await cust('prefers_a', { preferredConceptId: brandA })
  await cust('prefers_b', { preferredConceptId: brandB })
  app = Fastify()
  await app.register(trackingRoutes, { prefix: '/api/v1/t' })
  await app.ready()
})

afterAll(async () => {
  await prisma.campaignSend.deleteMany({ where: { customerId: { in: Object.values(ids) } } })
  await prisma.campaign.deleteMany({ where: { name: 'aud-test' } })
  await prisma.customer.deleteMany({ where: { id: { in: Object.values(ids) } } })
  if (brandA) await prisma.concept.deleteMany({ where: { id: { in: [brandA, brandB].filter(Boolean) } } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await app.close()
})

const reach = async (conceptIds: string[] = []) => {
  const rows = await prisma.customer.findMany({
    where: { AND: [reachableCustomer, brandAudience(conceptIds), { id: { in: Object.values(ids) } }] },
    select: { name: true },
  })
  return rows.map((r) => r.name).sort()
}

describe('campaign audience', () => {
  it('reaches everyone who has not unsubscribed, including those who never opted in', async () => {
    expect(await reach()).toEqual(['never_opted_in', 'prefers_a', 'prefers_b'])
  })

  it('never reaches the unsubscribed or the banned', async () => {
    const r = await reach()
    expect(r).not.toContain('unsubscribed')
    expect(r).not.toContain('banned')
  })

  it('narrows to a brand when asked', async () => {
    expect(await reach([brandA])).toEqual(['prefers_a'])
    expect(await reach([brandA, brandB])).toEqual(['prefers_a', 'prefers_b'])
  })
})

describe('unsubscribe', () => {
  it('a GET only shows the page — link scanners must not unsubscribe anyone', async () => {
    const camp = await prisma.campaign.create({ data: { name: 'aud-test', channel: 'email', body: 'x' } })
    const send = await prisma.campaignSend.create({ data: { campaignId: camp.id, customerId: ids['prefers_a']! } })
    const g = await app.inject({ method: 'GET', url: `/api/v1/t/u/${send.id}` })
    expect(g.statusCode).toBe(200)
    expect(g.body).toContain('<form method="POST"')
    const after = await prisma.customer.findUnique({ where: { id: ids['prefers_a']! } })
    expect(after!.marketingOptOutAt).toBeNull()
  })

  it('the POST takes them out of every future audience', async () => {
    const camp = await prisma.campaign.create({ data: { name: 'aud-test', channel: 'email', body: 'x' } })
    const send = await prisma.campaignSend.create({ data: { campaignId: camp.id, customerId: ids['prefers_b']! } })
    const p = await app.inject({ method: 'POST', url: `/api/v1/t/u/${send.id}` })
    expect(p.statusCode).toBe(200)
    expect(await reach()).not.toContain('prefers_b')
  })

  it('answers the same for an unknown id', async () => {
    const p = await app.inject({ method: 'POST', url: '/api/v1/t/u/00000000-0000-0000-0000-000000000000' })
    expect(p.statusCode).toBe(200)
  })
})
