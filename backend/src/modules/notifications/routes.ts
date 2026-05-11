// Notifications module — Expo push token registration.
//
// Tablet + mobile apps call `POST /notifications/register` after the user
// grants notification permission. We upsert on (userId, token) so the same
// device repeatedly registering doesn't bloat the table.
//
// Future endpoints (not yet wired):
//   - POST /notifications/broadcast — send to all tokens matching filters
//     (device=tablet, locationId=X) via expo-server-sdk
//   - DELETE /notifications/:token  — explicit unregister on sign-out
//
// For now, "register" is enough to capture the audience.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'

const registerSchema = z.object({
  token:      z.string().min(10).max(200),
  platform:   z.enum(['ios', 'android', 'web']),
  device:     z.enum(['tablet', 'mobile', 'kiosk', 'web']).default('mobile'),
  locationId: z.string().uuid().nullable().optional(),
})

export async function notificationRoutes(fastify: FastifyInstance) {
  // POST /notifications/register — upsert this device's push token.
  fastify.post('/register', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = registerSchema.parse(req.body)

    const upserted = await prisma.expoPushToken.upsert({
      where: {
        userId_token: { userId: req.staffUser!.id, token: body.token },
      },
      create: {
        userId:    req.staffUser!.id,
        token:     body.token,
        platform:  body.platform,
        device:    body.device,
        locationId: body.locationId ?? null,
      },
      update: {
        platform:  body.platform,
        device:    body.device,
        locationId: body.locationId ?? null,
        revokedAt: null,
      },
    })

    return reply.status(201).send({ id: upserted.id, registered: true })
  })

  // DELETE /notifications/register?token=... — unregister this device.
  // Useful at sign-out so a tablet shared across staff doesn't leak alerts
  // to the previous user.
  fastify.delete<{ Querystring: { token: string } }>(
    '/register',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const { token } = req.query
      if (!token) return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'token query param required' } })
      await prisma.expoPushToken.updateMany({
        where: { userId: req.staffUser!.id, token },
        data:  { revokedAt: new Date() },
      })
      return reply.status(204).send()
    },
  )
}
