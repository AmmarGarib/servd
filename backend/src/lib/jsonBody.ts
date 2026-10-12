// A request that says `Content-Type: application/json` but carries no body.
//
// The admin's API client sends that header on every call, including DELETEs
// and body-less POSTs. Fastify 5's JSON parser refuses an empty body with
// 400 FST_ERR_CTP_EMPTY_JSON_BODY, so every Delete button in the admin failed
// before reaching its route (Storefront's Discard draft, Delete page, Library
// delete and the clean-up after a failed upload among them).
//
// Fastify itself treats a request with NO content type and no body as
// body-less and runs the handler with `req.body === undefined`. This hook
// makes "JSON content type + provably empty body" mean the same thing by
// dropping the content type before parsing. Everything else is untouched: a
// non-empty body still goes through the JSON parser (malformed → 400,
// proto-poisoning protection, the body size limit → 413).
//
// Why a hook and not a replacement JSON parser on the root instance: the
// webhook plugins (modules/webhooks, modules/connectors/webhookRoutes) add
// their own raw-string 'application/json' parsers in their encapsulated
// contexts. Fastify only lets a child do that while the inherited parser is
// its built-in default — a custom root parser makes those registrations throw
// FST_ERR_CTP_ALREADY_PRESENT and the API would not boot.

import type { FastifyInstance } from 'fastify'
import type { IncomingHttpHeaders } from 'node:http'

/** True when the headers declare a JSON body that is provably empty: no
 *  Transfer-Encoding and a Content-Length that is absent or 0 (the same test
 *  Fastify uses to decide a request has no body). */
export function isEmptyJsonRequest(headers: IncomingHttpHeaders): boolean {
  const ct = headers['content-type']
  if (typeof ct !== 'string') return false
  const mediaType = ct.split(';')[0]!.trim().toLowerCase()
  if (mediaType !== 'application/json') return false
  if (headers['transfer-encoding'] !== undefined) return false
  const len = headers['content-length']
  return len === undefined || len === '0'
}

/** Register on the ROOT instance, before any route, so every route inherits it. */
export function registerEmptyJsonBody(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (req, _reply, done) => {
    if (isEmptyJsonRequest(req.raw.headers)) delete req.raw.headers['content-type']
    done()
  })
}
