import { NextRequest, NextResponse } from 'next/server'
import { resolveBrandSlug, BRAND_HOST_HEADER } from './lib/brandDomains'

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

// Paths that, on a brand host, get rewritten under /brand/<slug>. Everything
// else (cart pages /[concept]/*, /api, /account, /checkout, etc.) passes
// through untouched so the existing app routing keeps working.
const BRAND_REWRITE_PATHS = new Set(['/', '/menu', '/about', '/visit'])

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? ''
  const slug = resolveBrandSlug(host)
  if (!slug) return NextResponse.next()

  const { pathname } = req.nextUrl
  if (!BRAND_REWRITE_PATHS.has(pathname)) return NextResponse.next()

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
  return NextResponse.rewrite(url, { request: { headers } })
}

export const config = {
  matcher: ['/((?!_next|api|favicon|.*\\..*).*)'],
}
