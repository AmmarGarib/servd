import { NextRequest, NextResponse } from 'next/server'
import {
  hostBrand, BRAND_HOST_HEADER, SERVD_HOSTS, SERVD_ORIGIN, SERVD_LINK_ORIGIN, isBrandRewritePath,
} from './lib/brandDomains'
import { VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE } from './lib/abVariant'
import { isEditorFramePath } from './lib/editorFrame'
import { frameAncestors } from './lib/adminOrigins'
import { isCertainlyNotABrand, liveBrandSlugs } from './lib/crawlGate'

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
// Redirects done here: servd.pk/home → / (servd's home is its root, owner 2026-10-14); /<brand>/menu and /<brand>/order →
// /<brand> for any brand; on a brand domain,
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

/** The app's own top-level routes: /<one of these>/menu is not a brand's. */
const TOP_LEVEL_ROUTES = new Set([
  'about', 'account', 'api', 'auth', 'brand', 'contact', 'editor-frame', 'faq', 'group-order', 'home',
  'locations', 'login', 'orders', 'pages', 'press', 'preview', 'privacy', 'reserve', 'rider', 'signup',
  'terms', 'waitlist',
])

/** servd's own pages: on a brand's domain they live on servd.pk instead. */
const SERVD_ONLY_TOP = new Set(['home', 'locations', 'press', 'waitlist', 'faq', 'contact', 'privacy', 'terms'])

/** The slug of a brand ORDERING path — /<slug> or /reserve/<slug> (nothing
 *  deeper: checkout / order tracking have no slug gate) — else null. */
function orderingSlug(pathname: string): string | null {
  const reserve = /^\/reserve\/([^/]+)\/?$/.exec(pathname)
  if (reserve?.[1]) return reserve[1]
  const top = /^\/([^/]+)\/?$/.exec(pathname)
  if (!top?.[1] || TOP_LEVEL_ROUTES.has(top[1].toLowerCase())) return null
  return top[1]
}

/**
 * /<brand>/menu and /<brand>/order → /<brand>: the menu IS the ordering
 * screen, and those two were only ever hops to it. For EVERY brand — another
 * company's, or one added in admin tomorrow — not just the bundled three
 * (next.config.js sends those, and the legacy /stax ones, in the same single
 * hop, www included). An unknown slug lands on /<slug>, which 404s.
 */
function orderingHop(pathname: string): string | null {
  const m = /^\/([a-z0-9-]+)\/(?:menu|order)\/?$/i.exec(pathname)
  if (!m?.[1] || TOP_LEVEL_ROUTES.has(m[1].toLowerCase())) return null
  return `/${m[1]}`
}

/** A Host header without port, trailing dot or case: "stackd.pk". A
 *  bracketed IPv6 host keeps its brackets: "[::1]:3002" -> "[::1]". */
function bareHost(host: string): string {
  const h = host.trim()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 ? h.slice(0, end + 1).toLowerCase() : ''
  }
  return (h.split(':')[0] ?? '').toLowerCase().replace(/\.$/, '')
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
 * and how sure that is. servd's home is its root / (owner, 2026-10-14; /home
 * forwards there); on a brand
 * domain its own /brand/<slug>/… pages are the brand-domain paths. Permanent
 * (308) only when the host was positively placed. A host that is neither
 * servd's nor a known brand's — an unknown or not-yet-loaded custom domain, an
 * internal hostname — gets no home redirect at all: a 308 is cached by the
 * browser with no expiry and read by Google as a move, and a lookup failure
 * must never be able to do that to a brand domain's home page.
 */
function settle(pathname: string, slug: string | null, servd: boolean): { path: string; status: 307 | 308 } {
  const hop = orderingHop(pathname)
  if (hop) return { path: hop, status: 308 }
  if (slug) return { path: brandSelfPath(pathname, slug) ?? pathname, status: 308 }
  if (servd && pathname === '/home') return { path: '/', status: 308 }
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


/**
 * A URL that NO route matches. `[concept]` is a one-segment catch-all
 * (/__not-found alone would be a "brand" and 404 through its layout, bare), and
 * `[concept]/checkout`, `[concept]/order/[id]` are the deepest dynamic routes,
 * so five static-looking segments match nothing and Next draws the real
 * server-rendered 404 (root layout + app/not-found.tsx).
 */
const UNMATCHED_PATH = '/__not-found/a/b/c/d'

/**
 * A path that is certainly not a brand's ordering page → rewrite it onto a URL
 * no route matches, so Next draws the REAL server-rendered 404 (status 404,
 * root layout, <title>, app/not-found.tsx) instead of the bare
 * `__next_error__` shell it sends for a notFound() thrown in a page or layout
 * (see lib/crawlGate.ts). Fails open: unknown / API down → null.
 */
async function serverNotFound(req: NextRequest, slug: string | null, newVisitorId: string | null) {
  const target = orderingSlug(req.nextUrl.pathname)
  if (!target || !(await isCertainlyNotABrand(target))) return null
  const url = req.nextUrl.clone()
  url.pathname = UNMATCHED_PATH
  const headers = new Headers(req.headers)
  headers.delete(BRAND_HOST_HEADER)
  // On a brand's domain the 404 page links back to that brand.
  if (slug) headers.set(BRAND_HOST_HEADER, slug)
  withVisitorCookie(headers, newVisitorId)
  return setVisitorCookie(NextResponse.rewrite(url, { request: { headers } }), newVisitorId)
}

/** Hosts that are dev / preview stand-ins, never a brand's public domain. */
function isDevOrPreviewHost(bare: string): boolean {
  return /(^|\.)(localhost|servd\.app|servd\.pk)$/.test(bare) || bare === '127.0.0.1' || bare === '[::1]'
}

/**
 * On a brand's own domain, where does a servd-only path live? servd.pk's
 * /home, /locations, /press, /waitlist, /faq, /contact, /privacy, /terms, the
 * reservation index, and ANOTHER brand's ordering / reservation / microsite
 * pages are not part of this brand's site: each is one permanent hop to the
 * same path on servd.pk (so simmer.pk/stackd stops being a duplicate of
 * servd.pk/stackd). The brand's own ordering, checkout, tracker, /reserve/<own>,
 * login and account pages stay. null = stay. Needs a configured servd origin
 * (so local dev, where SERVD_LINK_ORIGIN is empty, never leaves the host).
 */
async function servdOnlyPath(pathname: string, own: string, bare: string): Promise<string | null> {
  if (!SERVD_LINK_ORIGIN || isDevOrPreviewHost(bare)) return null
  const parts = pathname.split('/').filter(Boolean)
  const first = (parts[0] ?? '').toLowerCase()
  if (!first) return null
  if (first === 'home') return '/' + parts.slice(1).join('/')
  if (SERVD_ONLY_TOP.has(first)) return pathname
  if (first === 'reserve' && parts.length === 1) return pathname
  const otherSlug = first === 'reserve' || first === 'brand' ? parts[1] : parts[0]
  if (!otherSlug || otherSlug === own) return null
  if (first !== 'reserve' && first !== 'brand' && TOP_LEVEL_ROUTES.has(first)) return null
  if (first === 'brand' && parts.length === 1) return null
  const live = await liveBrandSlugs()
  return live?.has(otherSlug) ? pathname : null
}

export async function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? ''

  const toApex = await apexRedirect(req, host)
  if (toApex) return toApex

  // The editor frame (Admin → Storefront's live page, src/editor/README.md).
  // Framable ONLY by the admin origins — CSP frame-ancestors from
  // ADMIN_ORIGINS, read at runtime; next.config.js leaves X-Frame-Options off
  // this one path. No visitor cookie (nothing here is a visit), no settle /
  // redirect, no brand rewrite, and any inbound copy of the brand-host header
  // is dropped. Served on the servd host only: on a brand domain it is a 404
  // that nobody may frame.
  // (Matched case-insensitively here because the header rules in
  // next.config.js are: /Editor-Frame is a 404 that must not be framable.)
  if (/^\/editor-frame\/?$/i.test(req.nextUrl.pathname)) {
    const bare = bareHost(host)
    const devHost = process.env.NODE_ENV !== 'production' && (bare === '127.0.0.1' || bare === '[::1]')
    if (!isEditorFramePath(req.nextUrl.pathname) || (!isServdHost(bare) && !devHost)) {
      const res = NextResponse.rewrite(new URL(UNMATCHED_PATH, req.url))
      res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
      res.headers.set('X-Frame-Options', 'DENY')
      return res
    }
    const headers = new Headers(req.headers)
    headers.delete(BRAND_HOST_HEADER)
    const res = NextResponse.next({ request: { headers } })
    res.headers.set('Content-Security-Policy', `frame-ancestors ${frameAncestors()}`)
    return res
  }

  // Share images and icons (/opengraph-image, /icon, /apple-icon, and the
  // per-brand ones under /brand/<slug>/) pass straight through: no visitor
  // cookie, so Cloudflare can cache them, and no rewrite or redirect.
  if (/(^|\/)(opengraph-image|icon|apple-icon)(\/|$)/.test(req.nextUrl.pathname)) return NextResponse.next()

  const newVisitorId = req.cookies.get(VISITOR_COOKIE)?.value ? null : crypto.randomUUID()

  const bare = bareHost(host)
  const slug = await hostBrand(bare)

  // Redirects to the canonical path: servd.pk/home → / (a real redirect
  // status, so search engines move the old address onto the root), and on a
  // brand domain /brand/<own-slug>[/…] → /, /menu, …
  const settled = settle(req.nextUrl.pathname, slug, isServdHost(bare))
  if (settled.path !== req.nextUrl.pathname) {
    const url = req.nextUrl.clone()
    url.pathname = settled.path
    return setVisitorCookie(NextResponse.redirect(url, settled.status), newVisitorId)
  }

  if (!slug) {
    return (await serverNotFound(req, null, newVisitorId))
      ?? setVisitorCookie(passThrough(req, newVisitorId), newVisitorId)
  }

  const { pathname } = req.nextUrl
  if (!isBrandRewritePath(pathname)) {
    // servd-only paths (and the other brands') live on servd.pk — one
    // permanent hop. The host was positively placed (hostBrand), so 308.
    const away = await servdOnlyPath(pathname, slug, bare)
    if (away !== null) {
      return setVisitorCookie(NextResponse.redirect(`${SERVD_LINK_ORIGIN}${away}${req.nextUrl.search}`, 308), newVisitorId)
    }
    return (await serverNotFound(req, slug, newVisitorId))
      ?? setVisitorCookie(passThrough(req, newVisitorId), newVisitorId)
  }

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
