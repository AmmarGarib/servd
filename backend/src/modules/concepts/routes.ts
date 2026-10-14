import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import type { UserRole } from '@prisma/client'
import { requireAuth, MANAGERS, CASHIERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError, ForbiddenError } from '../../lib/errors.js'
import { resolveTenantScope, tenantWhere, scopeTenantWhere } from '../../lib/tenantScope.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { audit } from '../../lib/audit.js'
import { KIT_CONCEPT_FIELDS } from '../siteLayouts/service.js'

// What a till role (cashier, foh/waiter) may read about a brand: enough to
// pick it at the till and see its tender GST split, nothing else. The brand
// strategy brief, legal/tax registration, FBR/SRB POS ids and storefront
// layout stay with management. (FOH-01: the till called GET /concepts, which
// was managers-only, so cashiers and waiters saw no brands and rang nothing.)
const TILL_CONCEPT_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  slug: true,
  type: true,
  logoUrl: true,
  primaryColor: true,
  isActive: true,
  taxRateCash: true,
  taxRateCard: true,
} satisfies Prisma.ConceptSelect

// What the Storefront editor reads about a brand (GET /concepts?view=storefront):
// enough to list its pages, pick it in the Library and target a pop-up at it.
// Nothing else — no tax, legal, strategy or layout fields. Opt-in by query on
// purpose: plain GET /concepts stays management/till only, so the narrow row
// never reaches a page that edits brands. (The Brand Editor at
// /marketing/brands, in marketing's sidebar through the 'brands' module, fills
// its whole form from GET /concepts — a narrow row there reads as a wiped
// brand.) The Storefront Pages tab, Library brand picker and pop-up brand
// targeting call it; before, they called the managers/till list, so marketing
// saw no brand pages and a red "Role not allowed" toast.
const STOREFRONT_CONCEPT_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  slug: true,
  logoUrl: true,
  wordmarkUrl: true,
  mascotUrl: true,
  primaryColor: true,
  isActive: true,
} satisfies Prisma.ConceptSelect

// What the admin shell's brand picker reads (GET /concepts?view=picker): the
// active brands of the caller's OWN companies in scope, id + name + mark only.
// Every staff role gets it — it is the sidebar's brand filter, shown on every
// page, and a KDS, finance or HR login filters by brand like anyone else
// (UI-13: the picker called the managers/till list, so every other role got a
// red "Role X is not allowed" toast on every page). Opt-in by query, like the
// storefront view, so a page that edits brands never receives this narrow row
// in place of the full one.
const PICKER_CONCEPT_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  slug: true,
  logoUrl: true,
  primaryColor: true,
} satisfies Prisma.ConceptSelect

// The Brand Editor (/marketing/brands) for the marketing tier — roles that
// hold the 'brands' module without being management (marketing,
// brand_manager by default; CLAUDE.md: Concept.description is edited in
// admin → Marketing → Brands). R2-UI-03: the editor read the managers-only
// list, so marketing saw no brands and could not save any.
//
// BRAND_MARKETING_FIELDS is the ONE allow-list of what that tier may WRITE
// (logoUrl / wordmarkUrl / mascotUrl / primaryColor stay listed for the
// editor's READ, but a PATCH of them is CEO-only — assertKitFieldsCeoOnly):
// the brand's public copy, artwork, colour and strategy brief. Everything
// else stays with management — name, slug, type, isActive, tenant, the tax
// rates and tender split, STRN/NTN/province/invoice details, FBR/SRB POS ids,
// forecast portions (opex denominator), storefront visibility, reservations,
// the guest-facing contact numbers (a WhatsApp number is where customers'
// messages go) and the storefront layout. A PATCH that carries any of those
// is refused whole (403 FIELD_NOT_ALLOWED), never partly applied.
export const BRAND_MARKETING_FIELDS = [
  'description', 'heroTagline',
  'logoUrl', 'wordmarkUrl', 'mascotUrl', 'primaryColor',
  'conceptStatement', 'cuisine', 'heroProduct', 'anchoringExperience',
  'targetCustomer', 'priceTier', 'daypartFocus', 'competitors',
  'differentiator', 'brandVoice',
] as const

// What the marketing tier READS in the Brand Editor: the fields it edits plus
// the public, read-only context the form shows (name, slug, status, guest
// contact, the kitchen mirror). No tax, legal, POS id, forecast or layout.
const BRAND_EDITOR_CONCEPT_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  slug: true,
  type: true,
  // Read-only here: only management changes the service vessel (PATCH, full form).
  serviceVessel: true,
  isActive: true,
  storefrontVisible: true,
  reservationsEnabled: true,
  phone: true,
  whatsapp: true,
  email: true,
  addressLocality: true,
  address: true,
  latitude: true,
  longitude: true,
  ...Object.fromEntries(BRAND_MARKETING_FIELDS.map((f) => [f, true])) as Record<(typeof BRAND_MARKETING_FIELDS)[number], true>,
} satisfies Prisma.ConceptSelect

/** True for the management tier — they get the full brand row. */
function isManager(role: UserRole): boolean {
  return MANAGERS.includes(role)
}

/** True when the caller holds the 'brands' module (role default/override,
 *  + moduleAllow, − moduleDeny — the same source as the central gate). */
async function holdsBrandsModule(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser!
  if (su.role === 'admin') return true
  const u = await prisma.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
  const modules = await effectiveModulesForUser({ role: su.role, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
  return modules.has('brands')
}

/** The Brand Editor's access: management edits the whole brand, a 'brands'
 *  module holder only the marketing fields; anyone else 403. */
/** The brand's look on the Concept — primaryColor, logoUrl, wordmarkUrl,
 *  mascotUrl — is written by the brand kit's publish (CEO-approved, in
 *  Storefront → Brand kit), never straight from a PATCH. Only the CEO (role
 *  admin) may still PATCH them; anyone else sending one is refused whole
 *  (403 KIT_FIELD_CEO_ONLY), never partly applied (review-back-admin-3).
 *  POST /concepts keeps primaryColor as a new brand's starting colour. */
function assertKitFieldsCeoOnly(req: FastifyRequest): void {
  if (req.staffUser!.role === 'admin') return
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return
  const sent = KIT_CONCEPT_FIELDS.filter((k) => (body as Record<string, unknown>)[k] !== undefined)
  if (sent.length > 0) {
    throw new AppError(
      'KIT_FIELD_CEO_ONLY',
      `${sent.join(', ')} ${sent.length === 1 ? 'is' : 'are'} set by the brand kit. Change ${sent.length === 1 ? 'it' : 'them'} in Storefront → Brand kit; the CEO approves the change.`,
      403,
    )
  }
}

async function brandEditorAccess(req: FastifyRequest): Promise<'full' | 'marketing'> {
  if (isManager(req.staffUser!.role)) return 'full'
  if (await holdsBrandsModule(req)) return 'marketing'
  throw new ForbiddenError(`Role '${req.staffUser!.role}' is not allowed for this resource`)
}

const brandMarketingSchema = z.object({
  description:         z.string().max(2000).nullable().optional(),
  heroTagline:         z.string().max(120).nullable().optional(),
  logoUrl:             brandArtworkUrlSchema(),
  wordmarkUrl:         brandArtworkUrlSchema(),
  mascotUrl:           brandArtworkUrlSchema(),
  primaryColor:        z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'A hex colour like #87c540').nullable().optional(),
  conceptStatement:    z.string().max(280).nullable().optional(),
  cuisine:             z.string().max(60).nullable().optional(),
  heroProduct:         z.string().max(120).nullable().optional(),
  anchoringExperience: z.string().max(280).nullable().optional(),
  targetCustomer:      z.string().max(280).nullable().optional(),
  priceTier:           z.enum(['budget', 'mid', 'premium', 'luxury']).nullable().optional(),
  daypartFocus:        z.array(z.string().max(40)).max(10).optional(),
  competitors:         z.array(z.string().max(80)).max(10).optional(),
  differentiator:      z.string().max(280).nullable().optional(),
  brandVoice:          z.string().max(500).nullable().optional(),
}).strict()

// Same rule as brandArtworkUrl below (http(s) or root-relative, '' clears),
// as a function so the marketing schema can sit above it.
function brandArtworkUrlSchema() {
  return z
    .string()
    .max(2048)
    .refine((v) => v === '' || /^https?:\/\//i.test(v) || v.startsWith('/'), { message: 'Must be an http(s) URL or a root-relative path' })
    .optional()
    .nullable()
    // An absent key stays absent (undefined = "leave it"); '' / null clear it.
    .transform((v) => (v === undefined ? undefined : v || null))
}

/** Which brand view the caller gets. Read-only either way — every write route
 *  keeps its own role gate.
 *  - `?view=storefront`: the Storefront editor's narrow row, for anyone who
 *    holds the 'storefront' module (marketing, brand_manager) and for
 *    management (who already read the full row); anyone else 403.
 *  - otherwise: the full row (management), the till's narrow row (cashier,
 *    foh), or 403 — a Storefront-only role gets nothing here. */
async function conceptView(req: FastifyRequest, wantStorefront: boolean): Promise<'full' | 'till' | 'storefront'> {
  const su = req.staffUser!
  if (wantStorefront) {
    if (isManager(su.role)) return 'storefront'
    const u = await prisma.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
    const modules = await effectiveModulesForUser({ role: su.role, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
    if (modules.has('storefront')) return 'storefront'
    throw new ForbiddenError(`Role '${su.role}' is not allowed for this resource`)
  }
  if (isManager(su.role)) return 'full'
  if (CASHIERS.includes(su.role)) return 'till'
  throw new ForbiddenError(`Role '${su.role}' is not allowed for this resource`)
}

const wantsStorefront = (q: { view?: string }) => q.view === 'storefront'
const wantsPicker = (q: { view?: string }) => q.view === 'picker'
const wantsBrandEditor = (q: { view?: string }) => q.view === 'brand'

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
  // The brand's PRIMARY service vessel (owner's FINAL packaging rule,
  // 2026-10-13): 'plate' (dine-in on plates — a dish's Packaging section is
  // used on takeaway / delivery, and on dine-in only when staff tap "Box
  // given") or 'packaging' (packaging IS the service vessel, e.g. Stackd —
  // used on every order). A REQUIRED choice when a brand is created (no
  // default here — 400 when missing); editable later (PATCH, audited). A
  // change applies to lines rung up from then on: OrderItem.serviceVessel is
  // snapshotted at ring-up, so past cost is never restated.
  serviceVessel: z.enum(['plate', 'packaging'], {
    errorMap: () => ({ message: "Pick the brand's service vessel: 'plate' or 'packaging'" }),
  }),
  description: z.string().optional(),
  // Same rule as the wordmark/mascot below (and the Brand Editor's marketing
  // tier): the uploader can hand back a root-relative path, and a value the
  // marketing tier saved must not make management's next full save 400.
  logoUrl: brandArtworkUrl,
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
  // Deliberately NOT z.string().url(): getSignedUploadUrl
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
  // Guest-facing contact email (owner, 2026-10-07: <brand>@gsfoods.pk). Stored
  // trimmed + lowercase; a blank field clears it.
  email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().toLowerCase().email().max(120).nullable().optional(),
  ),
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

  // GET /concepts — the brand list. Management gets the full rows (and may
  // ask for retired brands); till roles (cashier, foh) get the active brands
  // of their companies in scope, narrow fields only. `?view=picker` is the
  // shell's brand picker: every staff role, its own companies' active brands,
  // id/name/mark only. `?view=storefront` is the
  // Storefront editor's list (roles holding the 'storefront' module, and
  // management): active brands in scope, its own narrow fields. All go
  // through the company scope — an empty scope matches nothing.
  fastify.get<{ Querystring: { includeInactive?: string; view?: string } }>('/', { preHandler: requireAuth() }, async (req) => {
    // ?view=picker — the shell's brand picker, any staff role (see
    // PICKER_CONCEPT_SELECT). Company-scoped: an empty scope matches nothing.
    if (wantsPicker(req.query)) {
      return prisma.concept.findMany({
        where: { deletedAt: null, isActive: true, ...(await scopeTenantWhere(req, 'read')) },
        orderBy: { name: 'asc' },
        select: PICKER_CONCEPT_SELECT,
      })
    }
    const includeInactive = req.query.includeInactive === '1'
    // ?view=brand — the Brand Editor. Management: the full rows (below).
    // A 'brands' module holder: the editor's row (BRAND_EDITOR_CONCEPT_SELECT),
    // its companies in read scope; retired brands too when asked. It saves
    // only in a company it belongs to ('write' scope, PATCH below).
    // Each row says which form the caller gets (brandEditorAccess).
    const brandEditor = wantsBrandEditor(req.query)
    if (brandEditor && (await brandEditorAccess(req)) === 'marketing') {
      const rows = await prisma.concept.findMany({
        where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }), ...(await scopeTenantWhere(req, 'read')) },
        orderBy: { name: 'asc' },
        select: BRAND_EDITOR_CONCEPT_SELECT,
      })
      return rows.map((c) => ({ ...c, brandEditorAccess: 'marketing' as const }))
    }
    const view = brandEditor ? 'full' : await conceptView(req, wantsStorefront(req.query))
    if (view !== 'full') {
      return prisma.concept.findMany({
        where: { deletedAt: null, isActive: true, ...(await scopeTenantWhere(req, 'read')) },
        orderBy: { name: 'asc' },
        select: view === 'till' ? TILL_CONCEPT_SELECT : STOREFRONT_CONCEPT_SELECT,
      })
    }
    const scope = await resolveTenantScope(req)
    // Retired brands (isActive=false, e.g. Simmer) are EXCLUDED by default so
    // they vanish from every admin picker, dashboard card, and filter in one
    // place. The Tenants & Brands settings page opts in via ?includeInactive=1
    // so the CEO can still see and reactivate them. Historical data (orders,
    // financial entries) is untouched — this only affects concept listings.
    const concepts = await prisma.concept.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }), ...tenantWhere(scope) },
      orderBy: { name: 'asc' },
      // Include tenant context in portfolio mode so the CEO can see which
      // company each brand belongs to without an extra round-trip. Cheap
      // join — Tenant is tiny.
      include: scope.portfolio ? { tenant: { select: { id: true, name: true, slug: true } } } : undefined,
    })
    return brandEditor ? concepts.map((c) => ({ ...c, brandEditorAccess: 'full' as const })) : concepts
  })

  // GET /concepts/:id — must belong to a company in the caller's read scope
  // (a foreign id 404s). Till roles, and `?view=storefront` callers, get their
  // narrow fields only. Scoped through the shared helper: the raw
  // tenantFilter is null for a staffer with no company, and `tenantId: null`
  // would match every company-less brand.
  fastify.get<{ Params: { id: string }; Querystring: { view?: string } }>('/:id', { preHandler: requireAuth() }, async (req) => {
    if (wantsBrandEditor(req.query) && (await brandEditorAccess(req)) === 'marketing') {
      const concept = await prisma.concept.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        select: BRAND_EDITOR_CONCEPT_SELECT,
      })
      if (!concept) throw new NotFoundError('Concept', req.params.id)
      return { ...concept, brandEditorAccess: 'marketing' as const }
    }
    const view = wantsBrandEditor(req.query) ? 'full' : await conceptView(req, wantsStorefront(req.query))
    const where = { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'read')) }
    const concept = view === 'full'
      ? await prisma.concept.findFirst({ where })
      : await prisma.concept.findFirst({
          where: { ...where, isActive: true },
          select: view === 'till' ? TILL_CONCEPT_SELECT : STOREFRONT_CONCEPT_SELECT,
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

  // PATCH /concepts/:id — management edits the whole brand (the full schema
  // below); a 'brands' module holder (marketing, brand_manager — the Brand
  // Editor) edits ONLY BRAND_MARKETING_FIELDS. Either way the brand must be in
  // a company the operator belongs to ('write' scope — a foreign id 404s),
  // and the change is audited.
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const access = await brandEditorAccess(req)
    assertKitFieldsCeoOnly(req)
    if (access === 'marketing') {
      const body = req.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('VALIDATION_ERROR', 'Send the brand fields to change', 400)
      }
      // Refuse the whole request when it carries a field outside the
      // marketing allow-list — never apply part of it.
      const allowed = new Set<string>(BRAND_MARKETING_FIELDS)
      const refused = Object.keys(body).filter((k) => !allowed.has(k) && (body as Record<string, unknown>)[k] !== undefined)
      if (refused.length) {
        throw new AppError(
          'FIELD_NOT_ALLOWED',
          `Only management can change: ${refused.join(', ')}. The Brand Editor saves copy, artwork, colour and the brand brief.`,
          403,
        )
      }
      const data = brandMarketingSchema.parse(body)
      const owned = await prisma.concept.findFirst({
        // 'write': editing an EXISTING brand → any company the operator
        // belongs to (the Brand Editor lists every member company's brands in
        // All-companies view). Foreign rows and a company-less staffer 404.
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        select: BRAND_EDITOR_CONCEPT_SELECT,
      })
      if (!owned) throw new NotFoundError('Concept', req.params.id)
      const updated = await prisma.concept.update({
        where: { id: owned.id },
        data,
        select: BRAND_EDITOR_CONCEPT_SELECT,
      })
      const changed = Object.keys(data) as (keyof typeof data)[]
      await audit({
        category: 'identity',
        action: 'concept.marketing_update',
        entity: 'Concept',
        entityId: owned.id,
        userId: req.staffUser!.id,
        userEmail: req.staffUser!.email,
        tenantId: owned.tenantId,
        before: Object.fromEntries(changed.map((k) => [k, (owned as Record<string, unknown>)[k]])),
        after: Object.fromEntries(changed.map((k) => [k, (updated as Record<string, unknown>)[k]])),
      })
      return { ...updated, brandEditorAccess: 'marketing' as const }
    }
    assertNoMovedFields(req.body)
    const body = updateConceptSchema.parse(req.body)
    // Verify the concept belongs to a company the operator is a member of
    // before mutating ('write' — editing an existing row; an empty scope — a
    // staffer with no company — matches nothing, so a foreign id 404s).
    const owned = await prisma.concept.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Concept not found in your companies' } })
    const { storefrontLayout, ...rest } = body
    const data: Prisma.ConceptUpdateInput = { ...rest }
    if (storefrontLayout !== undefined) {
      data.storefrontLayout = storefrontLayout === null ? Prisma.JsonNull : (storefrontLayout as Prisma.InputJsonValue)
    }
    const concept = await prisma.concept.update({
      where: { id: req.params.id },
      data,
    })
    if (rest.serviceVessel !== undefined && rest.serviceVessel !== owned.serviceVessel) {
      await audit({
        category: 'identity',
        action: 'concept.service_vessel',
        entity: 'Concept',
        entityId: owned.id,
        userId: req.staffUser!.id,
        userEmail: req.staffUser!.email,
        tenantId: owned.tenantId,
        before: { serviceVessel: owned.serviceVessel },
        after: { serviceVessel: rest.serviceVessel },
        metadata: {
          note: 'Applies to order lines rung up from now on. Lines already rung up keep the vessel snapshotted on them, so past food cost is not restated.',
        },
      })
    }
    const changedKeys = Object.keys(rest).filter((k) => (rest as Record<string, unknown>)[k] !== undefined)
    if (storefrontLayout !== undefined) changedKeys.push('storefrontLayout')
    await audit({
      category: 'identity',
      action: 'concept.update',
      entity: 'Concept',
      entityId: owned.id,
      userId: req.staffUser!.id,
      userEmail: req.staffUser!.email,
      tenantId: owned.tenantId,
      metadata: { fields: changedKeys },
    })
    if (wantsBrandEditor(req.query as { view?: string })) return { ...concept, brandEditorAccess: 'full' as const }
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
