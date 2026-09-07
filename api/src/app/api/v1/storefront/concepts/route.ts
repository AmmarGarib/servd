// GET /api/v1/storefront/concepts — first module ported off Fastify.
//
// Faithful port of backend/src/modules/storefront/routes.ts `/concepts`:
// active + storefront-visible concepts, optionally filtered to the ones
// whose delivery radius covers the caller's lat/lng. Concepts without a
// pin are global. deliveryRadiusKm is used server-side but not exposed.
//
// Public read-only endpoint — no auth, no tenant scoping — which is why
// it goes first. When DATABASE_URL isn't configured (bare preview
// deploys) it punts to the legacy API so the storefront never blanks.
import { prisma, hasDatabase } from '@/lib/prisma'
import { proxyToLegacy } from '@/lib/legacy'

export const dynamic = 'force-dynamic'

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export async function GET(req: Request) {
  if (!hasDatabase) return proxyToLegacy(req)

  const { searchParams } = new URL(req.url)
  const lat = searchParams.get('lat')
  const lng = searchParams.get('lng')

  const all = await prisma.concept.findMany({
    where: { isActive: true, storefrontVisible: true, deletedAt: null },
    select: {
      id: true, name: true, slug: true, type: true, description: true,
      logoUrl: true, primaryColor: true, heroTagline: true, announcementBanner: true,
      latitude: true, longitude: true, deliveryRadiusKm: true,
      reservationsEnabled: true,
      phone: true, whatsapp: true,
      address: true, addressLocality: true,
      cuisine: true, priceTier: true,
      serviceHours: {
        select: { dayOfWeek: true, openMin: true, closeMin: true },
        orderBy: [{ dayOfWeek: 'asc' }, { openMin: 'asc' }],
      },
    },
  })

  const userLat = lat ? parseFloat(lat) : null
  const userLng = lng ? parseFloat(lng) : null

  const filtered =
    userLat !== null && userLng !== null && !isNaN(userLat) && !isNaN(userLng)
      ? all.filter((c) => {
          if (c.latitude === null || c.longitude === null) return true // no pin = global
          const dist = haversineKm(userLat, userLng, c.latitude, c.longitude)
          return dist <= c.deliveryRadiusKm
        })
      : all

  return Response.json(
    filtered.map(({ deliveryRadiusKm: _r, ...rest }) => rest),
    { headers: { 'x-servd-gateway': 'ported' } },
  )
}
