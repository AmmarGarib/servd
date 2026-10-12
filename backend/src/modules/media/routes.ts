import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import path from 'path'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF, MARKETING_TEAM } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned } from '../../lib/tenantScope.js'

const CATEGORIES = ['menu', 'marketing', 'shoot', 'kds', 'general'] as const
const KINDS = ['image', 'video', 'font', 'copy'] as const
type Kind = typeof KINDS[number]

// Media assets are company property: MediaAsset.tenantId is stamped with the
// uploader's ACTIVE company, the library lists only the companies in view, and
// delete is 404 for another company's asset. The table used to be global —
// any staff member browsed, and any manager deleted, every company's imagery.
//
// It is also the storefront content library (decision 41): images, videos,
// fonts and copy snippets, each optionally tagged and tied to one brand of the
// asset's own company. Copy snippets have no file (key/url '').

// Browsers disagree on a font's MIME type (and some send none), so a font is
// recognised by its extension and any of these types is signed as sent.
const FONT_EXTENSIONS = new Set(['.woff2', '.woff', '.ttf', '.otf'])
const FONT_CONTENT_TYPES = new Set([
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'font/sfnt',
  'application/font-woff', 'application/font-woff2', 'application/x-font-woff',
  'application/x-font-ttf', 'application/x-font-truetype', 'application/x-font-otf',
  'application/x-font-opentype', 'application/vnd.ms-opentype', 'application/font-sfnt',
  'application/octet-stream',
])

// Upload storage (Cloudflare R2) settings the presigner needs. With any of
// them unset lib/storage.ts still signs a URL — for a host such as
// `servd-media.undefined.r2.cloudflarestorage.com` — so every browser upload
// fails later with a misleading network/CORS error. Refuse up front instead;
// /health reports the same list as `checks.uploadStorage`. R2_BUCKET_NAME has
// a default and is not required.
export const R2_REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL'] as const

export function missingStorageEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return R2_REQUIRED_ENV.filter((k) => !env[k]?.trim())
}

function kindOfUpload(filename: string, contentType: string): Exclude<Kind, 'copy'> | null {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (FONT_EXTENSIONS.has(path.extname(filename).toLowerCase()) && FONT_CONTENT_TYPES.has(contentType)) return 'font'
  return null
}

/** Tags from `a,b` / repeated query params / a JSON array: trimmed, deduped. */
function normaliseTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const out = new Set<string>()
  for (const t of list) {
    if (typeof t !== 'string') continue
    const v = t.trim().slice(0, 40)
    if (v) out.add(v)
  }
  return [...out].slice(0, 20)
}

const tagsSchema = z.union([z.array(z.string()), z.string()]).optional().transform((v) => (v === undefined ? undefined : normaliseTags(v)))

function toDto(a: {
  id: string; kind: string; name: string | null; url: string; filename: string; contentType: string
  tags: string[]; conceptId: string | null; text: string | null; fontFamily: string | null; category: string; createdAt: Date
}) {
  return {
    id: a.id, kind: a.kind, name: a.name ?? a.filename, url: a.url, filename: a.filename,
    contentType: a.contentType, tags: a.tags, conceptId: a.conceptId, text: a.text,
    fontFamily: a.fontFamily, category: a.category, createdAt: a.createdAt,
  }
}

/** A brand for an asset must be a brand of the asset's own company. */
async function assertBrandForAsset(req: FastifyRequest, conceptId: string, assetTenantId: string | null, mode: 'create' | 'write') {
  const concept = await assertConceptOwned(req, conceptId, mode)
  if (concept.tenantId !== assetTenantId) {
    throw new AppError('BRAND_NOT_IN_COMPANY', 'That brand belongs to another company', 422)
  }
}

export async function mediaRoutes(fastify: FastifyInstance) {
  // GET /media/upload-url?filename&contentType&category&kind&name&tags&conceptId&fontFamily
  fastify.get<{ Querystring: Record<string, string | string[] | undefined> }>(
    '/upload-url',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const q = z.object({
        filename:    z.string().min(1).max(255),
        contentType: z.string().max(120).default(''),
        category:    z.string().max(40).default('general'),
        kind:        z.enum(['image', 'video', 'font']).optional(),
        name:        z.string().max(120).optional(),
        tags:        tagsSchema,
        conceptId:   z.string().min(1).optional(),
        fontFamily:  z.string().max(120).optional(),
      }).parse(req.query)
      const tenantId = req.staffUser?.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)

      const kind = kindOfUpload(q.filename, q.contentType)
      if (!kind) throw new AppError('MEDIA_TYPE_NOT_ALLOWED', `Files of type '${q.contentType || 'unknown'}' cannot be uploaded`, 422)
      if (q.kind && q.kind !== kind) throw new AppError('MEDIA_KIND_MISMATCH', `This file is a ${kind}, not a ${q.kind}`, 422)
      if (q.conceptId) await assertBrandForAsset(req, q.conceptId, tenantId, 'create')

      const missing = missingStorageEnv()
      if (missing.length > 0) {
        throw new AppError(
          'STORAGE_NOT_CONFIGURED',
          'File uploads are not set up on this server (Cloudflare R2 settings are missing). Ask IT to configure upload storage.',
          503,
          { missing },
        )
      }

      const { getSignedUploadUrl } = await import('../../lib/storage.js')
      const result = await getSignedUploadUrl(q.filename, q.contentType, q.category, kind === 'font' ? [q.contentType] : [])
        .catch((err: Error) => {
          if (/not allowed/.test(err.message)) throw new AppError('MEDIA_TYPE_NOT_ALLOWED', err.message, 422)
          throw err
        })

      const baseName = path.basename(q.filename, path.extname(q.filename))
      // Pre-create the MediaAsset record (url is public after upload completes)
      const asset = await prisma.mediaAsset.create({
        data: {
          tenantId,
          key:          result.key,
          url:          result.publicUrl,
          filename:     q.filename,
          contentType:  q.contentType,
          category:     q.category,
          kind,
          name:         q.name?.trim() || baseName,
          tags:         q.tags ?? [],
          conceptId:    q.conceptId ?? null,
          fontFamily:   kind === 'font' ? (q.fontFamily?.trim() || q.name?.trim() || baseName) : null,
          uploadedById: req.staffUser!.id,
        },
      })

      return { ...result, assetId: asset.id }
    },
  )

  // GET /media?kind=&tag=&conceptId=&q=&category=&limit=&cursor=
  fastify.get<{ Querystring: Record<string, string | undefined> }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const q = req.query
      const limit  = Math.min(Math.max(parseInt(q['limit'] ?? '200', 10) || 200, 1), 500)
      const kind   = KINDS.includes(q['kind'] as Kind) ? q['kind'] : undefined
      const cat    = q['category']
      const needle = q['q']?.trim()

      const assets = await prisma.mediaAsset.findMany({
        where: {
          ...(await scopeTenantWhere(req, 'read')),
          // Clock-in selfies and waste-log evidence photos share the upload
          // path; they are not library content (the waste log links its own).
          ...(cat && CATEGORIES.includes(cat as typeof CATEGORIES[number]) ? { category: cat } : { category: { notIn: ['clockin', 'waste'] } }),
          ...(kind ? { kind } : {}),
          ...(q['tag'] ? { tags: { has: q['tag'] } } : {}),
          ...(q['conceptId'] ? { conceptId: q['conceptId'] } : {}),
          ...(needle ? {
            OR: [
              { name:     { contains: needle, mode: 'insensitive' as const } },
              { filename: { contains: needle, mode: 'insensitive' as const } },
              { text:     { contains: needle, mode: 'insensitive' as const } },
              { tags:     { has: needle } },
            ],
          } : {}),
          ...(q['cursor'] ? { id: { lt: q['cursor'] } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return assets.map(toDto)
    },
  )

  // POST /media/copy — a reusable copy snippet (headline, blurb, CTA text).
  fastify.post(
    '/copy',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req, reply) => {
      const body = z.object({
        name:      z.string().trim().min(1).max(120),
        text:      z.string().min(1).max(20_000),
        tags:      tagsSchema,
        conceptId: z.string().min(1).nullish(),
      }).parse(req.body)
      const tenantId = req.staffUser?.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
      if (body.conceptId) await assertBrandForAsset(req, body.conceptId, tenantId, 'create')
      const asset = await prisma.mediaAsset.create({
        data: {
          tenantId, kind: 'copy', key: '', url: '', filename: body.name, contentType: 'text/plain',
          category: 'marketing', name: body.name, text: body.text, tags: body.tags ?? [],
          conceptId: body.conceptId ?? null, uploadedById: req.staffUser!.id,
        },
      })
      return reply.status(201).send(toDto(asset))
    },
  )

  // PATCH /media/:id — library fields only; the file itself never changes.
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const body = z.object({
        name:       z.string().trim().min(1).max(120).optional(),
        tags:       tagsSchema,
        conceptId:  z.string().min(1).nullish(),
        text:       z.string().max(20_000).nullish(),
        fontFamily: z.string().trim().max(120).nullish(),
      }).parse(req.body)
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true, tenantId: true, kind: true },
      })
      if (!asset) throw new NotFoundError('MediaAsset', req.params.id)
      if (body.conceptId) await assertBrandForAsset(req, body.conceptId, asset.tenantId, 'write')
      if (asset.kind === 'copy' && body.text !== undefined && !body.text) {
        throw new AppError('COPY_TEXT_REQUIRED', 'A copy snippet needs its text', 422)
      }
      const saved = await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          ...(body.conceptId !== undefined ? { conceptId: body.conceptId } : {}),
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.fontFamily !== undefined && asset.kind === 'font' ? { fontFamily: body.fontFamily || null } : {}),
        },
      })
      return toDto(saved)
    },
  )

  // DELETE /media/:id — managers only; removes DB record (R2 object stays for CDN cache)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true },
      })
      if (!asset) throw new NotFoundError('MediaAsset', req.params.id)
      await prisma.mediaAsset.delete({ where: { id: asset.id } })
      return reply.status(204).send()
    },
  )
}
