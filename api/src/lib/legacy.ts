// Manual pass-through to the legacy Fastify API.
//
// The next.config fallback rewrite already proxies every UNMATCHED path.
// This helper exists for routes that HAVE been ported but need to punt a
// specific request back to legacy (missing env in a preview deploy, a
// feature-flagged rollback, etc.). Same method, path, query, headers and
// body — the caller can't tell the difference.

const LEGACY = process.env.LEGACY_API_URL ?? 'https://servd-api.garibsons.app'

export async function proxyToLegacy(req: Request): Promise<Response> {
  const incoming = new URL(req.url)
  const target = `${LEGACY}${incoming.pathname}${incoming.search}`

  const headers = new Headers(req.headers)
  // Hop-by-hop / host-specific headers must not be forwarded verbatim.
  headers.delete('host')
  headers.delete('connection')
  headers.delete('content-length')

  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
    redirect: 'manual',
  })

  // Re-wrap so Next controls transfer-encoding; strip headers that would
  // conflict with the new response envelope.
  const out = new Headers(res.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  out.delete('transfer-encoding')
  out.set('x-servd-gateway', 'legacy-passthrough')
  return new Response(res.body, { status: res.status, headers: out })
}
