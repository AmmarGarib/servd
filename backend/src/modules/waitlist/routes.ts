// servd new-brand waitlist — /waitlist (contract: owner, 2026-10-07).
//
// Public: visit (anonymous counter), request-code + join (opt-in, verified by
// a WhatsApp code from the ONE customer code store in auth/otp.ts), and
// unsubscribe. Staff: stats and the sign-up list (module crm or campaigns).
//
// Not company-scoped by design — a servd-level list (see ./service.ts and the
// schema comment on WaitlistSignup). Sign-ups land in the customer master.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, ForbiddenError } from '../../lib/errors.js'
import { refuseCodeRequestInPractice } from '../../lib/sandbox.js'
import { requireAuth } from '../auth/middleware.js'
import { requestOtp, verifyOtp, normalisePhone, normaliseEmail } from '../auth/otp.js'
import { maskPhone } from '../auth/twoFactor.js'
import { check as checkRateLimit, recordFailure } from '../../lib/loginRateLimit.js'
import {
  WAITLIST_LIST, WAITLIST_CONSENT_TEXT, sanitiseSource, deviceFromUserAgent,
  readUnsubscribeToken, staffModules,
} from './service.js'

// Unauthenticated endpoints that send messages are capped on the thing being
// abused — the phone — as well as the IP (CLAUDE.md, 2026-09-09). Every code
// sent counts; otp.ts adds its 30s cooldown and per-phone daily cap on top.
const CODE_PHONE_LIMIT = { scope: 'waitlist-code-phone', max: 3, lockoutSec: 60 * 60 }
const CODE_IP_LIMIT    = { scope: 'waitlist-code-ip',    max: 10, lockoutSec: 60 * 60 }
// Wrong codes on join, per IP (each code also locks after 5 wrong tries).
const JOIN_IP_LIMIT    = { scope: 'waitlist-join-ip',    max: 20, lockoutSec: 15 * 60 }

const PAGE_SIZE = 50
const CSV_MAX_ROWS = 10_000

const optText = (max: number) => z.string().trim().max(max).optional().nullable()
  .transform((v) => (v && v.length > 0 ? v : null))

const contactFields = {
  name:     z.string().trim().min(1).max(80),
  phone:    z.string().min(7).max(20),
  email:    z.string().trim().max(200).email().optional().nullable().or(z.literal('')),
  area:     optText(80),
  interest: optText(500),
  source:   z.string().max(200).optional().nullable(),
  consent:  z.boolean().optional(),
  consentText: z.string().max(500).optional().nullable(),
}

const requestCodeSchema = z.object(contactFields)
const joinSchema = z.object({ ...contactFields, code: z.string().trim().regex(/^\d{6}$/) })

/** Consent must be ticked, and any wording the client echoes must be ours. */
function assertConsent(body: { consent?: boolean; consentText?: string | null }): void {
  if (body.consent !== true) {
    throw new AppError('CONSENT_REQUIRED', 'Tick the box to agree to be messaged about new brands.', 400)
  }
  if (body.consentText && body.consentText.trim() !== WAITLIST_CONSENT_TEXT) {
    throw new AppError('CONSENT_MISMATCH', 'The consent wording has changed — reload the page and try again.', 422)
  }
}

/** otp.ts errors → the waitlist form's codes (INVALID_CODE / CODE_EXPIRED / 429). */
function codeError(err: unknown): unknown {
  if (!(err instanceof AppError)) return err
  if (err.code === 'OTP_WRONG') return new AppError('INVALID_CODE', err.message, 400)
  if (err.code === 'OTP_EXPIRED' || err.code === 'OTP_NOT_FOUND') {
    return new AppError('CODE_EXPIRED', 'That code has expired — request a new one.', 400)
  }
  if (err.code === 'OTP_LOCKED') return new AppError('CODE_LOCKED', err.message, 429)
  return err
}

function phoneOf(raw: string): string {
  const phone = normalisePhone(raw)
  if (!/^\d{11,15}$/.test(phone)) throw new AppError('INVALID_PHONE', 'Enter a valid WhatsApp number.', 400)
  return phone
}

/** Stored spellings of one number — older rows may carry +92… or 03…. */
function phoneVariants(n: string): string[] {
  const v = [n, `+${n}`]
  if (n.startsWith('92')) v.push(`0${n.slice(2)}`)
  return v
}

function maskForList(phone: string | null): string | null {
  if (!phone) return null
  return phone.length <= 6 ? '••••' : `${phone.slice(0, 4)}${'•'.repeat(phone.length - 6)}${phone.slice(-2)}`
}

/** Staff gate: module crm or campaigns (the CEO has every module). */
async function requireWaitlistModule(req: FastifyRequest, _reply: FastifyReply) {
  const mods = await staffModules(req)
  if (!mods.has('crm') && !mods.has('campaigns')) {
    throw new ForbiddenError('Your account does not have access to the CRM module. Ask the CEO to enable it in Module Access.')
  }
}
const STAFF = { preHandler: [requireAuth(), requireWaitlistModule] }

const listQuery = z.object({
  q:      z.string().trim().max(100).optional(),
  source: z.string().max(40).optional(),
  from:   z.string().max(40).optional(),
  to:     z.string().max(40).optional(),
  page:   z.coerce.number().int().min(1).max(10_000).optional(),
})

function dateOrThrow(s: string, field: string): Date {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) throw new AppError('INVALID_DATE', `${field} is not a date`, 400)
  return d
}

function signupWhere(q: z.infer<typeof listQuery>): Prisma.WaitlistSignupWhereInput {
  const createdAt: Prisma.DateTimeFilter = {}
  if (q.from) createdAt.gte = dateOrThrow(q.from, 'from')
  if (q.to) {
    // A bare date means "through the end of that day".
    const end = dateOrThrow(q.to, 'to')
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) createdAt.lt = new Date(end.getTime() + 24 * 60 * 60_000)
    else createdAt.lte = end
  }
  const source = q.source ? (q.source === 'direct' ? null : sanitiseSource(q.source)) : undefined
  return {
    list: WAITLIST_LIST,
    ...(source !== undefined && { source }),
    ...(Object.keys(createdAt).length > 0 && { createdAt }),
    customer: {
      deletedAt: null,
      ...(q.q && {
        OR: [
          { name: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
          { phone: { contains: q.q.replace(/\D/g, '') || q.q } },
        ],
      }),
    },
  }
}

const signupSelect = {
  id: true, area: true, interest: true, source: true, createdAt: true, unsubscribedAt: true, customerId: true,
  customer: { select: { name: true, phone: true, email: true } },
} as const

type SignupRow = Prisma.WaitlistSignupGetPayload<{ select: typeof signupSelect }>

function shapeRow(r: SignupRow, fullPhone: boolean) {
  return {
    id: r.id,
    name: r.customer.name,
    phone: fullPhone ? r.customer.phone : maskForList(r.customer.phone),
    email: r.customer.email,
    area: r.area,
    interest: r.interest,
    source: r.source,
    createdAt: r.createdAt,
    unsubscribedAt: r.unsubscribedAt,
    customerId: r.customerId,
  }
}

function csvCell(v: unknown, guard = true): string {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v)
  // Spreadsheet formula injection: free text typed by the public.
  if (guard && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function waitlistRoutes(fastify: FastifyInstance) {
  // POST /waitlist/visit — one anonymous page view. No IP, UA, name or phone
  // is stored: only where the click came from, the device class and country.
  fastify.post('/visit', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = z.object({ source: z.string().max(200).optional().nullable() }).passthrough()
      .parse(req.body ?? {})
    const cc = req.headers['cf-ipcountry']
    const country = typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc) && cc.toUpperCase() !== 'XX' ? cc.toUpperCase() : null
    await prisma.waitlistVisit.create({
      data: {
        list: WAITLIST_LIST,
        source: sanitiseSource(body.source),
        device: deviceFromUserAgent(req.headers['user-agent']),
        country,
      },
    })
    return reply.status(204).send()
  })

  // POST /waitlist/request-code — sends a 6-digit WhatsApp code through the
  // shared customer code store (auth/otp.ts, purpose 'waitlist').
  fastify.post('/request-code', async (req, reply) => {
    refuseCodeRequestInPractice('waitlist') // practice copy: nothing is sent (lib/sandbox.ts)
    const body = requestCodeSchema.parse(req.body)
    assertConsent(body)
    const phone = phoneOf(body.phone)
    const ipKey = req.ip ?? 'unknown'
    const phoneKey = `phone:${phone}`
    await checkRateLimit(CODE_IP_LIMIT, ipKey)
    await checkRateLimit(CODE_PHONE_LIMIT, phoneKey)
    await requestOtp({ phone, purpose: 'waitlist' })
    await Promise.all([recordFailure(CODE_IP_LIMIT, ipKey), recordFailure(CODE_PHONE_LIMIT, phoneKey)])
    return reply.status(200).send({ sent: true, phoneHint: maskPhone(phone) })
  })

  // POST /waitlist/join — verifies the code, then files the person into the
  // customer master and onto the list. No session is created.
  fastify.post('/join', async (req, reply) => {
    const body = joinSchema.parse(req.body)
    assertConsent(body)
    const phone = phoneOf(body.phone)
    const ipKey = req.ip ?? 'unknown'
    await checkRateLimit(JOIN_IP_LIMIT, ipKey)
    try {
      await verifyOtp({ phone, code: body.code, purpose: 'waitlist' })
    } catch (err) {
      await recordFailure(JOIN_IP_LIMIT, ipKey)
      throw codeError(err)
    }

    const email = body.email ? normaliseEmail(body.email) : null
    const name = body.name.trim()
    const now = new Date()
    const source = sanitiseSource(body.source)

    const result = await prisma.$transaction(async (tx) => {
      let customer = await tx.customer.findFirst({
        where: { phone: { in: phoneVariants(phone) }, deletedAt: null },
        select: { id: true, name: true, email: true, phone: true, phoneVerifiedAt: true },
      })
      // The email may belong to someone already on file. Use that record only
      // if it carries no phone (or this one); never hand one person's record
      // to another number, and never take an email someone else holds.
      const emailOwner = email
        ? await tx.customer.findFirst({
            where: { email, deletedAt: null },
            select: { id: true, name: true, email: true, phone: true, phoneVerifiedAt: true },
          })
        : null
      if (!customer && emailOwner && (!emailOwner.phone || phoneVariants(phone).includes(emailOwner.phone))) {
        customer = emailOwner
      }
      const emailFree = !emailOwner || emailOwner.id === customer?.id

      if (customer) {
        const data: Prisma.CustomerUpdateInput = {}
        if (!customer.phone) data.phone = phone
        if (!customer.phoneVerifiedAt) data.phoneVerifiedAt = now
        if (!customer.name.trim()) data.name = name
        if (!customer.email && email && emailFree) data.email = email
        if (Object.keys(data).length > 0) await tx.customer.update({ where: { id: customer.id }, data })
      } else {
        customer = await tx.customer.create({
          data: { name, phone, phoneVerifiedAt: now, ...(email && emailFree && { email }) },
          select: { id: true, name: true, email: true, phone: true, phoneVerifiedAt: true },
        })
      }

      const existing = await tx.waitlistSignup.findUnique({
        where: { list_customerId: { list: WAITLIST_LIST, customerId: customer.id } },
        select: { id: true, unsubscribedAt: true, source: true },
      })
      const fields = {
        consentText: WAITLIST_CONSENT_TEXT,
        consentAt: now,
        verifiedAt: now,
        ...(body.area && { area: body.area }),
        ...(body.interest && { interest: body.interest }),
      }
      if (existing) {
        // Rejoining clears only the waitlist's own unsubscribe. A marketing
        // opt-out (Customer.marketingOptOutAt) is left alone and still wins
        // for campaigns. The first source keeps the attribution.
        await tx.waitlistSignup.update({
          where: { id: existing.id },
          data: { ...fields, unsubscribedAt: null, ...(!existing.source && source && { source }) },
        })
      } else {
        await tx.waitlistSignup.create({
          data: { ...fields, list: WAITLIST_LIST, customerId: customer.id, source },
        })
      }
      return { alreadyOnList: !!existing && existing.unsubscribedAt === null }
    })

    return reply.status(200).send({ joined: true, alreadyOnList: result.alreadyOnList })
  })

  // POST /waitlist/unsubscribe — the link target. Leaves the waitlist only.
  fastify.post('/unsubscribe', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(300) }).parse(req.body)
    const id = readUnsubscribeToken(token)
    if (!id) throw new AppError('INVALID_TOKEN', 'This unsubscribe link is not valid.', 400)
    const n = await prisma.waitlistSignup.updateMany({
      where: { id, unsubscribedAt: null },
      data: { unsubscribedAt: new Date() },
    })
    if (n.count === 0) {
      const exists = await prisma.waitlistSignup.count({ where: { id } })
      if (!exists) throw new AppError('INVALID_TOKEN', 'This unsubscribe link is not valid.', 400)
    }
    return reply.status(200).send({ unsubscribed: true })
  })

  // GET /waitlist/stats
  fastify.get('/stats', STAFF, async () => {
    const list = WAITLIST_LIST
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000)
    const [signups, active, visits, visitsBySource, signupsBySource, byDevice, dailyVisits, dailySignups] = await Promise.all([
      prisma.waitlistSignup.count({ where: { list } }),
      prisma.waitlistSignup.count({ where: { list, unsubscribedAt: null } }),
      prisma.waitlistVisit.count({ where: { list } }),
      prisma.waitlistVisit.groupBy({ by: ['source'], where: { list }, _count: { _all: true } }),
      prisma.waitlistSignup.groupBy({ by: ['source'], where: { list }, _count: { _all: true } }),
      prisma.waitlistVisit.groupBy({ by: ['device'], where: { list }, _count: { _all: true } }),
      // Days in Karachi time (UTC+5, no DST).
      prisma.$queryRaw<Array<{ d: string; n: number }>>`
        SELECT to_char("createdAt" + interval '5 hours', 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
        FROM waitlist_visits WHERE list = ${list} AND "createdAt" >= ${since} GROUP BY 1`,
      prisma.$queryRaw<Array<{ d: string; n: number }>>`
        SELECT to_char("createdAt" + interval '5 hours', 'YYYY-MM-DD') AS d, COUNT(*)::int AS n
        FROM waitlist_signups WHERE list = ${list} AND "createdAt" >= ${since} GROUP BY 1`,
    ])

    const sources = new Map<string, { source: string; visits: number; signups: number }>()
    const bucket = (s: string | null) => {
      const k = s ?? 'direct'
      if (!sources.has(k)) sources.set(k, { source: k, visits: 0, signups: 0 })
      return sources.get(k)!
    }
    for (const r of visitsBySource) bucket(r.source).visits += r._count._all
    for (const r of signupsBySource) bucket(r.source).signups += r._count._all

    const vByDay = new Map(dailyVisits.map((r) => [r.d, Number(r.n)]))
    const sByDay = new Map(dailySignups.map((r) => [r.d, Number(r.n)]))
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(Date.now() + 5 * 60 * 60_000 - (6 - i) * 24 * 60 * 60_000).toISOString().slice(0, 10)
      return { date, visits: vByDay.get(date) ?? 0, signups: sByDay.get(date) ?? 0 }
    })

    return {
      signups,
      // Every row is WhatsApp-verified (no unverified sign-ups are stored);
      // `active` is those still on the list.
      verified: signups,
      active,
      unsubscribed: signups - active,
      visits,
      conversionPct: visits > 0 ? Math.round((signups / visits) * 1000) / 10 : 0,
      bySource: [...sources.values()].sort((a, b) => b.signups - a.signups || b.visits - a.visits),
      byDevice: byDevice.map((r) => ({ device: r.device ?? 'unknown', visits: r._count._all })),
      last7Days,
    }
  })

  // GET /waitlist/signups — full numbers for the crm module; campaigns-only
  // accounts see them masked.
  fastify.get('/signups', STAFF, async (req) => {
    const q = listQuery.parse(req.query)
    const page = q.page ?? 1
    const where = signupWhere(q)
    const fullPhone = (await staffModules(req)).has('crm')
    const [total, rows] = await Promise.all([
      prisma.waitlistSignup.count({ where }),
      prisma.waitlistSignup.findMany({
        where, select: signupSelect, orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      }),
    ])
    return { rows: rows.map((r) => shapeRow(r, fullPhone)), total, page, pageSize: PAGE_SIZE }
  })

  // GET /waitlist/signups.csv — same filters.
  fastify.get('/signups.csv', STAFF, async (req, reply) => {
    const q = listQuery.parse(req.query)
    const fullPhone = (await staffModules(req)).has('crm')
    const rows = await prisma.waitlistSignup.findMany({
      where: signupWhere(q), select: signupSelect, orderBy: { createdAt: 'desc' }, take: CSV_MAX_ROWS,
    })
    const header = ['name', 'phone', 'email', 'area', 'interest', 'source', 'joined_at', 'unsubscribed_at', 'customer_id']
    const lines = rows.map((r) => {
      const s = shapeRow(r, fullPhone)
      return [
        csvCell(s.name), csvCell(s.phone, false), csvCell(s.email), csvCell(s.area), csvCell(s.interest),
        csvCell(s.source), csvCell(s.createdAt), csvCell(s.unsubscribedAt), csvCell(s.customerId),
      ].join(',')
    })
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="servd-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send([header.join(','), ...lines].join('\n') + '\n')
  })
}
