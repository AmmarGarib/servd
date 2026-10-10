// /api/v1/rider — the rider app's API (docs/rider-app.md). Every route needs a
// rider access token (riderAuth/middleware.ts requireRider): staff and
// customer tokens are refused, and every query is pinned to the signed-in
// rider — a rider only ever reads or acts on orders with riderId = itself.
//
//   GET  /me                          { rider }
//   POST /shift { online }            on / off shift
//   GET  /jobs                        { jobs: Job[] } — oldest first
//   GET  /jobs/:orderId               { job }
//   POST /jobs/:orderId/accept        offered → accepted
//   POST /jobs/:orderId/decline       hand it back; never re-offered to me
//   POST /jobs/:orderId/picked-up     accepted → picked up (order must be ready)
//   POST /jobs/:orderId/arrived       picked up → at the door
//   POST /jobs/:orderId/deliver       the customer's code → delivered
//   POST /location                    a fix (rate limit keyed on the rider);
//                                     409 OFF_SHIFT while 'offline'
//
// Rate limits are keyed on the rider, not the IP: riders on mobile data sit
// behind carrier NAT, so an IP key would let one busy fleet lock itself out.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { requireRider, riderRateKey } from '../riderAuth/middleware.js'
import { riderPublic } from '../riderAuth/service.js'
import { offShiftError, recordRiderFix, riderFixSchema } from '../dispatch/service.js'
import {
  acceptJob, arriveJob, declineJob, deliverJob, getJob, listJobs, openJobWhere, pickUpJob, setShift,
  OtpMismatchError,
} from './service.js'

const pos = {
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
}
const posSchema = z.object(pos)

type JobParams = { Params: { orderId: string } }

/** Route-level limit, applied after the guard so it can key on the rider. */
function limit(max: number, timeWindow: string) {
  return { rateLimit: { max, timeWindow, hook: 'preHandler' as const, keyGenerator: riderRateKey } }
}

export async function riderAppRoutes(fastify: FastifyInstance) {
  // Instance-level hook: runs before every route's own preHandlers (the rate
  // limiter among them), so req.rider is set by the time anything else runs.
  fastify.addHook('preHandler', requireRider)

  fastify.get('/me', { config: limit(120, '1 minute') }, async (req) => {
    return { rider: riderPublic(req.rider!) }
  })

  fastify.post('/shift', { config: limit(30, '1 minute') }, async (req) => {
    const body = z.object({ online: z.boolean() }).parse(req.body)
    return { rider: await setShift(req.rider!, body.online) }
  })

  fastify.get('/jobs', { config: limit(120, '1 minute') }, async (req) => {
    return { jobs: await listJobs(req.rider!.id) }
  })

  fastify.get<JobParams>('/jobs/:orderId', { config: limit(120, '1 minute') }, async (req) => {
    return { job: await getJob(req.rider!.id, req.params.orderId) }
  })

  fastify.post<JobParams>('/jobs/:orderId/accept', { config: limit(60, '1 minute') }, async (req) => {
    const body = posSchema.parse(req.body ?? {})
    return { job: await acceptJob(req.rider!, req.params.orderId, body) }
  })

  fastify.post<JobParams>('/jobs/:orderId/decline', { config: limit(60, '1 minute') }, async (req) => {
    const body = z.object({ reason: z.string().trim().max(300).optional(), ...pos }).parse(req.body ?? {})
    await declineJob(req.rider!, req.params.orderId, body)
    return { ok: true }
  })

  fastify.post<JobParams>('/jobs/:orderId/picked-up', { config: limit(60, '1 minute') }, async (req) => {
    const body = posSchema.parse(req.body ?? {})
    return { job: await pickUpJob(req.rider!, req.params.orderId, body) }
  })

  fastify.post<JobParams>('/jobs/:orderId/arrived', { config: limit(60, '1 minute') }, async (req) => {
    const body = posSchema.parse(req.body ?? {})
    return { job: await arriveJob(req.rider!, req.params.orderId, body) }
  })

  fastify.post<JobParams>('/jobs/:orderId/deliver', { config: limit(30, '1 minute') }, async (req, reply) => {
    const body = z.object({ otp: z.string().trim().min(1).max(8), ...pos }).parse(req.body)
    try {
      return await deliverJob(req.rider!, req.params.orderId, body)
    } catch (err) {
      if (err instanceof OtpMismatchError) {
        // attemptsLeft at the top of the error as well as in details, so a
        // client reading either finds it.
        return reply.status(403).send({
          error: { code: err.code, message: err.message, attemptsLeft: err.attemptsLeft, details: { attemptsLeft: err.attemptsLeft } },
        })
      }
      throw err
    }
  })

  // POST /rider/location — the signed-in rider's own fix. Same validation as
  // the staff relay (/dispatch/riders/:id/location). ~1/sec ceiling per rider.
  // Off shift ('offline'): nothing is stored and the answer is 409 OFF_SHIFT —
  // both clients stop sharing on it. The guard read the rider's status on this
  // request; recordRiderFix claims it again as it writes.
  fastify.post('/location', { config: limit(600, '10 minutes') }, async (req) => {
    const rider = req.rider!
    if (rider.status === 'offline') throw offShiftError()
    const body = riderFixSchema.parse(req.body)
    // A fix may only be pinned to an order this rider is carrying right now.
    if (body.orderId) {
      const order = await prisma.order.findFirst({
        where: { id: body.orderId, ...openJobWhere(rider.id) },
        select: { id: true },
      })
      if (!order) throw new AppError('ORDER_NOT_ASSIGNED', 'That order is not one of your jobs', 422)
    }
    return recordRiderFix(rider, body, { onShiftOnly: true })
  })
}
