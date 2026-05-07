import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
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
