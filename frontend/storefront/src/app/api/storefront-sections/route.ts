// GET /api/storefront-sections — the section catalogue (every section's
// fields + defaults, and each page's default composition). The admin editor
// (Admin → Storefront) builds its palette and forms from this, so the
// storefront code that renders a section is also the one source of what it
// can edit. Public data: it is the same content the pages already show.

import { NextResponse } from 'next/server'
import { PAGE_DEFAULTS, SECTION_SPECS } from '../../../sections/catalog'
import { adminOrigins } from '../../../lib/adminOrigins'

// The admin reads this cross-origin (admin.servd.pk → servd.pk). The allowed
// origins are ADMIN_ORIGINS (lib/adminOrigins.ts — the one definition, shared
// with the editor frame's CSP).
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  return adminOrigins().includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {}
}

export async function GET(req: Request) {
  return NextResponse.json(
    { specs: SECTION_SPECS, pages: PAGE_DEFAULTS },
    { headers: { ...cors(req), 'Cache-Control': 'no-store' } },
  )
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...cors(req), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' },
  })
}
