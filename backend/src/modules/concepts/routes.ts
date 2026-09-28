import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { resolveTenantScope, tenantWhere } from '../../lib/tenantScope.js'

// An uploaded artwork URL: either what the R2 presigner returns
// (https://media.../marketing/xyz.png) or, when R2_PUBLIC_URL is unset, the
// root-relative path it falls back to. Empty string clears the field.
const brandArtworkUrl = z
  .string()
  .max(2048)
  .refine(
    (v) => v === '' || /^https?:\/\//i.test(v) || v.startsWith('/'),
    { message: 'Must be an http(s) URL or a root-relative path' },
  )
  .optional()
  .nullable()
  .transform((v) => v || null)

const createConceptSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  type: z.enum(['restaurant', 'digital', 'cart']),
  description: z.string().optional(),
  logoUrl: z.string().url().optional().or(z.literal('')).transform(v => v || null),
  primaryColor: z.string().optional(),
  taxRate: z.number().min(0).max(100).default(17),
  // Split GST rates per tender (FBR rule): cash @ taxRateCash, card / digital
  // @ taxRateCard. The legacy taxRate above is still accepted for back-compat
  // but every new order uses the split.
  taxRateCash: z.number().min(0).max(100).default(15),
  taxRateCard: z.number().min(0).max(100).default(8),
  // Province: drives default sales-tax rate via the provincial revenue authority.
  // Operator picks the province on creation; we auto-fill taxRate from it.
  province:         z.enum(['PB', 'SD', 'KP', 'BL', 'ICT', 'GB', 'AJK']).nullable().optional(),
  // Storefront CMS
  storefrontVisible: z.boolean().optional(),
  heroTagline: z.string().max(120).optional().nullable(),
  // Brand microsite artwork. Null / '' means "use the asset bundled in the
  // storefront build", which is what every brand did before these existed.
  //
  // Deliberately NOT z.string().url() like logoUrl above: getSignedUploadUrl
  // builds its publicUrl as `${R2_PUBLIC_URL}/${key}`, so on any environment
  // where R2_PUBLIC_URL is unset it hands back a root-relative '/marketing/x.png'
  // — which .url() rejects, and the operator sees their upload fail on save
  // with no clue why. Accept an absolute http(s) URL or a root-relative path,
  // and reject anything else (notably javascript: and data:, which would
  // otherwise ride straight into an <img src> on the public storefront).
  wordmarkUrl: brandArtworkUrl,
  mascotUrl: brandArtworkUrl,
  // Per-brand reservations master toggle (false = brand isn't accepting bookings)
  reservationsEnabled: z.boolean().optional(),
  // Brand strategy brief — captured during onboarding
  conceptStatement:    z.string().max(280).nullable().optional(),
  cuisine:             z.string().max(60).nullable().optional(),
  heroProduct:         z.string().max(120).nullable().optional(),
  anchoringExperience: z.string().max(280).nullable().optional(),
  targetCustomer:      z.string().max(280).nullable().optional(),
  priceTier:           z.enum(['budget', 'mid', 'premium', 'luxury']).nullable().optional(),
  daypartFocus:        z.array(z.string()).default([]),
  competitors:         z.array(z.string().max(80)).max(10).default([]),
  differentiator:      z.string().max(280).nullable().optional(),
  brandVoice:          z.string().max(500).nullable().optional(),
})

// Full brand-edit schema — the ONE brand writer (admin → Storefront → Brands,
// /marketing/brands). Adds tax / FBR / SRB, contact and isActive on top of the
// base creation fields. Slug is omitted intentionally — slug changes break
// URLs + storefront SEO; expose it as a separate admin-only operation later.
//
// What is NOT here, on purpose:
//   • address / latitude / longitude — the physical kitchen's address and map
//     pin live on its Location (owner decision 18). Concept.address/latitude/
//     longitude are a read-only mirror of the brand's primary Location, kept
//     in step by the locations routes (syncConceptLocationMirror).
//   • deliveryRadiusKm — delivery coverage is the brand's DeliveryZone bands
//     (owner decision 19); the column is kept but no editor writes it.
// A request that still sends one of those gets a 422 naming where the field
// lives now, rather than a silent "saved" that changed nothing.
//
// The legacy single taxRate is still accepted (onboarding sets it from the
// province, and the FBR adapter still reads it) but no admin form edits it —
// every order is charged at taxRateCash / taxRateCard.
const updateConceptSchema = createConceptSchema.partial().omit({ slug: true }).extend({
  isActive: z.boolean().optional(),
  storefrontLayout: z.array(z.record(z.string(), z.unknown())).optional().nullable(),
  // Public-facing contact — per brand (decision 18). Surfaces on the
  // storefront /visit page, schema.org Restaurant JSON-LD, the brand
  // microsite footer and every "message us" WhatsApp link.
  phone:           z.string().max(40).nullable().optional(),
  whatsapp:        z.string().max(40).nullable().optional(),
  // The neighbourhood label on the storefront pill. Location has no locality
  // column yet, so this one address-ish label is still brand-level.
  addressLocality: z.string().max(200).nullable().optional(),
  // Expected monthly portions — the opex-per-portion denominator on recipes.
  forecastPortionsPerMonth: z.number().int().min(0).max(10_000_000).optional(),
  // FBR / tax invoice details
  strn:             z.string().max(40).nullable().optional(),
  ntn:              z.string().max(40).nullable().optional(),
  province:         z.enum(['PB', 'SD', 'KP', 'BL', 'ICT', 'GB', 'AJK']).nullable().optional(),
  invoiceLegalName: z.string().max(120).nullable().optional(),
  invoiceAddress:   z.string().max(500).nullable().optional(),
  invoicePrefix:    z.string().max(10).nullable().optional(),
  fbrPosId:         z.number().int().nullable().optional(),
  // SRB (Sindh) POSID — without it SRB submission skips the brand.
  srbPosId:         z.number().int().nullable().optional(),
})

/** Brand fields that moved off the brand editor, and where they live now. */
export const MOVED_CONCEPT_FIELDS: Record<string, string> = {
  address:          'The address is set on the kitchen\'s Location (Storefront → Locations)',
  latitude:         'The map pin is set on the kitchen\'s Location (Storefront → Locations)',
  longitude:        'The map pin is set on the kitchen\'s Location (Storefront → Locations)',
  deliveryRadiusKm: 'Delivery coverage is set as delivery zones (Configuration → Delivery zones)',
}

function assertNoMovedFields(body: unknown): void {
  if (!body || typeof body !== 'object') return
  const hit = Object.keys(body).find((k) => k in MOVED_CONCEPT_FIELDS && (body as Record<string, unknown>)[k] !== undefined)
  if (hit) throw new AppError('FIELD_MOVED', `${hit}: ${MOVED_CONCEPT_FIELDS[hit]}`, 422)
}

export async function conceptRoutes(fastify: FastifyInstance) {
  // GET /concepts — list concepts under the active tenant
  // Reads honour portfolio mode: when the operator has flipped to "All
  // companies", every tenant they're a member of is included via the
  // `x-servd-portfolio` header. Writes (POST/PATCH/DELETE below) stay
  // scoped to the single active tenant — portfolio writes are gated at
  // the client layer.
  // ── GET /concepts/resolve-maps-link?url=… ────────────────────────────────
  // Turns a Google Maps share link (maps.app.goo.gl/…, goo.gl/maps/…, or a
  // full google.com/maps URL) into { lat, lng, name } so the operator can pin
  // a location by pasting the link they already share, instead of dragging a
  // marker by eye. Short links only resolve server-side: the browser can't
  // follow the redirect (CORS), and the destination URL is where the
  // coordinates live.
  //
  // SSRF posture: this is a user-supplied URL that the server fetches, so the
  // host is checked against a strict allowlist BEFORE the request and on
  // EVERY redirect hop (a "safe" short link could 302 anywhere). Redirects
  // are followed manually, capped at 5, with a short timeout. Registered
  // ahead of /:id so the literal path is never read as a concept id.
  fastify.get<{ Querystring: { url?: string } }>(
    '/resolve-maps-link',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const raw = (req.query.url ?? '').trim()
      if (!raw) return reply.status(400).send({ error: { code: 'BAD_URL', message: 'url is required' } })

      const ALLOWED = new Set([
        'maps.app.goo.gl', 'goo.gl', 'google.com', 'www.google.com',
        'maps.google.com', 'www.google.com.pk', 'google.com.pk',
      ])
      const hostOk = (u: URL) => u.protocol === 'https:' && ALLOWED.has(u.hostname)

      let current: URL
      try { current = new URL(raw) } catch {
        return reply.status(400).send({ error: { code: 'BAD_URL', message: 'That is not a valid link' } })
      }
      if (!hostOk(current)) {
        return reply.status(400).send({ error: { code: 'NOT_GOOGLE_MAPS', message: 'Paste a Google Maps link (maps.app.goo.gl or google.com/maps)' } })
      }

      for (let hop = 0; hop < 5; hop++) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8_000)
        let res: Response
        try {
          res = await fetch(current.toString(), {
            method: 'GET', redirect: 'manual', signal: ctrl.signal,
            headers: { 'user-agent': 'Mozilla/5.0 (servd-admin maps-link resolver)' },
          })
        } catch {
          return reply.status(502).send({ error: { code: 'UNREACHABLE', message: 'Could not reach Google Maps to resolve that link' } })
        } finally { clearTimeout(timer) }

        const loc = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && loc) {
          const next = new URL(loc, current)
          if (!hostOk(next)) {
            return reply.status(400).send({ error: { code: 'REDIRECT_OFF_GOOGLE', message: 'That link redirects away from Google Maps' } })
          }
          current = next
          continue
        }
        break
      }

      const parsed = parseMapsUrl(current)
      if (!parsed) {
        return reply.status(422).send({
          error: { code: 'NO_COORDS', message: 'Could not find coordinates in that link. Open the place in Google Maps, use Share → Copy link, and paste that.' },
        })
      }
      return parsed
    },
  )

  fastify.get<{ Querystring: { includeInactive?: string } }>('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scope = await resolveTenantScope(req)
    // Retired brands (isActive=false, e.g. Simmer) are EXCLUDED by default so
    // they vanish from every admin picker, dashboard card, and filter in one
    // place. The Tenants & Brands settings page opts in via ?includeInactive=1
    // so the CEO can still see and reactivate them. Historical data (orders,
    // financial entries) is untouched — this only affects concept listings.
    const includeInactive = req.query.includeInactive === '1'
    const concepts = await prisma.concept.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }), ...tenantWhere(scope) },
      orderBy: { name: 'asc' },
      // Include tenant context in portfolio mode so the CEO can see which
      // company each brand belongs to without an extra round-trip. Cheap
      // join — Tenant is tiny.
      include: scope.portfolio ? { tenant: { select: { id: true, name: true, slug: true } } } : undefined,
    })
    return concepts
  })

  // GET /concepts/:id — must belong to the active tenant
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const concept = await prisma.concept.findFirst({
      where: { id: req.params.id, deletedAt: null, tenantId: req.staffUser!.tenantFilter },
    })
    if (!concept) throw new NotFoundError('Concept', req.params.id)
    return concept
  })

  // POST /concepts — created under the active tenant
  fastify.post('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    assertNoMovedFields(req.body)
    const body = createConceptSchema.parse(req.body)
    const concept = await prisma.concept.create({
      data: { ...body, tenantId: req.staffUser!.tenantId! },
    })
    return reply.status(201).send(concept)
  })

  // PATCH /concepts/:id — managers can edit storefront content; admin-only for structural changes
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    assertNoMovedFields(req.body)
    const body = updateConceptSchema.parse(req.body)
    // Verify the concept belongs to the active tenant before mutating.
    const owned = await prisma.concept.findFirst({
      where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Concept not found in your active company' } })
    const { storefrontLayout, ...rest } = body
    const data: Prisma.ConceptUpdateInput = { ...rest }
    if (storefrontLayout !== undefined) {
      data.storefrontLayout = storefrontLayout === null ? Prisma.JsonNull : (storefrontLayout as Prisma.InputJsonValue)
    }
    const concept = await prisma.concept.update({
      where: { id: req.params.id },
      data,
    })
    return concept
  })

  // DELETE /concepts/:id (soft delete) — must belong to active tenant
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const owned = await prisma.concept.findFirst({
      where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Concept not found in your active company' } })
    await prisma.concept.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return reply.status(204).send()
  })
}

/** Pull coordinates (+ place name) out of a resolved Google Maps URL.
 *  Handles the shapes Maps actually emits:
 *    /maps/place/<name>/@LAT,LNG,17z/…      (viewport centre — least precise)
 *    …!3dLAT!4dLNG…                          (the pin itself — preferred)
 *    ?q=LAT,LNG  /  ?query=LAT,LNG  /  ?ll=LAT,LNG
 *  Prefers the !3d/!4d pin over the @ viewport when both are present. */
function parseMapsUrl(u: URL): { lat: number; lng: number; name: string | null } | null {
  const href = decodeURIComponent(u.href)
  const inRange = (lat: number, lng: number) =>
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  const nameMatch = href.match(/\/maps\/place\/([^/@?]+)/)
  const name = nameMatch ? nameMatch[1]!.replace(/\+/g, ' ').trim() : null

  const pin = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)
  if (pin) { const lat = +pin[1]!, lng = +pin[2]!; if (inRange(lat, lng)) return { lat, lng, name } }

  const at = href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (at) { const lat = +at[1]!, lng = +at[2]!; if (inRange(lat, lng)) return { lat, lng, name } }

  for (const key of ['q', 'query', 'll', 'destination']) {
    const v = u.searchParams.get(key)
    const m = v?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
    if (m) { const lat = +m[1]!, lng = +m[2]!; if (inRange(lat, lng)) return { lat, lng, name } }
  }
  return null
}
