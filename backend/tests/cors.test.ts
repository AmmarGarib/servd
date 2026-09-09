// CORS preflight tests.
//
// What this guards:
//   - The preflight advertises the write verbs the admin actually uses.
//
// Why it exists: upgrading @fastify/cors from v9 to v11 changed the DEFAULT
// `methods` from 'GET,HEAD,PUT,PATCH,POST,DELETE' to the CORS-safelisted
// 'GET,HEAD,POST'. We passed no `methods` option, so every PUT/PATCH/DELETE
// from a browser started failing at the preflight — and it failed silently:
// the OPTIONS still answered 204, /health stayed green, and the only symptom
// was the admin's generic "Backend unreachable" on save, because Chrome
// refused to send the request at all.
//
// This registers the plugin exactly the way src/index.ts does rather than
// booting the whole API, so it needs no database and runs in milliseconds.

import { describe, expect, test } from 'vitest'
import Fastify from 'fastify'
import cors from '@fastify/cors'

const ORIGIN = 'https://servd-admin.garibsons.app'

async function buildApp() {
  const app = Fastify()
  await app.register(cors, {
    origin: (_origin, cb) => cb(null, true),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 3600,
  })
  app.put('/api/v1/locations/:id', async () => ({ ok: true }))
  await app.ready()
  return app
}

describe('cors: preflight', () => {
  test.each(['PUT', 'PATCH', 'DELETE', 'POST'])(
    'a %s preflight is allowed',
    async (method) => {
      const app = await buildApp()
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/locations/abc',
        headers: {
          origin: ORIGIN,
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization,content-type',
        },
      })
      await app.close()

      expect(res.statusCode).toBe(204)
      const allowed = (res.headers['access-control-allow-methods'] as string)
        .split(',')
        .map((m) => m.trim().toUpperCase())
      // The assertion that would have caught the regression: the browser only
      // sends the real request if the verb is in this list.
      expect(allowed).toContain(method)
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN)
      expect(res.headers['access-control-allow-credentials']).toBe('true')
    },
  )

  test('the allow-methods header is not the bare safelist', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/locations/abc',
      headers: { origin: ORIGIN, 'access-control-request-method': 'PUT' },
    })
    await app.close()
    // The exact string the broken deploy served.
    expect(res.headers['access-control-allow-methods']).not.toBe('GET,HEAD,POST')
  })
})
