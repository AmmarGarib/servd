// Notifications module — Expo push token registration + broadcast.
//
// Tablet + mobile apps call `POST /notifications/register` after the user
// grants notification permission. We upsert on (userId, token) so the same
// device repeatedly registering doesn't bloat the table.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Expo } from 'expo-server-sdk'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'

const expo = new Expo()

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

  // POST /notifications/broadcast — push to all matching Expo tokens.
  // Body filters narrow the audience; absence of a filter means "all active
  // tokens for this tenant". Results are returned per-ticket so the caller
  // can act on failures (e.g. auto-revoke DeviceNotRegistered tokens).
  const broadcastSchema = z.object({
    title:   z.string().min(1).max(200),
    body:    z.string().min(1).max(1000),
    data:    z.record(z.unknown()).optional(),
    filters: z.object({
      device:     z.enum(['tablet', 'mobile', 'kiosk', 'web']).optional(),
      locationId: z.string().uuid().optional(),
      userIds:    z.array(z.string().uuid()).min(1).optional(),
    }).optional(),
  })

  fastify.post(
    '/broadcast',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { title, body, data: pushData, filters } = broadcastSchema.parse(req.body)
      const tenantId = req.staffUser!.tenantId

      const tokenRows = await prisma.expoPushToken.findMany({
        where: {
          revokedAt: null,
          user: { tenantId },
          ...(filters?.device     && { device: filters.device }),
          ...(filters?.locationId && { locationId: filters.locationId }),
          ...(filters?.userIds    && { userId: { in: filters.userIds } }),
        },
        select: { token: true },
      })

      // Filter to syntactically valid Expo push tokens before sending
      const validTokens = tokenRows
        .map((r) => r.token)
        .filter((t) => Expo.isExpoPushToken(t))

      if (validTokens.length === 0) {
        return reply.send({ sent: 0, failed: 0, tickets: [] })
      }

      // Build message objects
      const messages = validTokens.map((pushToken) => ({
        to:    pushToken,
        sound: 'default' as const,
        title,
        body,
        data:  pushData ?? {},
      }))

      // Chunk into batches of 100 (Expo SDK recommendation)
      const chunks = expo.chunkPushNotifications(messages)
      const allTickets: object[] = []
      let sent = 0
      let failed = 0

      for (const chunk of chunks) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk)
          for (const ticket of tickets) {
            allTickets.push(ticket)
            if (ticket.status === 'ok') {
              sent++
            } else {
              failed++
            }
          }
        } catch (err) {
          // A chunk-level error (network timeout etc.) — count the whole
          // chunk as failed and carry on with remaining chunks.
          failed += chunk.length
          fastify.log.warn({ err }, '[notifications/broadcast] chunk send failed')
        }
      }

      return reply.send({ sent, failed, tickets: allTickets })
    },
  )

  // GET /notifications/tokens — list active tokens for all staff in this tenant.
  // Grouped by user so the caller can see who has registered and on what device.
  fastify.get(
    '/tokens',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId

      const tokenRows = await prisma.expoPushToken.findMany({
        where: {
          revokedAt: null,
          user: { tenantId },
        },
        select: {
          id:         true,
          userId:     true,
          device:     true,
          platform:   true,
          locationId: true,
          createdAt:  true,
          user: { select: { id: true, name: true } },
        },
        orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }],
      })

      // Group by user
      const byUser = new Map<string, { userId: string; userName: string | null; tokens: object[] }>()

      for (const row of tokenRows) {
        const key = row.userId
        if (!byUser.has(key)) {
          byUser.set(key, { userId: row.user.id, userName: row.user.name, tokens: [] })
        }
        byUser.get(key)!.tokens.push({
          id:         row.id,
          device:     row.device,
          platform:   row.platform,
          locationId: row.locationId,
          createdAt:  row.createdAt,
        })
      }

      return Array.from(byUser.values())
    },
  )
}
