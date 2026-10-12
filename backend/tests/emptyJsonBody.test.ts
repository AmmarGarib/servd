// A request with `Content-Type: application/json` and no body is a body-less
// request, not 400 FST_ERR_CTP_EMPTY_JSON_BODY (lib/jsonBody.ts). The admin's
// API client sends that header on every DELETE, so before this every Delete
// button in the admin failed before reaching its route.
//
// Pure Fastify — no database needed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { isEmptyJsonRequest, registerEmptyJsonBody } from '../src/lib/jsonBody.js'

let app: FastifyInstance
const JSON_CT = { 'content-type': 'application/json' }

beforeAll(async () => {
  app = Fastify({ bodyLimit: 1024 })
  registerEmptyJsonBody(app)
  app.delete<{ Params: { id: string } }>('/things/:id', async (req, reply) => {
    if (req.params.id === 'missing') return reply.status(404).send({ error: { code: 'NOT_FOUND' } })
    return reply.status(204).send()
  })
  app.post('/echo', async (req) => ({ body: req.body ?? null }))
  // A plugin that brings its own raw-string JSON parser, like the webhook
  // routes do. It must still register (a custom ROOT parser would make this
  // throw FST_ERR_CTP_ALREADY_PRESENT) and still see the raw body.
  await app.register(async (child) => {
    child.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))
    child.post('/raw', async (req) => ({ raw: req.body ?? null }))
  }, { prefix: '/hook' })
  await app.ready()
})

afterAll(async () => { await app?.close() })

describe('empty JSON body', () => {
  it('DELETE with Content-Type: application/json and no body reaches the route (204)', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/things/abc', headers: JSON_CT })
    expect(r.statusCode).toBe(204)
  })

  it('…and the route still decides the answer (404)', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/things/missing', headers: JSON_CT })
    expect(r.statusCode).toBe(404)
    expect(r.json().error.code).toBe('NOT_FOUND')
  })

  it('Content-Length: 0 and a charset parameter are body-less too', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/things/abc', headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '0' } })
    expect(r.statusCode).toBe(204)
    const p = await app.inject({ method: 'POST', url: '/echo', headers: JSON_CT })
    expect(p.statusCode).toBe(200)
    expect(p.json()).toEqual({ body: null })
  })

  it('normal JSON is still parsed', async () => {
    const r = await app.inject({ method: 'POST', url: '/echo', headers: JSON_CT, payload: JSON.stringify({ a: 1, b: ['x'] }) })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ body: { a: 1, b: ['x'] } })
  })

  it('malformed JSON is still a 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/echo', headers: JSON_CT, payload: '{"a":' })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('FST_ERR_CTP_INVALID_JSON_BODY')
  })

  it('prototype poisoning is still rejected', async () => {
    const r = await app.inject({ method: 'POST', url: '/echo', headers: JSON_CT, payload: '{"__proto__":{"x":1}}' })
    expect(r.statusCode).toBe(400)
  })

  it('the body size limit still applies (413)', async () => {
    const r = await app.inject({ method: 'POST', url: '/echo', headers: JSON_CT, payload: JSON.stringify({ s: 'x'.repeat(4096) }) })
    expect(r.statusCode).toBe(413)
  })

  it('a plugin with its own JSON parser still registers and gets the raw body', async () => {
    const r = await app.inject({ method: 'POST', url: '/hook/raw', headers: JSON_CT, payload: '{"a":1}' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ raw: '{"a":1}' })
  })
})

describe('isEmptyJsonRequest', () => {
  it('only a JSON content type with a provably empty body', () => {
    expect(isEmptyJsonRequest({ 'content-type': 'application/json' })).toBe(true)
    expect(isEmptyJsonRequest({ 'content-type': 'Application/JSON; charset=utf-8', 'content-length': '0' })).toBe(true)
    expect(isEmptyJsonRequest({ 'content-type': 'application/json', 'content-length': '2' })).toBe(false)
    expect(isEmptyJsonRequest({ 'content-type': 'application/json', 'transfer-encoding': 'chunked' })).toBe(false)
    expect(isEmptyJsonRequest({ 'content-type': 'text/plain' })).toBe(false)
    expect(isEmptyJsonRequest({})).toBe(false)
  })
})
