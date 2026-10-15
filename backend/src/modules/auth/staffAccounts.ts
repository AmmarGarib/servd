import type { FastifyRequest } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { normalisePhone } from './otp.js'
import { usesOtpLogin, OTP_LOGIN_ROLES } from './middleware.js'
import { approvalInputOf, approvalSubject, assertCanApprove, type ApprovalGrant } from '../../lib/approvalRights.js'

/**
 * Staff-account rules shared by every route that creates, edits, approves or
 * acts on a login (invite, approve, POST/PATCH/DELETE /auth/users, reissue,
 * 2FA reset, the manager-issued sign-in code). One copy, so the routes cannot
 * drift apart on who may touch whom or what a valid phone is.
 */

// ─── Phone numbers ───────────────────────────────────────────────────────────

/**
 * A staff phone as stored: normalised digits (92XXXXXXXXXX for Pakistan), or
 * null for "none". The same number used to be stored as 0300…, +92300… and
 * 92300…, which is how two logins came to hold one number without anything
 * noticing. 11–15 digits after normalising — the floor below which
 * findOtpLoginStaff and requestOtp refuse a number anyway.
 */
export function normaliseStaffPhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const n = normalisePhone(trimmed)
  if (n.length < 11 || n.length > 15) {
    throw new AppError('INVALID_PHONE', 'That phone number does not look right. Use the full mobile number, e.g. 0300 1234567.', 400)
  }
  return n
}

/**
 * A phone ALREADY on a row, normalised — or null when it is missing or could
 * never receive a code. For checks on stored data, which must not 400 on a
 * legacy value the operator did not just type.
 */
export function normaliseStaffPhoneLenient(raw: string | null | undefined): string | null {
  try { return normaliseStaffPhone(raw) } catch { return null }
}

/**
 * Floor roles (cashier, foh, boh, kitchen, expediter) sign in ONLY with a code
 * sent to their phone — they have no password. A floor login with no phone is
 * an account nobody can ever get into, so it is refused at the door rather
 * than discovered at the till.
 */
export function assertPhoneForRole(role: UserRole | string, phone: string | null): void {
  if (usesOtpLogin(role) && !phone) {
    throw new AppError(
      'PHONE_REQUIRED',
      'Add their mobile number — cashiers, servers and kitchen staff sign in with a code sent to it, so without one they cannot sign in at all.',
      400,
    )
  }
}

/** Every company a login belongs to: primary + memberships. */
function companiesOf(u: { tenantId: string | null; tenantMemberships: Array<{ tenantId: string }> }): string[] {
  return Array.from(new Set([...(u.tenantId ? [u.tenantId] : []), ...u.tenantMemberships.map((m) => m.tenantId)]))
}

/**
 * One number, one FLOOR login. Floor-staff code sign-in (findOtpLoginStaff)
 * looks the number up across EVERY company (it happens before anyone is signed
 * in, so there is no company to scope it to) among active floor logins, and
 * refuses to guess when two share it — so a second floor login on a number
 * locks BOTH people out, while the till still says "a code is on its way".
 * Refused here instead, at invite, approve, create, edit and reactivate.
 *
 * Only floor logins (OTP_LOGIN_ROLES) can collide: a manager or office login
 * signs in with email + password and is never looked up by number, so it
 * neither holds a number against a cashier nor is blocked by one (AUTH-R7).
 * When `role` is not a floor role this is a no-op.
 *
 * `countPending` (default true) also counts pending invites as holders, so a
 * second invite or a fresh login cannot be made on a number a pending hire
 * already has. Approve passes false: a pending duplicate cannot lock anyone
 * out, and two invites of one person must not block each other's approval —
 * the first approved wins, the second is then refused.
 *
 * Suspended and deleted logins do not hold their number: a recycled SIM or a
 * re-hire must not be blocked by an old account. Reactivating one re-runs this
 * check, so it cannot come back as a duplicate.
 *
 * Race-free only inside `withStaffPhoneLock` with `db` = its transaction, and
 * the write made through that same transaction (AUTH-R5).
 *
 * The message names the holder only when the operator could see that login
 * anyway (it is in one of their companies). Otherwise it says only that the
 * number is taken — never which company has it.
 */
export async function assertPhoneFree(
  req: FastifyRequest,
  phone: string | null,
  opts: { role: UserRole | string; excludeUserId?: string; countPending?: boolean; db?: Db },
): Promise<void> {
  if (!phone || !usesOtpLogin(opts.role)) return
  const db = opts.db ?? prisma
  const candidates = await db.user.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      accountStatus: { in: opts.countPending === false ? ['active'] : ['active', 'pending'] },
      role: { in: OTP_LOGIN_ROLES },
      phone: { not: null },
      ...(opts.excludeUserId ? { id: { not: opts.excludeUserId } } : {}),
    },
    select: { id: true, name: true, phone: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } },
  })
  const holder = candidates.find((u) => normalisePhone(u.phone ?? '') === phone)
  if (!holder) return

  const mine = new Set(req.staffUser?.memberTenantIds ?? [])
  const visible = companiesOf(holder).some((t) => mine.has(t))
  throw new AppError(
    'PHONE_IN_USE',
    visible
      ? `That mobile number is already on ${holder.name}'s login. One person has one login — if this is the same person, add this company to their existing login instead of creating a second one.`
      : 'That mobile number is already on another servd login. One person has one login — if this is the same person, ask the CEO to add this company to their existing login.',
    409,
    visible ? { holderId: holder.id } : undefined,
  )
}

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Run `fn` in a transaction holding a per-number advisory lock, so the
 * phone-uniqueness check and the write it guards cannot interleave with
 * another request doing the same for the same number (AUTH-R5: two CEOs
 * creating the same cook at once both passed the check). Pass the transaction
 * to assertPhoneFree as `db` and make the write through it. A null phone takes
 * no lock.
 */
export async function withStaffPhoneLock<T>(
  phone: string | null,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    if (phone) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-phone:${phone}`}::text))`
    return fn(tx)
  })
}

// ─── Who may manage which login ──────────────────────────────────────────────

/**
 * The login `id`, if the operator may manage it — or 404 / 403.
 *
 * Scope is the operator's WRITE scope (every company they belong to, as the
 * auth middleware resolves it):
 *   • a login in none of those companies is FOREIGN → 404, never confirming it
 *     exists;
 *   • a login that also belongs to a company the operator is NOT in → 403. Role,
 *     suspension, password and deletion are per LOGIN, not per company, so an
 *     operator of company B changing a shared login would change it in company
 *     A too. Only someone in every one of its companies (the group owner) may.
 *   • a company-less legacy row → the CEO (role admin) only.
 *
 * The GS Foods owner belongs to every company, so they still manage everyone.
 */
export async function findManagedStaff<S extends Prisma.UserSelect>(
  req: FastifyRequest,
  id: string,
  select: S,
): Promise<Prisma.UserGetPayload<{ select: S }> & { companies: string[]; tenantId: string | null }> {
  const fullSelect: Prisma.UserSelect = { ...select, tenantId: true, tenantMemberships: { select: { tenantId: true } } }
  const row = await prisma.user.findFirst({ where: { id, deletedAt: null }, select: fullSelect }) as unknown as
    (Record<string, unknown> & { tenantId: string | null; tenantMemberships: Array<{ tenantId: string }> }) | null
  if (!row) throw new NotFoundError('Staff member')
  const companies = companiesOf(row)
  const mine = new Set(req.staffUser?.memberTenantIds ?? [])
  if (companies.length === 0) {
    if (req.staffUser?.role !== 'admin') throw new NotFoundError('Staff member')
  } else {
    if (!companies.some((t) => mine.has(t))) throw new NotFoundError('Staff member')
    if (!companies.every((t) => mine.has(t))) {
      throw new AppError(
        'LOGIN_IN_OTHER_COMPANY',
        'This login also works for a company you are not part of, so changing it would change it there too. Ask the group owner.',
        403,
      )
    }
  }
  // The membership list was only needed for the check; callers get `companies`.
  const { tenantMemberships: _m, ...rest } = row
  return { ...(rest as unknown as Prisma.UserGetPayload<{ select: S }>), companies, tenantId: row.tenantId }
}

/**
 * Companies a NEW login (or a transfer) may be bound to: only ones the operator
 * belongs to. 422 otherwise — the standing rule for a cross-company attach.
 */
export function assertCompaniesInScope(req: FastifyRequest, tenantIds: string[]): void {
  const mine = new Set(req.staffUser?.memberTenantIds ?? [])
  for (const t of tenantIds) {
    if (!mine.has(t)) {
      throw new AppError('CROSS_TENANT', 'You can only give a login access to companies you belong to.', 422)
    }
  }
}

/**
 * The read-scope filter for listing logins: anyone whose primary company or a
 * membership is in `tenantIds`. Company-less legacy rows are the CEO's to fix,
 * nobody else's.
 */
export function staffInCompaniesWhere(tenantIds: string[], includeOrphans: boolean): Prisma.UserWhereInput {
  return {
    OR: [
      { tenantId: { in: tenantIds } },
      { tenantMemberships: { some: { tenantId: { in: tenantIds } } } },
      ...(includeOrphans ? [{ tenantId: null, tenantMemberships: { none: {} } }] : []),
    ],
  }
}

/** The company an identity-trail row about this login is filed under: the TARGET's primary company. */
export function auditCompanyOf(target: { tenantId?: string | null; companies?: string[] }): string | null {
  return target.tenantId ?? target.companies?.[0] ?? null
}

// ─── Deciding a pending login (D3: hand-over) ────────────────────────────────

/**
 * The right to approve / reject the pending login `id` (spec §7.3, §7.4).
 *
 *  • The CEO: exactly today's rule first (findManagedStaff — 404 for a login
 *    outside their companies, 403 LOGIN_IN_OTHER_COMPANY for one that is also
 *    in a company they are not in; a company-less legacy row is theirs), then
 *    assertCanApprove, which always passes for them on the role path.
 *  • Anyone else: only through a live Operations hand-over that covers EVERY
 *    company of the login, and only a FLOOR login (cashier, FOH, BOH, kitchen,
 *    expediter) — every password login stays with the CEO (item-level
 *    ceoOnly). The inviter never decides their own invite (separation of
 *    duties: invitedById). A login that is no longer pending → 409 NOT_PENDING.
 *
 * The facts are read on serviceClient (A5) before the right is proven.
 */
export async function loginDecisionRight(
  req: FastifyRequest,
  id: string,
  action: 'approve' | 'reject',
): Promise<{ grant: ApprovalGrant; companies: string[]; tenantId: string | null }> {
  const isAdmin = req.staffUser?.role === 'admin'
  let companies: string[]
  if (isAdmin) {
    companies = (await findManagedStaff(req, id, { id: true })).companies
  } else {
    const row = await prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { tenantId: true, tenantMemberships: { select: { tenantId: true } } },
    })
    if (!row) throw new NotFoundError('Staff member')
    companies = companiesOf(row)
  }
  const s = await approvalSubject('staff_login', id)
  if (!s) throw new NotFoundError('Staff member')
  const grant = await assertCanApprove(req, approvalInputOf('staff_login', id, s, {
    touchesTenantIds: companies,
    entity: 'User',
    action: `${action} a new login`,
  }))
  if (!isAdmin && s.status !== 'pending') {
    throw new AppError('NOT_PENDING', 'This login is no longer waiting for approval.', 409)
  }
  return { grant, companies, tenantId: s.ownerTenantId }
}
