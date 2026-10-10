import { NextRequest, NextResponse } from 'next/server'
import {
  hostBrand, BRAND_HOST_HEADER, SERVD_HOSTS, SERVD_ORIGIN, isBrandRewritePath,
} from './lib/brandDomains'
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
//   2. Add the domain in admin → Configuration → Domains and make it Live
//      (the Domain table is the one list — lib/brandDomains.ts reads it), and
//      its canonical origin in BRAND_ORIGIN there.
//   3. Add the domain in the hosting provider / tunnel so SSL is issued.
//
// Redirects done here: servd.pk/ → /home; on a brand domain,
// /brand/<own-slug>[/menu|…] → the brand-domain path (/, /menu, …); and
// www.<domain>/brand/… → <domain>, settled the same way. All 308 (permanent),
// but only for a host positively placed — servd's own, or a brand by the
// Domain list or its BRAND_ORIGIN domain. A host that could not be placed gets
// a 307 at most, so a failed lookup never mints a redirect browsers cache
// forever. Every other www request and the legacy paths are redirected in
// next.config.js, which runs before this.
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

/**
 * On a brand's own domain, /brand/<its-slug>[/menu|/about|/visit|/pages/<p>]
 * is a second copy of a page the domain already serves at /, /menu, … — the
 * canonical URLs. Returns that brand-domain path, or null for any other path.
 * Only the microsite pages: the printable /brand/<slug>/qr card and the image
 * routes (/brand/<slug>/opengraph-image, /brand/<slug>/icon) pass through.
 */
function brandSelfPath(pathname: string, slug: string): string | null {
  const base = `/brand/${slug}`
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null
  const tail = pathname.slice(base.length) || '/'
  return isBrandRewritePath(tail) ? tail : null
}

/** A Host header without port, trailing dot or case: "stackd.pk". */
function bareHost(host: string): string {
  return (host.split(':')[0] ?? '').trim().toLowerCase().replace(/\.$/, '')
}

function hostnameOf(origin: string): string {
  try { return new URL(origin).hostname } catch { return '' }
}

const SERVD_HOSTNAME = hostnameOf(SERVD_ORIGIN)

/** True only for a host that is positively servd: its canonical domain (and
 *  plain localhost in dev). */
function isServdHost(bare: string): boolean {
  return SERVD_HOSTS.has(bare) || bare === SERVD_HOSTNAME
}

// hostBrand(host) — which brand a host belongs to — lives in lib/brandDomains
// (shared with sitemap.ts, robots.ts and llms.txt).

/**
 * Where a page path settles for a host, so every redirect lands in ONE hop,
 * and how sure that is. servd's / is /home (owner, 2026-10-07); on a brand
 * domain its own /brand/<slug>/… pages are the brand-domain paths. Permanent
 * (308) only when the host was positively placed. A host that is neither
 * servd's nor a known brand's — an unknown or not-yet-loaded custom domain, an
 * internal hostname — still has / sent to /home, but as a 307: a 308 is cached
 * by the browser with no expiry and read by Google as a move, and a lookup
 * failure must never be able to do that to a brand domain's home page.
 */
function settle(pathname: string, slug: string | null, servd: boolean): { path: string; status: 307 | 308 } {
  if (slug) return { path: brandSelfPath(pathname, slug) ?? pathname, status: 308 }
  if (pathname === '/') return { path: '/home', status: servd ? 308 : 307 }
  return { path: pathname, status: 308 }
}

/**
 * www.<domain> → <domain>, same path and query, permanently. next.config.js
 * redirects every www request first (static files and legacy paths included,
 * in one hop) EXCEPT the /brand/… pages, whose final path depends on which
 * brand owns the domain — known only here — and www.*.localhost in dev. Those
 * arrive here and go straight to their settled page:
 * www.stackd.pk/brand/stackd/menu → https://stackd.pk/menu.
 */
async function apexRedirect(req: NextRequest, host: string): Promise<NextResponse | null> {
  const m = /^www\.(.+)$/i.exec(host.trim())
  if (!m?.[1]) return null
  const apex = m[1]
  const { pathname, search } = req.nextUrl
  const bare = bareHost(apex)
  const settled = settle(pathname, await hostBrand(bare), isServdHost(bare))
  // The www → apex hop is always right, so it is permanent; a path change only
  // rides along when that is permanent too.
  const path = settled.status === 308 ? settled.path : pathname
  // Every public servd and brand domain is https-only, so go straight there
  // rather than via http and Cloudflare's own upgrade hop. Local dev
  // (www.<x>.localhost) keeps the request's own scheme.
  const local = /(^|\.)localhost(:\d+)?$/i.test(apex)
  const https = req.headers.get('x-forwarded-proto')?.includes('https') || req.nextUrl.protocol === 'https:' || !local
  return NextResponse.redirect(`${https ? 'https' : 'http'}://${apex}${path}${search}`, 308)
}

export async function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? ''

  const toApex = await apexRedirect(req, host)
  if (toApex) return toApex

  // Share images and icons (/opengraph-image, /icon, /apple-icon, and the
  // per-brand ones under /brand/<slug>/) pass straight through: no visitor
  // cookie, so Cloudflare can cache them, and no rewrite or redirect.
  if (/(^|\/)(opengraph-image|icon|apple-icon)(\/|$)/.test(req.nextUrl.pathname)) return NextResponse.next()

  const newVisitorId = req.cookies.get(VISITOR_COOKIE)?.value ? null : crypto.randomUUID()

  const bare = bareHost(host)
  const slug = await hostBrand(bare)

  // Redirects to the canonical path: servd.pk/ → /home (done here, not in
  // app/page.tsx, so it is a real redirect status rather than a render-time
  // hop), and on a brand domain /brand/<own-slug>[/…] → /, /menu, …
  const settled = settle(req.nextUrl.pathname, slug, isServdHost(bare))
  if (settled.path !== req.nextUrl.pathname) {
    const url = req.nextUrl.clone()
    url.pathname = settled.path
    return setVisitorCookie(NextResponse.redirect(url, settled.status), newVisitorId)
  }

  if (!slug) return setVisitorCookie(passThrough(req, newVisitorId), newVisitorId)

  const { pathname } = req.nextUrl
  if (!isBrandRewritePath(pathname)) return setVisitorCookie(passThrough(req, newVisitorId), newVisitorId)

  const url = req.nextUrl.clone()
  url.pathname = pathname === '/' ? `/brand/${slug}` : `/brand/${slug}${pathname}`
  // Tell the render which brand microsite this is.
  //
  // A rewrite changes the path the app renders but NOT the path the browser
  // shows, and usePathname() reports the browser's. So on flipd.pk the servd
  // header's own "hide on /brand/" rule saw "/" and rendered anyway — the page
  // came out with two stacked headers, the servd disc and wordmark sitting on
  // top of the brand's. Only the server knows a rewrite happened, so it has to
  // say so. Set on the REWRITE branch only: /home and /login on a brand host
  // are ordinary servd pages and still want the servd header.
  const headers = new Headers(req.headers)
  headers.set(BRAND_HOST_HEADER, slug)
  withVisitorCookie(headers, newVisitorId)
  return setVisitorCookie(NextResponse.rewrite(url, { request: { headers } }), newVisitorId)
}

export const config = {
  // Every page path (no dot). Static files and the host-aware text files
  // (robots.txt, sitemap.xml, llms.txt) never reach the middleware; their www
  // hop is in next.config.js.
  matcher: ['/((?!_next|api|favicon|.*\\..*).*)'],
}
