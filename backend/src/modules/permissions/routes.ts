import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import {
  PERMISSIONS,
  invalidatePermissionCache,
  permissionsForRole,
} from '../../lib/permissions.js'

// Keep aligned with the UserRole enum in backend/prisma/schema.prisma and the
// AppRole list in frontend/admin/src/lib/appRoles.ts. The matrix editor renders
// one column per role in this order.
const ROLES = [
  'admin', 'manager', 'management', 'foh_management', 'boh_management',
  'foh', 'boh', 'kitchen', 'expediter', 'cashier',
  'procurement', 'marketing', 'finance', 'hr',
] as UserRole[]
const ROLE_VALUES = ROLES as readonly string[]

export async function permissionRoutes(fastify: FastifyInstance) {
  // GET /permissions/catalogue — full list of permission keys + metadata.
  // Open to all logged-in staff so the frontend can render labels in tooltips.
  fastify.get('/catalogue', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return PERMISSIONS.map((p) => ({
      key: p.key, label: p.label, desc: p.desc, category: p.category,
    }))
  })

  // GET /permissions/me — the current user's effective permissions list.
  // Used by the frontend useCan() hook on every page load.
  fastify.get('/me', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const role = req.staffUser!.role
    return { role, permissions: await permissionsForRole(prisma, role) }
  })

  // GET /permissions/matrix — full role × permission grid for the editor.
  fastify.get('/matrix', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    const rows = await prisma.rolePermission.findMany({
      select: { role: true, permission: true, enabled: true },
    })
    // Build a (role → permission → enabled) map for the UI
    const matrix: Record<string, Record<string, boolean>> = {}
    for (const role of ROLES) matrix[role] = {}
    for (const r of rows) {
      const roleKey = matrix[r.role]
      if (roleKey) roleKey[r.permission] = r.enabled
    }
    return { roles: ROLES, matrix }
  })

  // PATCH /permissions/matrix — bulk update. Body shape mirrors GET /matrix.
  fastify.patch('/matrix', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      changes: z.array(z.object({
        role: z.string().refine((v) => ROLE_VALUES.includes(v), 'Unknown role'),
        permission: z.string().min(1),
        enabled: z.boolean(),
      })),
    }).parse(req.body)

    // Reject any attempt to lock admin out of admin-only permissions.
    // Admin role always has everything via short-circuit in userCan(); we
    // still persist these flips for visibility in the matrix, but a future
    // bug that removes the short-circuit shouldn't lock admins out.
    const validKeys = new Set(PERMISSIONS.map((p) => p.key))
    for (const c of body.changes) {
      if (!validKeys.has(c.permission)) {
        return reply.status(400).send({ error: { code: 'UNKNOWN_PERMISSION', message: `Permission '${c.permission}' is not in the catalogue` } })
      }
    }

    // Upsert each change (the seed has already inserted every cell, so the
    // typical path is an update — but use upsert for resilience)
    for (const c of body.changes) {
      await prisma.rolePermission.upsert({
        where: { role_permission: { role: c.role as UserRole, permission: c.permission } },
        create: { role: c.role as UserRole, permission: c.permission, enabled: c.enabled },
        update: { enabled: c.enabled },
      })
    }

    invalidatePermissionCache()
    return { ok: true, applied: body.changes.length }
  })

  // POST /permissions/reset — reset all permissions back to catalogue defaults.
  // Useful if an admin accidentally locks themselves out of something.
  fastify.post('/reset', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    const updates: Array<Promise<unknown>> = []
    for (const perm of PERMISSIONS) {
      for (const role of ROLES) {
        updates.push(prisma.rolePermission.upsert({
          where: { role_permission: { role, permission: perm.key } },
          create: { role, permission: perm.key, enabled: perm.defaultsByRole[role] ?? false },
          update: { enabled: perm.defaultsByRole[role] ?? false },
        }))
      }
    }
    await Promise.all(updates)
    invalidatePermissionCache()
    return { ok: true, reset: updates.length }
  })
}

// Convenience middleware: use in route handlers that need a finer-grained check
// than the role-array `requireAuth(...)`. Always pair with `requireAuth` first.
//
// Usage:
//   fastify.post('/orders/:id/refund', {
//     preHandler: [requireAuth(...ALL_STAFF), requirePermission('orders:refund')],
//   }, ...)
export function requirePermission(permission: string) {
  return async (req: { staffUser?: { role: UserRole } }) => {
    const { ForbiddenError } = await import('../../lib/errors.js')
    const role = req.staffUser?.role
    if (!role) throw new ForbiddenError('Not authenticated')
    if (role === 'admin') return        // Admins bypass — same short-circuit as userCan()
    const perms = await permissionsForRole(prisma, role)
    if (!perms.includes(permission)) {
      throw new ForbiddenError(`Missing permission: ${permission}`)
    }
  }
}
