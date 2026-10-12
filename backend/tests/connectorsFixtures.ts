// Shared fixtures for the POS connector suites (W1): two companies, each with
// a brand, an outlet, menu items and staff; a Fastify app with the till
// routes and the three connector plugins; helpers to configure connectors and
// to make orders with exact stored figures. Not a test file itself.

import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { invalidateConnector, clearConnectorCache } from '../src/connectors/registry.js'
import { encryptSecret, secretHint } from '../src/lib/secretBox.js'

export { prisma }

/** A valid SERVD_SECRET_KEY for the suites (never a real key). */
export const TEST_SECRET_KEY = Buffer.alloc(32, 7).toString('base64')

export interface Company {
  tenantId: string
  conceptId: string
  locationId: string
  items: { nihari: string; kheer: string; water: string }
}

export interface Who { id: string; token: string; role: string; tenantId: string | null }

export async function mkCompany(slug: string, opts: { srbPosId?: number | null; fbrPosId?: number | null } = {}): Promise<Company> {
  const tenantId = (await prisma.tenant.create({ data: { name: `Co ${slug}`, slug } })).id
  await ensureChartOfAccounts(tenantId)
  const conceptId = (await prisma.concept.create({
    data: {
      name: `Brand ${slug}`, slug: `brand-${slug}`, type: 'restaurant', tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8,
      srbPosId: opts.srbPosId ?? null, fbrPosId: opts.fbrPosId ?? null, ntn: '1234567-8', invoiceLegalName: `${slug} Foods (Pvt) Ltd`, province: 'SD',
    },
  })).id
  const locationId = (await prisma.location.create({ data: { slug: `loc-${slug}`, name: `Outlet ${slug}`, tenantId } })).id
  const cat = await prisma.category.create({ data: { conceptId, name: 'Mains' } })
  const nihari = (await prisma.menuItem.create({ data: { conceptId, categoryId: cat.id, name: 'Beef Nihari', priceCents: 145_000 } })).id
  const kheer = (await prisma.menuItem.create({ data: { conceptId, categoryId: cat.id, name: 'Kheer', priceCents: 55_000 } })).id
  const water = (await prisma.menuItem.create({ data: { conceptId, categoryId: cat.id, name: 'Water', priceCents: 10_000, taxClassification: 'zero_rated' } })).id
  return { tenantId, conceptId, locationId, items: { nihari, kheer, water } }
}

export async function mkUser(key: string, role: string, tenantId: string | null, extra: { phone?: string } = {}): Promise<Who> {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${randomBytes(3).toString('hex')}@conn.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as Prisma.UserCreateInput['role'], isActive: true, accountStatus: 'active', tenantId, phone: extra.phone ?? null,
    },
  })
  if (tenantId) await prisma.tenantMember.create({ data: { tenantId, userId: u.id } }).catch(() => {})
  return { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken, role, tenantId }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await registerConnectorPlugins(app)
  await app.ready()
  return app
}

export function caller(app: FastifyInstance) {
  return (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}`, ...headers } })
}

/** Configure a company's connector directly (tests only). */
export async function setConnector(tenantId: string, kind: 'fiscal' | 'terminal', data: {
  driver?: string; enabled?: boolean; settings?: Record<string, unknown>; webhookSecret?: string | null; liveSince?: Date | null
}): Promise<void> {
  const existing = await prisma.posConnector.findUnique({ where: { tenantId_kind: { tenantId, kind } } })
  const settings = data.settings !== undefined ? { ...((existing?.settings as Record<string, unknown> | null) ?? {}), ...data.settings } : undefined
  const fields = {
    ...(data.driver !== undefined && { driver: data.driver }),
    ...(data.enabled !== undefined && { enabled: data.enabled }),
    ...(settings !== undefined && { settings: JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonValue }),
    ...(data.liveSince !== undefined && { liveSince: data.liveSince }),
    ...(data.webhookSecret !== undefined && {
      webhookSecretEnc: data.webhookSecret ? encryptSecret(data.webhookSecret) : null,
      webhookSecretHint: data.webhookSecret ? secretHint(data.webhookSecret) : null,
    }),
  }
  if (existing) await prisma.posConnector.update({ where: { id: existing.id }, data: fields })
  else await prisma.posConnector.create({ data: { tenantId, kind, webhookToken: randomBytes(32).toString('hex'), ...fields } })
  invalidateConnector(tenantId, kind)
}

export function resetConnectorCache(): void {
  clearConnectorCache()
}

export interface OrderSpec {
  items: Array<{ menuItemId: string | null; name: string; quantity: number; unitPriceCents: number; modifiers?: Array<{ name: string; priceDeltaCents: number }> }>
  taxCents: number
  taxRatePct: number | null
  totalCents: number
  discountCents?: number
  promoDiscountCents?: number
  serviceChargeCents?: number
  tipCents?: number
  payments?: Array<{ method: 'cash' | 'card' | 'keenu_qr' | 'comp'; amountCents: number; status?: 'paid' | 'pending' }>
  status?: 'completed' | 'received'
  locationId?: string | null
  srbInvoiceNumber?: string | null
  fbrInvoiceNumber?: string | null
  shiftId?: string | null
  customer?: { name: string; ntn?: string; cnic?: string }
}

/** An order with exact stored figures (no pricing), as completeOrder would see it. */
export async function mkOrder(co: Company, spec: OrderSpec): Promise<string> {
  const customerId = spec.customer
    ? (await prisma.customer.create({ data: { name: spec.customer.name, ntn: spec.customer.ntn ?? null, cnic: spec.customer.cnic ?? null } })).id
    : null
  const done = (spec.status ?? 'completed') === 'completed'
  const order = await prisma.order.create({
    data: {
      conceptId: co.conceptId,
      locationId: spec.locationId === undefined ? co.locationId : spec.locationId,
      source: 'pos',
      fulfilmentType: 'takeout',
      status: spec.status ?? 'completed',
      totalCents: spec.totalCents,
      taxCents: spec.taxCents,
      taxRatePct: spec.taxRatePct,
      discountCents: spec.discountCents ?? 0,
      promoDiscountCents: spec.promoDiscountCents ?? 0,
      serviceChargeCents: spec.serviceChargeCents ?? 0,
      tipCents: spec.tipCents ?? 0,
      customerId,
      shiftId: spec.shiftId ?? null,
      placedAt: new Date('2026-10-10T09:00:00Z'),
      completedAt: done ? new Date('2026-10-10T09:30:00Z') : null,
      srbInvoiceNumber: spec.srbInvoiceNumber ?? null,
      fbrInvoiceNumber: spec.fbrInvoiceNumber ?? null,
      items: {
        create: spec.items.map((it) => ({
          menuItemId: it.menuItemId, name: it.name, quantity: it.quantity, unitPriceCents: it.unitPriceCents,
          modifiers: { create: (it.modifiers ?? []).map((m) => ({ name: m.name, priceDeltaCents: m.priceDeltaCents })) },
        })),
      },
      payments: {
        create: (spec.payments ?? []).map((p) => ({ method: p.method, amountCents: p.amountCents, status: p.status ?? 'paid', processedAt: new Date(), shiftId: spec.shiftId ?? null })),
      },
    },
  })
  return order.id
}

/** An open drawer for `who` at `co` (any earlier one closed). */
export async function openDrawer(co: Company, who: Who, locationId: string | null = null): Promise<string> {
  await prisma.shift.updateMany({ where: { userId: who.id, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
  return (await prisma.shift.create({ data: { userId: who.id, tenantId: co.tenantId, locationId, status: 'open', openingFloatCents: 0 } })).id
}

/** Deep substring scan — no secret may appear anywhere in a response. */
export function containsDeep(value: unknown, needle: string): boolean {
  return JSON.stringify(value ?? null).includes(needle)
}

/** Terminal connector settings with one card machine at the company's outlet. */
export function terminalSettings(co: Company, scenario: string): Record<string, unknown> {
  return { terminals: [{ id: 'trm-1', label: 'Counter 1', locationId: co.locationId, terminalId: 'DEV-1', active: true }], test: { scenario } }
}

/** Ring a till order of 2 × Kheer (cash 1,265.00 / card 1,188.00). */
export async function ringKheer(app: FastifyInstance, who: Who, co: Company, quantity = 2): Promise<{ id: string; totalCents: number }> {
  const r = await caller(app)(who, 'POST', '/pos/orders', { conceptId: co.conceptId, items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity, unitPriceCents: 55_000, modifiers: [] }] })
  if (r.statusCode !== 201) throw new Error(`ring failed ${r.statusCode} ${r.body}`)
  return r.json()
}
