import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, ALL_STAFF, CASHIERS, MANAGERS } from '../auth/middleware.js'
import {
  DEFAULT_MODULE_ACCESS,
  MODULE_IDS,
  isKnownModuleId,
  isRetiredModuleId,
  knownModulesOnly,
  withoutCeoOnlyModules,
  CEO_ONLY_MODULES,
  invalidateModuleAccessCache,
  effectiveModulesForUser,
  rolePresetModules,
} from '../../lib/moduleAccess.js'
import { ALL_ROLES, ASSIGNABLE_ROLES, LEGACY_ROLES, OVERRIDE_APPROVERS } from '../../lib/roles.js'
import { audit } from '../../lib/audit.js'
import { WORKSPACES, workspacesForUser, childRolesFor } from '../../lib/workspaces.js'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { reachTenantIds, reachVia } from '../../lib/headOffice.js'
import { liveDelegations } from '../../lib/approvalRights.js'
import { findManagedStaff, auditCompanyOf } from '../auth/staffAccounts.js'

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
      // Head office (D1/D3, spec §6 / §10): all empty / false until the CEO
      // links a head office, so today's screens are unchanged.
      ...(await headOfficeView(req)),
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
      overrides: Object.fromEntries(rows.map((r) => [r.role, withoutCeoOnlyModules(knownModulesOnly(r.modules))])),
      // Modules no role but the CEO may hold (Brands): the Module Access
      // matrix shows them locked; a save that lists them drops them.
      ceoOnlyModules: CEO_ONLY_MODULES,
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
        // The management tier (requireAuth(...MANAGERS) on manager-only
        // routes; the base of FIRE_ALL_ROLES, HR_TEAM, …). Distinct from
        // overrideApprovers (no legacy 'manager'). The admin's lib/roles.ts
        // reads it instead of keeping its own copies.
        managers: MANAGERS,
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
      // CEO-only modules (Brands) are never granted to another role: dropped
      // quietly, like a retired id, so a matrix that still shows one ticked
      // saves the rest (effectiveModulesForUser would ignore it anyway).
      modules = Array.from(new Set(withoutCeoOnlyModules(knownModulesOnly(body.modules))))
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

  // GET / PUT /permissions/users/:id/modules — the CEO's per-person ticks.
  await fastify.register(personModuleRoutes)
}

// ── Per-person module access (owner, 2026-10-15) ─────────────────────────────
//
// "Module access … is subjective not objective to role: I click on a person's
// name and select the modules they are allowed to access, but a base case can
// be preset for roles … and only I can change what they see."
//
// The role preset (PUT /role-modules) is the base case; a person's ticks are
// stored as the difference from it — moduleAllow = chosen − preset,
// moduleDeny = preset − chosen — so effectiveModulesForUser stays the ONE
// resolver the API enforces with. CEO only (ADMIN_ONLY). The target must be in
// the CEO's companies (findManagedStaff: 404 / 403 LOGIN_IN_OTHER_COMPANY). An
// admin login (the CEO's own included) always holds every module: shown
// locked, never saved. CEO-only modules (Brands) are never given to anyone else.

/** Every module the editor offers, grouped as lib/workspaces.ts places it. */
function moduleCatalogue() {
  return WORKSPACES.flatMap((w) => w.sections.flatMap((s) => s.modules.map((id) => ({
    id, workspace: w.id, workspaceTitle: w.title, section: s.key, sectionTitle: s.title,
    ceoOnly: CEO_ONLY_MODULES.includes(id),
  }))))
}

async function personModulesView(target: { role: UserRole; moduleAllow: string[]; moduleDeny: string[] }) {
  const rolePreset = await rolePresetModules(target.role)
  const effective = await effectiveModulesForUser(target)
  const presetSet = new Set(rolePreset)
  return {
    role: target.role,
    locked: target.role === 'admin',
    rolePreset,
    effective: Array.from(effective),
    allow: knownModulesOnly(target.moduleAllow).filter((m) => !presetSet.has(m)),
    deny: target.moduleDeny.filter((m) => presetSet.has(m)),
    modules: moduleCatalogue(),
  }
}

export async function personModuleRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>('/users/:id/modules', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const target = await findManagedStaff(req, req.params.id, { id: true, name: true, role: true, moduleAllow: true, moduleDeny: true })
    return { id: target.id, name: target.name, ...(await personModulesView(target)) }
  })

  fastify.put<{ Params: { id: string } }>('/users/:id/modules', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ modules: z.array(z.string().min(1)).nullable() }).strict().parse(req.body)
    const target = await findManagedStaff(req, req.params.id, { id: true, name: true, email: true, role: true, moduleAllow: true, moduleDeny: true })
    if (target.id === req.staffUser!.id || target.role === 'admin') {
      throw new AppError('CEO_HOLDS_EVERY_MODULE', 'The CEO always has every module — it cannot be changed per person.', 403)
    }
    let allow: string[] = []
    let deny: string[] = []
    if (body.modules) {
      const unknown = body.modules.filter((m) => !isKnownModuleId(m) && !isRetiredModuleId(m))
      if (unknown.length) throw new AppError('UNKNOWN_MODULE', `Unknown module id(s): ${unknown.join(', ')}`, 400)
      // Retired ids dropped quietly; CEO-only modules are never granted.
      const chosen = new Set(withoutCeoOnlyModules(knownModulesOnly(body.modules)))
      const preset = await rolePresetModules(target.role)
      const presetSet = new Set(preset)
      allow = Array.from(chosen).filter((m) => !presetSet.has(m)).sort()
      deny = preset.filter((m) => !chosen.has(m)).sort()
    }
    const before = { moduleAllow: target.moduleAllow, moduleDeny: target.moduleDeny }
    const updated = await serviceClient.user.update({
      where: { id: target.id },
      data: { moduleAllow: allow, moduleDeny: deny },
      select: { id: true, name: true, role: true, moduleAllow: true, moduleDeny: true },
    })
    // Nothing to invalidate: the per-user columns are read live on every
    // request (auth middleware, requireModule); the role cache is unchanged.
    await audit({
      category: 'identity',
      action: 'staff.modules',
      entity: 'User',
      entityId: target.id,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      tenantId: auditCompanyOf(target),
      before,
      after: { moduleAllow: allow, moduleDeny: deny, resetToRolePreset: body.modules === null, targetEmail: target.email },
      metadata: { actorTenantId: req.staffUser?.tenantId ?? null },
    })
    return { id: updated.id, name: updated.name, ...(await personModulesView(updated)) }
  })
}

// ── Head-office view for GET /permissions/me ────────────────────────────────
//
//   headOffices — the head offices the caller is a member of
//   reach       — companies reached through them and NOT a member of (the
//                 lens set; read-only, submit-for-approval only)
//   delegations — the caller's live approval hand-overs (lib/approvalRights.ts)
//   headOfficeSetupApplied — the CEO's setup wizard has run for some head
//                 office (switches retiring isHeadOffice / cost-share UIs)
//
// Names are read on serviceClient: the ids come from the auth middleware's
// own membership and reach lookups, and the RLS client would hide a reached
// company's tenant row from a single-company context.
async function headOfficeView(req: FastifyRequest) {
  const su = req.staffUser!
  const members = su.memberTenantIds ?? []
  const reachIds = reachTenantIds(req)

  const headOfficeRows = members.length > 0
    ? await serviceClient.tenant.findMany({
        where: { id: { in: members }, kind: 'head_office', deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      })
    : []

  const viaIds = new Set<string>()
  for (const c of reachIds) for (const h of reachVia(req, c)) viaIds.add(h)
  const nameRows = reachIds.length + viaIds.size > 0
    ? await serviceClient.tenant.findMany({ where: { id: { in: [...reachIds, ...viaIds] } }, select: { id: true, name: true } })
    : []
  const nameOf = new Map(nameRows.map((r) => [r.id, r.name]))
  const reach = reachIds
    .map((companyId) => ({
      companyId,
      name: nameOf.get(companyId) ?? '',
      via: reachVia(req, companyId).map((id) => ({ id, name: nameOf.get(id) ?? '' })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  let delegations: Array<{ id: string; section: string; scopeName: string; endsAt: Date | null }> = []
  try {
    const live = await liveDelegations(su.id)
    const scopeIds = new Set<string>()
    for (const d of live) { scopeIds.add(d.tenantId); if (d.companyTenantId) scopeIds.add(d.companyTenantId) }
    const scopeRows = scopeIds.size > 0
      ? await serviceClient.tenant.findMany({ where: { id: { in: [...scopeIds] } }, select: { id: true, name: true } })
      : []
    const scopeName = new Map(scopeRows.map((r) => [r.id, r.name]))
    delegations = live.map((d) => ({
      id: d.id,
      section: d.section,
      scopeName: d.companyTenantId
        ? (scopeName.get(d.companyTenantId) ?? '')
        : `${scopeName.get(d.tenantId) ?? 'Head office'} (all companies)`,
      endsAt: d.endsAt,
    }))
  } catch (err) {
    // HO-B2 builds liveDelegations in the same wave; until it lands the
    // stub throws NOT_BUILT and there are simply no hand-overs to show.
    if (!(err instanceof AppError && err.code === 'NOT_BUILT')) throw err
  }

  const applied = await serviceClient.headOfficeBooks.findFirst({
    where: { setupAppliedAt: { not: null } },
    select: { tenantId: true },
  })

  return {
    headOffices: headOfficeRows,
    reach,
    delegations,
    headOfficeSetupApplied: applied !== null,
  }
}
