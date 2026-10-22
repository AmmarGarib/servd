import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// The old admin address. Its sign-in cookies belong to api.servd.pk, which is a
// DIFFERENT site from garibsons.app, so the browser never sends them back there:
// the session lived only in the open page's memory and every refresh / tab
// reload signed the person out (owner, 2026-10-16). Send everyone to the live
// address, same path and query. servd-admin.garibsons.app was a second old
// address still serving the live admin (owner, 2026-10-22: "whenever we
// refresh the tab or move to other tab for 5 minutes id gets signed out").
// The practice copy (servd-practice.garibsons.app) is its own app and must
// stay where it is.
const OLD_ADMIN_HOSTS = new Set(['admin.garibsons.app', 'servd-admin.garibsons.app'])
const LIVE_ADMIN_ORIGIN = 'https://admin.servd.pk'

export function middleware(request: NextRequest) {
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(':')[0]!.toLowerCase()
  if (OLD_ADMIN_HOSTS.has(host)) {
    const { pathname, search } = request.nextUrl
    return NextResponse.redirect(`${LIVE_ADMIN_ORIGIN}${pathname}${search}`, 308)
  }
  const response = NextResponse.next()
  // Persist NEXT_LOCALE cookie for 1 year if set
  const locale = request.cookies.get('NEXT_LOCALE')?.value
  if (locale && ['en', 'ur'].includes(locale)) {
    response.cookies.set('NEXT_LOCALE', locale, { maxAge: 31536000, path: '/' })
  }
  return response
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
}
