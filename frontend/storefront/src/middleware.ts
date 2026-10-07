import { NextRequest, NextResponse } from 'next/server'
import { resolveBrandHost, BRAND_HOST_HEADER, BRAND_REWRITE_PATHS } from './lib/brandDomains'
import { VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE } from './lib/abVariant'

// Host-based brand routing.
//
// Each GS Foods brand owns a custom domain (stackd.pk, simmer.pk, flipd.pk) so
// the brand can build its own SEO authority and read as a real independent
// restaurant in an Instagram bio. The whole storefront is one Next.js app —
// this middleware reads the Host header and internally rewrites brand-host
// requests onto the existing /brand/<slug>/* routes.
//
// Adding a new custom domain in production:
//   1. Point DNS (A / CNAME) at the storefront host.
//   2. Add an entry to BRAND_DOMAIN_MAP in lib/brandDomains.ts.
//   3. Add the domain in the hosting provider (Vercel etc.) so SSL is issued.
//
// Local development:
//   * Browsers natively route *.localhost to 127.0.0.1 — no /etc/hosts edits.
//   * Visit http://stackd.localhost:3002, http://flipd.localhost:3002, etc.
//   * The wildcard rule auto-resolves any <slug>.localhost / <slug>.servd.pk
//     hostname without a code change.

// Paths that, on a brand host, get rewritten under /brand/<slug>, live in
// lib/brandDomains.ts — the header needs the same list to decide, on every
// client-side navigation, whether the page it is on is a brand microsite.
// Everything else (cart pages /[concept]/*, /api, /account, /checkout, etc.)
// passes through untouched so the existing app routing keeps working.

/**
 * Pass the request through, having removed any inbound copy of our own header.
 *
 * The brand-host header is something the middleware TELLS the app; it is not
 * something a caller gets to assert. Without this, anyone could send
 * `x-servd-brand-host: flipd` to servd.pk and the app would believe it and
 * drop the servd header and footer. The damage is only cosmetic and only on
 * the sender's own screen — nothing security-relevant reads it — but trusting
 * a client-supplied header is the kind of thing that stops being cosmetic
 * later, when something else starts reading it.
 */
function passThrough(req: NextRequest, newVisitorId: string | null) {
  if (!req.headers.has(BRAND_HOST_HEADER) && !newVisitorId) return NextResponse.next()
  const headers = new Headers(req.headers)
  headers.delete(BRAND_HOST_HEADER)
  withVisitorCookie(headers, newVisitorId)
  return NextResponse.next({ request: { headers } })
}

/**
 * Stable per-visitor id for storefront A/B tests (lib/abVariant.ts). Set once,
 * only when missing, for a year. On the request that mints it, the id is also
 * written into the forwarded Cookie header so the page rendering THIS request
 * already sees it and deals the same variant the next load will.
 */
function withVisitorCookie(headers: Headers, newVisitorId: string | null) {
  if (!newVisitorId) return
  const existing = headers.get('cookie')
  const pair = `${VISITOR_COOKIE}=${newVisitorId}`
  headers.set('cookie', existing ? `${existing}; ${pair}` : pair)
}

function setVisitorCookie(res: NextResponse, newVisitorId: string | null) {
  if (!newVisitorId) return res
  res.cookies.set(VISITOR_COOKIE, newVisitorId, {
    maxAge: VISITOR_COOKIE_MAX_AGE, path: '/', sameSite: 'lax', httpOnly: true,
  })
  return res
}

export async function middleware(req: NextRequest) {
  const newVisitorId = req.cookies.get(VISITOR_COOKIE)?.value ? null : crypto.randomUUID()

  const host = req.headers.get('host') ?? ''
  const slug = await resolveBrandHost(host)
  if (!slug) return setVisitorCookie(passThrough(req, newVisitorId), newVisitorId)

  const { pathname } = req.nextUrl
  if (!BRAND_REWRITE_PATHS.has(pathname)) return setVisitorCookie(passThrough(req, newVisitorId), newVisitorId)

  const url = req.nextUrl.clone()
  url.pathname = pathname === '/' ? `/brand/${slug}` : `/brand/${slug}${pathname}`
  // Tell the render which brand microsite this is.
  //
  // A rewrite changes the path the app renders but NOT the path the browser
  // shows, and usePathname() reports the browser's. So on flipd.pk the servd
  // header's own "hide on /brand/" rule saw "/" and rendered anyway — the page
  // came out with two stacked headers, the servd disc and wordmark sitting on
  // top of the brand's. Only the server knows a rewrite happened, so it has to
  // say so. Set on the REWRITE branch only: /browse and /login on a brand host
  // are ordinary servd pages and still want the servd header.
  const headers = new Headers(req.headers)
  headers.set(BRAND_HOST_HEADER, slug)
  withVisitorCookie(headers, newVisitorId)
  return setVisitorCookie(NextResponse.rewrite(url, { request: { headers } }), newVisitorId)
}

export const config = {
  matcher: ['/((?!_next|api|favicon|.*\\..*).*)'],
}
