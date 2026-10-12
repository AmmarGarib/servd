// /time-clock — punching in and out, and the punch report.
//
//   POST /time-clock/punch-in   (alias /clock-in)   the signed-in person clocks in
//   POST /time-clock/punch-out  (alias /clock-out)  …and out
//   GET  /time-clock/status                          open punch + today's punches (tablet)
//   POST /time-clock/kiosk/punch                     staff WITHOUT a login: employee code + PIN
//   GET  /time-clock/logs?date=YYYY-MM-DD            the day's punches next to attendance (managers, HR)
//
// Every punch goes through service.ts, which writes the ClockLog punch log AND
// the day's HR attendance record. /auth/clock-in and /auth/clock-out should
// delegate to clockIn / clockOut here (see the report) so there is one path.

import type { FastifyInstance } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { pktToday } from '../hr/logic.js'
import { clockIn, clockOut, kioskPunch, openClockIn, punchReport, spans, type Actor } from './service.js'

const PUNCH_REPORT_ROLES = Array.from(new Set([...MANAGERS, 'hr'])) as UserRole[]

const punchBody = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  selfieUrl: z.string().url().max(1000).optional(),
})

const tenantIdsOf = (w: Awaited<ReturnType<typeof scopeTenantWhere>>) => (typeof w.tenantId === 'string' ? [w.tenantId] : w.tenantId.in)

export async function timeClockRoutes(fastify: FastifyInstance) {
  const actor = (req: { staffUser?: { id: string; role: string; tenantId: string | null; name?: string | null } }): Actor => {
    const u = req.staffUser!
    return { id: u.id, role: u.role, tenantId: u.tenantId, name: u.name ?? null }
  }

  for (const path of ['/punch-in', '/clock-in']) {
    fastify.post(path, { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
      const r = await clockIn(actor(req), punchBody.parse(req.body ?? {}), req.ip)
      return reply.status('alreadyClockedIn' in r ? 200 : 201).send(r)
    })
  }
  for (const path of ['/punch-out', '/clock-out']) {
    fastify.post(path, { preHandler: requireAuth(...ALL_STAFF) }, async (req) =>
      clockOut(actor(req), punchBody.parse(req.body ?? {}), req.ip))
  }

  // GET /time-clock/status — the tablet's Time clock tab. Staff see their own
  // punches; managers and HR see everyone's in the company today.
  fastify.get('/status', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const me = actor(req)
    const today = pktToday().toISOString().slice(0, 10)
    const tenantIds = me.tenantId ? [me.tenantId] : []
    const rows = tenantIds.length ? await punchReport(tenantIds, today) : []
    const seeAll = PUNCH_REPORT_ROLES.includes(me.role as UserRole)
    const shiftsOf = (r: (typeof rows)[number]) => spans(r.punches).map((s, i) => ({
      id: `${r.key}:${i}`, staffId: r.userId ?? r.employeeId ?? r.key, staffName: r.name,
      clockInAt: s.inAt, clockOutAt: s.outAt, geofenceOk: s.geofenceOk, selfieUrl: s.selfieUrl,
    }))
    const mine = rows.find((r) => r.userId === me.id)
    const myShifts = mine ? shiftsOf(mine) : []
    // Punched in = what a clock-in would see (service.ts openClockIn): an in
    // from last night still counts, a forgotten one from yesterday does not
    // — then clock-in opens today and the missed day is flagged for HR.
    const openIn = await openClockIn(me.id)
    const punchedIn = !!openIn && !openIn.missed
    const since = openIn?.since.toISOString()
    const open = punchedIn
      ? myShifts.find((s) => !s.clockOutAt && s.clockInAt === since)
        ?? { id: `${me.id}:open`, staffId: me.id, staffName: me.name ?? '', clockInAt: since!, clockOutAt: null, geofenceOk: true, selfieUrl: null }
      : undefined
    return {
      punchedIn,
      shift: open ?? myShifts.filter((s) => s.clockOutAt).pop() ?? myShifts[myShifts.length - 1],
      missedClockOut: openIn?.missed ? { since: openIn.since } : null,
      todayShifts: (seeAll ? rows.flatMap(shiftsOf) : myShifts).sort((a, b) => b.clockInAt.localeCompare(a.clockInAt)),
    }
  })

  // POST /time-clock/kiosk/punch — the shared kiosk. The device is signed in
  // (so the company is known); the person is identified by their HR employee
  // code and kiosk PIN. In when their day is not open, out when it is.
  fastify.post('/kiosk/punch', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = punchBody.extend({
      employeeCode: z.string().min(1).max(40),
      pin: z.string().min(4).max(12),
      action: z.enum(['in', 'out']).optional(),
    }).parse(req.body)
    return kioskPunch(actor(req), body)
  })

  // GET /time-clock/logs — the day's punches (selfie, geofence verdict) next
  // to the attendance record each produced. Company-scoped; replaces the
  // unscoped /auth/clock-logs shift report.
  fastify.get<{ Querystring: { date?: string } }>('/logs', { preHandler: requireAuth(...PUNCH_REPORT_ROLES) }, async (req) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date! : pktToday().toISOString().slice(0, 10)
    const tenantIds = tenantIdsOf(await scopeTenantWhere(req, 'read'))
    return { date, rows: await punchReport(tenantIds, date) }
  })
}
