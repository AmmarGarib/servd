import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { promises as dns } from 'dns'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { assertConceptOwned } from '../../lib/tenantScope.js'
import { refreshDomainOrigins } from './hostCache.js'

const STOREFRONT_TARGET = process.env['SERVD_STOREFRONT_HOST'] ?? 'storefront.servd.pk'

function generateVerificationToken(): string {
  return 'servd_' + randomBytes(8).toString('hex')   // 21-char prefix-friendly
}

function isValidHostname(host: string): boolean {
  // RFC-ish hostname: labels of 1-63 chars, separated by dots, total <=253
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host)
}

export async function domainRoutes(fastify: FastifyInstance) {
  // GET /domains — list all configured domains under the active tenant
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const rows = await prisma.domain.findMany({
      where: { deletedAt: null, tenantId: req.staffUser!.tenantId },
      orderBy: { createdAt: 'desc' },
    })
    // Enrich with concept name (no relation defined yet; resolve manually)
    const conceptIds = Array.from(new Set(rows.map((r) => r.conceptId).filter((x): x is string => !!x)))
    const concepts = conceptIds.length > 0
      ? await prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true, slug: true } })
      : []
    const conceptMap = new Map(concepts.map((c) => [c.id, c]))
    return rows.map((d) => ({
      ...d,
      concept: d.conceptId ? conceptMap.get(d.conceptId) ?? null : null,
      // Show DNS instructions inline so the UI doesn't need a second call
      dnsInstructions: dnsInstructions(d.hostname, d.verificationToken),
    }))
  })

  // POST /domains — add a new domain
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      hostname:  z.string().min(4).max(253).toLowerCase(),
      conceptId: z.string().uuid().nullable().optional(),
      purpose:   z.enum(['order', 'brand_microsite']).default('order'),
      notes:     z.string().max(500).optional(),
    }).parse(req.body)

    if (!isValidHostname(body.hostname)) {
      throw new AppError('BAD_HOSTNAME', 'That doesn\'t look like a valid domain name', 400)
    }
    // Reject schemes / paths / ports
    if (body.hostname.includes('://') || body.hostname.includes('/') || body.hostname.includes(':')) {
      throw new AppError('BAD_HOSTNAME', 'Enter only the hostname (e.g. order.mubarakbiryani.pk) — no scheme, port, or path', 400)
    }

    const dup = await prisma.domain.findUnique({ where: { hostname: body.hostname } })
    if (dup) throw new AppError('HOSTNAME_TAKEN', 'That hostname is already configured', 409)

    // The domain binds to the ACTIVE company, so its brand (if any) must be
    // one of that company's — not of any company the operator belongs to.
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')

    const created = await prisma.domain.create({
      data: {
        hostname:          body.hostname,
        conceptId:         body.conceptId ?? null,
        purpose:           body.purpose,
        notes:             body.notes,
        // Tenant comes from the request (active tenant), not user-supplied.
        tenantId:          req.staffUser!.tenantId,
        verificationToken: generateVerificationToken(),
        createdById:       req.staffUser!.id,
        status:            'pending',
      },
    })
    return reply.status(201).send({
      ...created,
      dnsInstructions: dnsInstructions(created.hostname, created.verificationToken),
    })
  })

  // POST /domains/:id/verify — attempt DNS verification of the TXT record
  fastify.post<{ Params: { id: string } }>(
    '/:id/verify',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const dom = await prisma.domain.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantId },
      })
      if (!dom) throw new NotFoundError('Domain', req.params.id)

      const txtHost = `_servd-verify.${dom.hostname}`
      let found = false
      let dnsError: string | null = null
      try {
        const records = await dns.resolveTxt(txtHost)
        // Each TXT record can be array of strings; flatten and search
        const flat = records.map((r) => r.join('')).flat()
        found = flat.some((s) => s.trim() === dom.verificationToken)
      } catch (err) {
        dnsError = (err as Error & { code?: string }).code ?? (err as Error).message
      }

      const updated = await prisma.domain.update({
        where: { id: dom.id },
        data: {
          status:        found ? 'verified' : 'failed',
          verifiedAt:    found ? new Date() : null,
          lastCheckedAt: new Date(),
        },
      })
      return {
        ...updated,
        verificationCheck: {
          found,
          txtHost,
          expectedToken: dom.verificationToken,
          dnsError,
        },
      }
    },
  )

  // PATCH /domains/:id — update conceptId / purpose / notes / status (admin)
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = z.object({
        conceptId: z.string().uuid().nullable().optional(),
        purpose:   z.enum(['order', 'brand_microsite']).optional(),
        notes:     z.string().max(500).nullable().optional(),
        // Admin can manually flip to active once SSL is provisioned at the edge
        status:    z.enum(['pending', 'verified', 'active', 'failed', 'disabled']).optional(),
      }).parse(req.body)

      const dom = await prisma.domain.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantId },
      })
      if (!dom) throw new NotFoundError('Domain', req.params.id)
      // A domain may only point at a brand of the domain's OWN company — not
      // any company the operator happens to belong to.
      if (body.conceptId) {
        const concept = await prisma.concept.findFirst({
          where: { id: body.conceptId, tenantId: dom.tenantId ?? { in: [] }, deletedAt: null },
          select: { id: true },
        })
        if (!concept) return reply.status(422).send({ error: { code: 'BRAND_NOT_IN_COMPANY', message: 'That brand is not part of this domain\'s company' } })
      }

      const updated = await prisma.domain.update({
        where: { id: req.params.id },
        data: {
          ...body,
          ...(body.status === 'active' && !dom.sslIssuedAt && { sslIssuedAt: new Date() }),
        },
      })
      // Going active / inactive changes which origins the API accepts.
      if (body.status !== undefined) await refreshDomainOrigins()
      return updated
    },
  )

  // DELETE /domains/:id — soft delete (must belong to active tenant)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.domain.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantId },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Domain not found in your active company' } })
      await prisma.domain.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date(), status: 'disabled' },
      })
      await refreshDomainOrigins()
      return reply.status(204).send()
    },
  )

  // GET /domains/lookup?hostname=… — resolve one incoming Host header to a
  // brand. Public: a hostname → brand mapping is public DNS anyway.
  fastify.get<{ Querystring: { hostname: string } }>(
    '/lookup',
    async (req) => {
      const host = req.query.hostname?.toLowerCase().trim().replace(/:\d+$/, '')
      if (!host) return null
      const dom = await serviceClient.domain.findUnique({ where: { hostname: host } })
      if (!dom || dom.status !== 'active' || dom.deletedAt) return null
      const concept = dom.conceptId
        ? await serviceClient.concept.findFirst({
            where: { id: dom.conceptId, deletedAt: null },
            select: { slug: true },
          })
        : null
      return {
        conceptId: dom.conceptId,
        slug:      concept?.slug ?? null,
        purpose:   dom.purpose,
        tenantId:  dom.tenantId,
      }
    },
  )

  // GET /domains/hosts — every ACTIVE custom domain with the brand slug it
  // serves. Public, and small. The Domain table is the ONE source of truth for
  // brand hosts: the storefront middleware maps Host → brand from this list
  // (cached), and the API's CORS allowlist is built from the same rows
  // (domains/hostCache.ts). The hardcoded storefront BRAND_DOMAIN_MAP and the
  // DEFAULT_BRAND_HOSTS list in lib/corsAllowlist.ts are gone.
  fastify.get('/hosts', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60')
    return { hosts: await activeDomainHosts() }
  })
}

/** Active domains with the brand slug each serves (slug null = no brand). */
export async function activeDomainHosts(): Promise<Array<{ hostname: string; slug: string | null; purpose: string }>> {
  const rows = await serviceClient.domain.findMany({
    where: { status: 'active', deletedAt: null },
    select: { hostname: true, conceptId: true, purpose: true },
    orderBy: { hostname: 'asc' },
  })
  const ids = Array.from(new Set(rows.map((r) => r.conceptId).filter((x): x is string => !!x)))
  const concepts = ids.length > 0
    ? await serviceClient.concept.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, slug: true, tenant: { select: { isTest: true } } } })
    : []
  const slugOf = new Map(concepts.map((c) => [c.id, c.slug]))
  // A test company's brand hosts are not advertised (lib/publicBrands.ts).
  const testIds = new Set(concepts.filter((c) => c.tenant?.isTest).map((c) => c.id))
  return rows.filter((r) => !(r.conceptId && testIds.has(r.conceptId))).map((r) => ({
    hostname: r.hostname,
    slug: r.conceptId ? slugOf.get(r.conceptId) ?? null : null,
    purpose: r.purpose,
  }))
}

function dnsInstructions(hostname: string, token: string) {
  return {
    txt: {
      type: 'TXT',
      host: `_servd-verify.${hostname}`,
      value: token,
      ttl: 300,
      hint: 'Verifies that you own this domain. Required before traffic can be routed.',
    },
    cname: {
      type: 'CNAME',
      host: hostname,
      value: STOREFRONT_TARGET,
      ttl: 300,
      hint: 'Routes traffic to servd. After this propagates, your custom domain will serve the brand storefront.',
    },
    apexNote:
      'If your hostname is a root/apex domain (no subdomain), most DNS providers don\'t allow CNAME at the apex. Use an A/ALIAS/ANAME record pointing to servd\'s IP, or use the www subdomain.',
    sslNote:
      'SSL is automatic on the servd edge once status flips to "verified". Allow up to 10 minutes for issuance.',
  }
}
