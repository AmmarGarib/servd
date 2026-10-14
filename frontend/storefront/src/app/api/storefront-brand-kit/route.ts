// GET /api/storefront-brand-kit — the brand kit catalogue: the built-in fonts
// and, per bespoke brand, its palette (keys, brand-book labels, today's
// values), role defaults, font defaults, bundled images and a note; plus the
// `generic` defaults every other brand starts from. The admin's Brand kit
// editor (Admin → Storefront → Brand kit) builds its form from this, so the
// storefront code that paints a brand is also the one source of what a kit
// can set (lib/brandKit.ts). Public data: it is the look the pages already show.

import { NextResponse } from 'next/server'
import { kitCatalogueJson } from '../../../lib/brandKit'
import { adminOrigins } from '../../../lib/adminOrigins'

// The admin reads this cross-origin (admin.servd.pk → servd.pk). The allowed
// origins are ADMIN_ORIGINS (lib/adminOrigins.ts — the one definition).
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  return adminOrigins().includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {}
}

export async function GET(req: Request) {
  return NextResponse.json(kitCatalogueJson(), { headers: { ...cors(req), 'Cache-Control': 'no-store' } })
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...cors(req), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' },
  })
}
