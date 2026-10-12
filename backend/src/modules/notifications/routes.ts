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
import { CONNECTOR_ADMINS } from '../../lib/connectorRoles.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { staffInCompaniesWhere } from '../auth/staffAccounts.js'
import { requireModule } from './requireModule.js'

// Who runs staff push (broadcast + the device list): the managers, plus IT —
// Notifications is a Dev workspace page (module `notifications`) and IT owns
// that workspace (wave 3, UI-08). Company scope is the same for everyone.
//
// Module Access: both routes also need module `notifications` (the page's
// module), so the CEO's untick — or a per-login moduleDeny — really closes
// them (wave 3 review W3C-RV-2). Holders by default: admin, owner,
// management, manager, it. foh_management, boh_management and fnb_manager
// never had the page and are refused.
const PUSH_ADMINS = [...MANAGERS, ...CONNECTOR_ADMINS]
const pushGuard = [requireAuth(...PUSH_ADMINS), requireModule('notifications')]

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
    { preHandler: pushGuard },
    async (req, reply) => {
      const { title, body, data: pushData, filters } = broadcastSchema.parse(req.body)
      // A broadcast goes to the ACTIVE company's staff only (primary company
      // or a membership) — never every company the sender belongs to. No
      // active company → nobody (`in: []`), never "no filter".
      const active = req.staffUser!.tenantId
      const narrow = {
        revokedAt: null,
        ...(filters?.device     && { device: filters.device }),
        ...(filters?.locationId && { locationId: filters.locationId }),
        ...(filters?.userIds    && { userId: { in: filters.userIds } }),
      }

      const tokenRows = await prisma.expoPushToken.findMany({
        where: { ...narrow, user: staffInCompaniesWhere(active ? [active] : [], false) },
        select: { token: true },
      })

      // The device list (GET /tokens) is view-aware, so in "All companies"
      // view it counts the sender's OTHER companies' devices too. Say who was
      // reached and how many matching devices in those other companies were
      // not, so the screen never implies a reach it did not have (W3C-RV-4).
      // Counted only over companies the sender belongs to — nothing about a
      // company outside their memberships is revealed.
      const others = req.staffUser!.memberTenantIds.filter((id) => id !== active)
      const [company, skippedOtherCompanies] = await Promise.all([
        active ? prisma.tenant.findUnique({ where: { id: active }, select: { id: true, name: true } }) : null,
        others.length === 0 ? 0 : prisma.expoPushToken.count({
          where: {
            ...narrow,
            user: { AND: [staffInCompaniesWhere(others, false), { NOT: staffInCompaniesWhere(active ? [active] : [], false) }] },
          },
        }),
      ])
      const audience = { company: company ?? null, skippedOtherCompanies }

      // Filter to syntactically valid Expo push tokens before sending
      const validTokens = tokenRows
        .map((r) => r.token)
        .filter((t) => Expo.isExpoPushToken(t))

      if (validTokens.length === 0) {
        return reply.send({ sent: 0, failed: 0, tickets: [], ...audience })
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

      return reply.send({ sent, failed, tickets: allTickets, ...audience })
    },
  )

  // GET /notifications/tokens — list active tokens for all staff in this tenant.
  // Grouped by user so the caller can see who has registered and on what device.
  fastify.get(
    '/tokens',
    { preHandler: pushGuard },
    async (req) => {
      // Read scope (view-aware): staff of the active company, or of every
      // company the operator belongs to in "All companies" view. An empty
      // scope lists nobody.
      const scope = await resolveTenantScope(req)

      const tokenRows = await prisma.expoPushToken.findMany({
        where: {
          revokedAt: null,
          user: staffInCompaniesWhere(scope.tenantIds, false),
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
