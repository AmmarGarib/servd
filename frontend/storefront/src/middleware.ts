import { NextRequest, NextResponse } from 'next/server'
import { resolveBrandSlug, BRAND_HOST_HEADER, BRAND_REWRITE_PATHS } from './lib/brandDomains'
import { parseDayPart, type DayPart } from './lib/world/clock'

// Host-based brand routing.
//
// Each GS Foods brand owns a custom domain (eatstax.com, eatflipd.com, …) so
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
//   * The wildcard rule auto-resolves any <slug>.localhost / <slug>.servd.app
//     hostname without a code change.

// Paths that, on a brand host, get rewritten under /brand/<slug>, live in
// lib/brandDomains.ts — the header needs the same list to decide, on every
// client-side navigation, whether the page it is on is a brand microsite.
// Everything else (cart pages /[concept]/*, /api, /account, /checkout, etc.)
// passes through untouched so the existing app routing keeps working.

// World clock override (?daypart=).
//
// `?daypart=night` pins the whole site to one day-part for this browser
// session — for previews, screenshots and demos — and `?daypart=live` hands it
// back to the Karachi clock. The root layout reads the forwarded request
// header on this very request (the cookie only arrives on the next one), and
// the session cookie on every request after. Unknown values are ignored.
const DAYPART_PARAM = 'daypart'
const DAYPART_HEADER = 'x-servd-daypart'
const DAYPART_COOKIE = 'servd_daypart'

type DayPartIntent = DayPart | 'live' | null

function dayPartIntent(req: NextRequest): DayPartIntent {
  const raw = req.nextUrl.searchParams.get(DAYPART_PARAM)
  if (raw === null) return null
  if (raw.trim().toLowerCase() === 'live') return 'live'
  return parseDayPart(raw)
}

/**
 * The request headers to forward, or null when the inbound ones can pass
 * untouched.
 *
 * The brand-host and day-part headers are things the middleware TELLS the
 * app; they are not something a caller gets to assert. Without this, anyone
 * could send `x-servd-brand-host: flipd` to servd.pk and the app would believe
 * it and drop the servd header and footer. The damage is only cosmetic and
 * only on the sender's own screen — nothing security-relevant reads it — but
 * trusting a client-supplied header is the kind of thing that stops being
 * cosmetic later, when something else starts reading it.
 */
function forwardHeaders(req: NextRequest, brandSlug: string | null, dayPart: DayPartIntent): Headers | null {
  const dirty = req.headers.has(BRAND_HOST_HEADER) || req.headers.has(DAYPART_HEADER)
  if (!dirty && !brandSlug && !dayPart) return null
  const headers = new Headers(req.headers)
  headers.delete(BRAND_HOST_HEADER)
  headers.delete(DAYPART_HEADER)
  if (brandSlug) headers.set(BRAND_HOST_HEADER, brandSlug)
  if (dayPart) headers.set(DAYPART_HEADER, dayPart)
  return headers
}

/** Remember (or forget) the override for the rest of the browser session. */
function withDayPartCookie(res: NextResponse, dayPart: DayPartIntent): NextResponse {
  if (dayPart === 'live') res.cookies.delete(DAYPART_COOKIE)
  else if (dayPart) res.cookies.set(DAYPART_COOKIE, dayPart, { path: '/', sameSite: 'lax' })
  return res
}

/** Pass the request through, with our own headers scrubbed (and the day-part
 *  override forwarded, when there is one). */
function passThrough(req: NextRequest, dayPart: DayPartIntent) {
  const headers = forwardHeaders(req, null, dayPart)
  return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next()
}

export function middleware(req: NextRequest) {
  const dayPart = dayPartIntent(req)
  return withDayPartCookie(route(req, dayPart), dayPart)
}

function route(req: NextRequest, dayPart: DayPartIntent): NextResponse {
  const host = req.headers.get('host') ?? ''
  const slug = resolveBrandSlug(host)
  if (!slug) return passThrough(req, dayPart)

  const { pathname } = req.nextUrl
  if (!BRAND_REWRITE_PATHS.has(pathname)) return passThrough(req, dayPart)

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
  const headers = forwardHeaders(req, slug, dayPart) ?? new Headers(req.headers)
  return NextResponse.rewrite(url, { request: { headers } })
}

export const config = {
  matcher: ['/((?!_next|api|favicon|.*\\..*).*)'],
}
