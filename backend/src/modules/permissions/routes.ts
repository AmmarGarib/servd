import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, ALL_STAFF, CASHIERS } from '../auth/middleware.js'
import {
  DEFAULT_MODULE_ACCESS,
  MODULE_IDS,
  isKnownModuleId,
  isRetiredModuleId,
  knownModulesOnly,
  invalidateModuleAccessCache,
  effectiveModulesForUser,
} from '../../lib/moduleAccess.js'
import { ALL_ROLES, ASSIGNABLE_ROLES, LEGACY_ROLES, OVERRIDE_APPROVERS } from '../../lib/roles.js'
import { audit } from '../../lib/audit.js'
import { WORKSPACES, workspacesForUser, childRolesFor } from '../../lib/workspaces.js'

// ── Access control is MODULE ACCESS (owner decision 34, 2026-09-27) ─────────
//
// The per-action permission matrix (/permissions/matrix, /catalogue, /reset,
// requirePermission, the Workforce per-user action chips) is gone. It enforced
// nothing: requirePermission had no caller, so unticking "orders:refund" for a
// role changed no behaviour anywhere — a UI promise with no enforcement, which
// is worse than having no switch at all. It also had no 'owner' column.
//
// What remains, and is enforced:
//   • module access — role defaults + the CEO's per-role overrides + per-user
//     moduleAllow/moduleDeny, checked by the auth middleware on the gated
//     prefixes (lib/moduleAccess.ts);
//   • role arrays on each route (requireAuth(...MANAGERS) etc.) for hard gates.
//
// The role_permissions table and the permissionAllow/permissionDeny columns
// are kept (history); nothing reads them.

/** Roles whose module list the CEO may edit: every role except the CEO seat. */
const EDITABLE_ROLES = ALL_ROLES.filter((r) => r !== 'admin')

export async function permissionRoutes(fastify: FastifyInstance) {
  // GET /permissions/me — who am I and which modules do I have.
  //
  // `modules` is the caller's EFFECTIVE set from the same resolver the API
  // enforces with (role override ?? role default, plus this user's
  // moduleAllow, minus moduleDeny). The sidebar should render from this for
  // the real user instead of recomputing from a browser-side copy.
  fastify.get('/me', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const me = await prisma.user.findUnique({
      where:  { id: req.staffUser!.id },
      select: { role: true, moduleAllow: true, moduleDeny: true },
    })
    const role = me?.role ?? req.staffUser!.role
    const modules = await effectiveModulesForUser({
      role,
      moduleAllow: me?.moduleAllow ?? [],
      moduleDeny:  me?.moduleDeny ?? [],
    })
    return {
      role,
      modules: Array.from(modules),
      // Decision 47: the workspaces this caller can see (sections narrowed to
      // modules they hold) and which roles they may invite logins for.
      workspaces: workspacesForUser(role, modules),
      childRoles: childRolesFor(role),
    }
  })

  // GET /permissions/workspaces — the full workspace definition, for the
  // Modules page. lib/workspaces.ts is the only copy.
  fastify.get('/workspaces', { preHandler: requireAuth(...ALL_STAFF) }, async () =>
    WORKSPACES.map((w) => ({ id: w.id, title: w.title, ownerRoles: w.ownerRoles, memberRoles: w.memberRoles, sections: w.sections })))

  // GET /permissions/role-modules — everything the admin needs to render
  // module visibility for ANY role (the CEO's view-as switcher and the Module
  // Access editor), all from the server:
  //   defaults  — the in-code baselines the API enforces
  //   overrides — the CEO's saved rows (full allow-list per role)
  //   modules   — every valid module id
  //   roles     — which roles exist / may be assigned / may be edited here /
  //               may approve with a manager PIN
  // Open to all staff so every admin browser renders the same rules.
  fastify.get('/role-modules', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    const rows = await prisma.roleModuleAccess.findMany({ select: { role: true, modules: true } })
    return {
      defaults:  DEFAULT_MODULE_ACCESS,
      overrides: Object.fromEntries(rows.map((r) => [r.role, knownModulesOnly(r.modules)])),
      modules:   MODULE_IDS,
      roles: {
        all:        ALL_ROLES,
        assignable: ASSIGNABLE_ROLES,
        editable:   EDITABLE_ROLES,
        legacy:     LEGACY_ROLES,
        overrideApprovers: OVERRIDE_APPROVERS,
        // Who may print a bill (the /pos receipt routes' guard) — the admin's
        // Reprint button reads this instead of keeping its own list.
        cashiers: CASHIERS,
      },
    }
  })

  // PUT /permissions/role-modules — CEO saves one role's full allow-list.
  // `modules: null` resets the role back to defaults (deletes the row).
  // Any role except admin — including 'owner', which the old hand-kept role
  // list left out, so the owner column never actually saved.
  fastify.put('/role-modules', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      role:    z.string().refine((v) => (ALL_ROLES as readonly string[]).includes(v), 'Unknown role'),
      modules: z.array(z.string()).nullable(),
    }).parse(req.body)

    if (body.role === 'admin') {
      return reply.status(400).send({ error: { code: 'ADMIN_IMMUTABLE', message: 'The CEO role always has every module — it cannot be edited.' } })
    }
    let modules: string[] | null = null
    if (body.modules) {
      // Retired ids (from rows saved before they were removed) are dropped
      // quietly so an old row can still be edited; anything else unknown is a
      // typo and is refused.
      const unknown = body.modules.filter((m) => !isKnownModuleId(m) && !isRetiredModuleId(m))
      if (unknown.length) {
        return reply.status(400).send({ error: { code: 'UNKNOWN_MODULE', message: `Unknown module id(s): ${unknown.join(', ')}` } })
      }
      modules = Array.from(new Set(knownModulesOnly(body.modules)))
    }

    // Read the outgoing allow-list first — "what changed" is the whole value of
    // this entry, and after the upsert it is gone.
    const previous = await prisma.roleModuleAccess.findUnique({
      where: { role: body.role as UserRole },
      select: { modules: true },
    })

    if (modules === null) {
      await prisma.roleModuleAccess.deleteMany({ where: { role: body.role as UserRole } })
    } else {
      await prisma.roleModuleAccess.upsert({
        where:  { role: body.role as UserRole },
        create: { role: body.role as UserRole, modules },
        update: { modules },
      })
    }
    invalidateModuleAccessCache()
    // Changing what a ROLE can reach changes what every holder of that role can
    // reach, without touching a single user record — so it is invisible on the
    // staff screen and was, until now, invisible everywhere else too.
    await audit({
      category: 'identity',
      action: 'role_modules.update',
      entity: 'RoleModuleAccess',
      entityId: body.role,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      tenantId: req.staffUser?.tenantId ?? null,
      before: { modules: previous?.modules ?? null },
      after: { role: body.role, modules },
    })
    return { ok: true, role: body.role, modules }
  })
}
