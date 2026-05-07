import { NextRequest, NextResponse } from 'next/server'
import { resolveBrandSlug } from './lib/brandDomains'

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
//   * Visit http://stax.localhost:3002, http://flipd.localhost:3002, etc.
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
  return NextResponse.rewrite(url)
}

export const config = {
  matcher: ['/((?!_next|api|favicon|.*\\..*).*)'],
}
