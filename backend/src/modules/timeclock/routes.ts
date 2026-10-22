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
import { prisma } from '../../lib/prisma.js'
import { z } from 'zod'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { pktToday } from '../hr/logic.js'
import { getSettings } from '../hr/service.js'
import { onOfficeNetwork } from '../../lib/officeNetwork.js'
import { clockIn, clockOut, kioskPunch, openClockIn, punchReport, setHoldReason, spans, type Actor } from './service.js'

const PUNCH_REPORT_ROLES = Array.from(new Set([...MANAGERS, 'hr'])) as UserRole[]

const punchBody = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  selfieUrl: z.string().url().max(1000).optional(),
  // How accurate the device says its reading is (metres); worse than 50 m cannot place a punch inside a fence.
  accuracyM: z.number().min(0).max(100_000).optional(),
  // Why the person is outside their work location (shown to their HOD with the held day).
  reason: z.string().trim().max(300).optional(),
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
    // Has an HR employee record in the active company: sign-in checks only these people in (owner, 2026-10-22).
    const myEmp = me.tenantId ? await prisma.hrEmployee.findFirst({ where: { userId: me.id, tenantId: me.tenantId, status: { in: ['active', 'on_leave'] } }, select: { id: true } }) : null
    const hrLinked = !!myEmp
    // Today's (or last night's) day of mine waiting for my manager — an out-of-area punch (owner, 2026-10-22).
    const heldRec = myEmp ? await prisma.hrRecord.findFirst({
      where: { tenantId: me.tenantId!, section: 'attendance', employeeId: myEmp.id, status: 'submitted', startDate: { gte: new Date(pktToday().getTime() - 86_400_000) } },
      orderBy: { startDate: 'desc' }, select: { id: true, data: true },
    }) : null
    const hold = (heldRec?.data as Record<string, unknown> | undefined)?.['_outOfAreaHold'] as { punches?: Array<{ reason: string | null }> } | undefined
    const heldDay = heldRec && hold?.punches?.length ? { recordId: heldRec.id, hasReason: hold.punches.every((p) => !!p.reason) } : null
    // On a registered office network: only then does the admin check people in by itself (owner, 2026-10-22).
    const officeNetwork = !!me.tenantId && onOfficeNetwork(req.ip, (await getSettings(me.tenantId)).officeNetworks)
    return {
      punchedIn,
      hrLinked,
      onOfficeNetwork: officeNetwork,
      heldDay,
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
    return kioskPunch(actor(req), body, req.ip)
  })

  // POST /time-clock/hold-reason — the person says why a punch was outside their work location (owner,
  // 2026-10-22). Only their OWN day that is waiting for the HOD, in their active company (anything else 404). The
  // reason goes on the latest held punch that has none (or replaces the last one's).
  fastify.post('/hold-reason', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({ recordId: z.string().min(1).max(100), reason: z.string().trim().min(3).max(300) }).parse(req.body)
    return setHoldReason(actor(req), body.recordId, body.reason)
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
