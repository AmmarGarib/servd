// Checkout address lookup goes through servd's own server (owner 2026-10-16:
// "Keep address in our own server"): signed-in customers only, Pakistan only,
// coordinates rounded before leaving servd, no lookup on a practice copy.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { geoRoutes, addressLineOf } from '../src/modules/storefront/geoRoutes.js'

let app: FastifyInstance
let customerId: string
const RUN = Date.now().toString(36)
const token = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '1h' })
const get = (url: string, auth?: string) => app.inject({ method: 'GET', url, headers: auth ? { authorization: `Bearer ${auth}` } : {} })

beforeAll(async () => {
  customerId = (await prisma.customer.create({ data: { name: 'Geo', email: `geo.${RUN}@geo.test`, phone: `+92300${RUN.slice(-7).replace(/\D/g, '1').padStart(7, '1')}` } })).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(geoRoutes, { prefix: '/storefront' })
  await app.ready()
})
afterEach(() => { vi.unstubAllGlobals(); delete process.env['SERVD_SANDBOX'] })

describe('GET /storefront/geo/reverse', () => {
  it('refuses a signed-out caller', async () => {
    expect((await get('/storefront/geo/reverse?lat=24.86&lng=67.01')).statusCode).toBe(401)
  })
  it('never looks up a pin outside Pakistan', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const r = await get('/storefront/geo/reverse?lat=51.5&lng=-0.12', token(customerId))
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ line: null }); expect(f).not.toHaveBeenCalled()
  })
  it('asks the map service from the server, rounded, with no customer details', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ address: { road: 'Khayaban-e-Ittehad', suburb: 'DHA Phase 6', city: 'Karachi' } }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    const r = await get('/storefront/geo/reverse?lat=24.801234567&lng=67.051234567', token(customerId))
    expect(r.json()).toEqual({ line: 'Khayaban-e-Ittehad, DHA Phase 6, Karachi' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('lat=24.8012&lon=67.0512')
    expect(JSON.stringify(init.headers)).not.toMatch(/geo\.|Bearer|cookie/i)
  })
  it('makes no outbound call on a practice copy', async () => {
    process.env['SERVD_SANDBOX'] = '1'
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const r = await get('/storefront/geo/reverse?lat=24.9&lng=67.2', token(customerId))
    expect(r.json()).toEqual({ line: null }); expect(f).not.toHaveBeenCalled()
  })
  it('an outage answers null and is not cached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect((await get('/storefront/geo/reverse?lat=25.1&lng=67.3', token(customerId))).json()).toEqual({ line: null })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ display_name: 'Somewhere, Karachi' }), { status: 200 })))
    expect((await get('/storefront/geo/reverse?lat=25.1&lng=67.3', token(customerId))).json()).toEqual({ line: 'Somewhere, Karachi' })
  })
  it('builds a short line from the parts', () => {
    expect(addressLineOf({ address: { house_number: '12', road: 'Main St', city: 'Lahore' } })).toBe('12 Main St, Lahore')
  })
})
