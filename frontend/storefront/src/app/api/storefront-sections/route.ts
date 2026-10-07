// GET /api/storefront-sections — the section catalogue (every section's
// fields + defaults, and each page's default composition). The admin editor
// (Admin → Storefront) builds its palette and forms from this, so the
// storefront code that renders a section is also the one source of what it
// can edit. Public data: it is the same content the pages already show.

import { NextResponse } from 'next/server'
import { PAGE_DEFAULTS, SECTION_SPECS } from '../../../sections/catalog'

// The admin reads this cross-origin (admin.servd.pk → servd.pk).
const ADMIN_ORIGINS = new Set(
  (process.env['ADMIN_ORIGINS'] ?? 'https://admin.servd.pk,http://localhost:3002,http://localhost:3001,http://localhost:3000')
    .split(',').map((s) => s.trim()).filter(Boolean),
)

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  return ADMIN_ORIGINS.has(origin)
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
