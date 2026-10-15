// Customer strike + ban engine — SERVD-WIDE (owner decision 2026-10-15:
// "If strikes and bans is about customers accounts then its ok, let it be
// across servd. No need to do it per company." — replaces the per-company
// rule of 2026-10-13).
//
// Three-strike accountability on the customer's servd ACCOUNT. Every offense
// (no-show, refused-at-door, a manual CRM strike) writes a CustomerStrike
// stamped with the company whose incident it is (the order's / reservation's
// brand's company, or the ACTIVE company for a manual strike) — the stamp is
// for audit, reporting and who may see the incident's details. The STANDING is
// per customer: when the customer's ACTIVE strikes across every company reach
// 3 (sum of severities), the customer is auto-banned: one CustomerBan stamped
// with the company whose strike tipped it (the raising company), locking out
// the account, its email and its phone at EVERY brand of every company.
// Strikes decay after 12 months.
//
// "Active" strikes = not reversed, not expired.
//
// Customer.strikeCount / bannedAt / isBlacklisted are a MIRROR (servd-wide sum /
// any active ban). Nothing enforces on them; every check reads CustomerBan
// through activeBanAtCompany.
//
// Who may lift a ban / decide its appeal: the CEO (role admin), or a manager of
// the company that RAISED it (crm/routes.ts findBanInScope). A legacy NULL-company
// ban: the CEO only. Other companies see the standing (count, blocked yes/no),
// never another company's incident details.
//
// `recordStrike` is fire-and-forget safe: never let a strike write break the
// upstream flow (reservation seating, order delivery). On any internal error,
// log and return without throwing.

import type { Prisma, PrismaClient } from '@prisma/client'
import { serviceClient } from './prisma.js'
import { AppError, NotFoundError } from './errors.js'
import { withSavepoint } from './savepoint.js'

const STRIKE_TTL_DAYS = 365
/** Sum of severities of the customer's ACTIVE strikes (servd-wide) that triggers the auto ban. */
export const BAN_THRESHOLD = 3

export type StrikeKind =
  | 'reservation_no_show'
  | 'cod_unpaid'   // legacy kind: still readable, no longer recorded by hand
  | 'cod_refused'
  | 'chargeback'
  | 'other'

export interface RecordStrikeArgs {
  customerId: string
  kind: StrikeKind
  sourceType?: 'reservation' | 'order'
  sourceId?: string
  severity?: number
  reason?: string
  recordedById?: string | null
  /**
   * The company whose incident it is. Optional when the strike names a source
   * (resolved from the order's / reservation's brand); REQUIRED otherwise.
   * When both are given the source's company wins.
   */
  tenantId?: string
}

export type Db = PrismaClient | Prisma.TransactionClient
export type Tx = Prisma.TransactionClient

const activeStrikeWhere = (now: Date): Prisma.CustomerStrikeWhereInput => ({
  reversedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
})
const activeBanFilter = (now: Date): Prisma.CustomerBanWhereInput => ({
  liftedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
})

function isTx(db: Db): db is Tx {
  return typeof (db as PrismaClient).$transaction !== 'function'
}

/** Run `fn` in `db` when it is already a transaction, else in a new one. */
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (isTx(db)) return fn(db)
  return (db as PrismaClient).$transaction(fn)
}

/** The per-customer ban lock: strikes and bans are servd-wide, so one lock per customer. */
async function lockBan(tx: Tx, customerId: string): Promise<void> {
  const key = `ban:${customerId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
}

/** The company of a strike's source (the brand's company), or null. */
async function sourceTenantId(db: Db, sourceType?: string, sourceId?: string): Promise<string | null> {
  if (!sourceType || !sourceId) return null
  if (sourceType === 'order') {
    const o = await db.order.findUnique({ where: { id: sourceId }, select: { concept: { select: { tenantId: true } } } })
    return o?.concept.tenantId ?? null
  }
  if (sourceType === 'reservation') {
    const r = await db.reservation.findUnique({ where: { id: sourceId }, select: { concept: { select: { tenantId: true } } } })
    return r?.concept.tenantId ?? null
  }
  return null
}

/**
 * Record a strike. ONE strike per incident: a strike that names its source
 * (sourceType + sourceId) is written at most once per (customer, kind,
 * source) — reversed ones included, so a forgiven incident reported again
 * stays forgiven. The check and the insert run under a transaction-scoped
 * advisory lock on the incident, so two racing reports cannot both insert.
 *
 * A refused-at-door strike ('cod_refused') always weighs 1: three refusals
 * block, literally (owner). Other kinds keep the caller's severity (1-3).
 *
 * Returns `banId` when an auto ban is in force on the customer after this strike.
 */
export async function recordStrike(args: RecordStrikeArgs): Promise<{ recorded: boolean; duplicate: boolean; banId?: string }> {
  try {
    const fromSource = await sourceTenantId(serviceClient, args.sourceType, args.sourceId)
    if (fromSource && args.tenantId && fromSource !== args.tenantId) {
      console.warn(`[strikes] tenantId ${args.tenantId} differs from the source's company ${fromSource} — using the source's`)
    }
    const tenantId = fromSource ?? args.tenantId ?? null
    if (!tenantId) {
      console.error(`[strikes] TENANT_REQUIRED: strike for ${args.customerId} (${args.kind}) names no company and no source — not recorded`)
      return { recorded: false, duplicate: false }
    }
    const expiresAt = new Date(Date.now() + STRIKE_TTL_DAYS * 86_400_000)
    const severity = args.kind === 'cod_refused' ? 1 : Math.min(3, Math.max(1, Math.trunc(args.severity ?? 1)))
    const data = {
      customerId:    args.customerId,
      kind:          args.kind,
      sourceType:    args.sourceType ?? null,
      sourceId:      args.sourceId   ?? null,
      severity,
      reason:        args.reason     ?? null,
      expiresAt,
      recordedById:  args.recordedById ?? null,
      tenantId,
    }
    let duplicate = false
    if (args.sourceType && args.sourceId) {
      const key = `strike:${args.customerId}:${args.kind}:${args.sourceType}:${args.sourceId}`
      duplicate = await serviceClient.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
        const existing = await tx.customerStrike.findFirst({
          where: { customerId: args.customerId, kind: args.kind, sourceType: args.sourceType!, sourceId: args.sourceId! },
          select: { id: true },
        })
        if (existing) return true
        await tx.customerStrike.create({ data })
        return false
      })
    } else {
      await serviceClient.customerStrike.create({ data })
    }
    if (duplicate) return { recorded: false, duplicate: true }
    const promoted = await maybePromoteToBan(args.customerId, tenantId)
    return { recorded: true, duplicate: false, ...(promoted.banId ? { banId: promoted.banId } : {}) }
  } catch (err) {
    console.error(`[strikes] recordStrike failed for ${args.customerId}:`, (err as Error).message)
    return { recorded: false, duplicate: false }
  }
}

/**
 * Weight (sum of severities) of the customer's ACTIVE strikes across servd —
 * every company's rows and legacy NULL rows alike (one account, one standing).
 */
export async function activeStrikeWeight(db: Db, customerId: string, now = new Date()): Promise<number> {
  const rows = await db.customerStrike.findMany({
    where: { customerId, ...activeStrikeWhere(now) },
    select: { severity: true },
  })
  return rows.reduce((sum, r) => sum + r.severity, 0)
}

/**
 * Re-sync the mirror on Customer: strikeCount = active weight across every
 * company; bannedAt / isBlacklisted = any active ban anywhere. Old screens read
 * these; nothing enforces on them.
 */
export async function syncCustomerBanMirror(db: Db, customerId: string): Promise<void> {
  const now = new Date()
  const [strikes, ban] = await Promise.all([
    db.customerStrike.findMany({ where: { customerId, ...activeStrikeWhere(now) }, select: { severity: true } }),
    db.customerBan.findFirst({
      where: { customerId, ...activeBanFilter(now) },
      select: { bannedAt: true, reason: true },
      orderBy: { bannedAt: 'desc' },
    }),
  ])
  await db.customer.updateMany({
    where: { id: customerId },
    data: {
      strikeCount: strikes.reduce((s, r) => s + r.severity, 0),
      ...(ban
        ? { bannedAt: ban.bannedAt, isBlacklisted: true, blacklistReason: ban.reason }
        : { bannedAt: null, isBlacklisted: false, blacklistReason: null }),
    },
  })
}

/**
 * Promote the customer to an auto ban when their servd-wide active strikes
 * weigh 3 or more — unless an active ban (staff or auto, any company) is
 * already in force on them. The new ban is stamped with `tenantId`, the
 * company whose strike tipped it (the raising company). Runs under the
 * per-customer advisory lock, so racing strikes (in any company) create one
 * ban. Backstop: the partial unique index on active auto bans (a violation
 * reads as "exists"). Always re-syncs the Customer mirror.
 */
export async function maybePromoteToBan(
  customerId: string,
  tenantId: string,
  db: Db = serviceClient,
): Promise<{ banId?: string; created: boolean }> {
  return inTx(db, async (tx) => {
    await lockBan(tx, customerId)
    const now = new Date()
    const weight = await activeStrikeWeight(tx, customerId, now)
    let result: { banId?: string; created: boolean } = { created: false }
    if (weight >= BAN_THRESHOLD) {
      const existing = await tx.customerBan.findFirst({
        where: { customerId, ...activeBanFilter(now) },
        select: { id: true },
        orderBy: { bannedAt: 'desc' },
      })
      if (existing) {
        result = { banId: existing.id, created: false }
      } else {
        const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { email: true, phone: true } })
        if (customer) {
          const made = await withSavepoint(tx, 'auto_ban_create', () => tx.customerBan.create({
            data: {
              tenantId,
              customerId,
              email:      customer.email?.toLowerCase() ?? null,
              phone:      customer.phone ?? null,
              reason:     `Auto-banned: ${weight} active strikes across servd (3-strike threshold)`,
              bannedById: null,
            },
            select: { id: true },
          }))
          if (made.ok) {
            result = { banId: made.value.id, created: true }
          } else {
            const code = (made.error as { code?: string }).code
            if (code !== 'P2002' && !/customer_bans_one_active_auto_per_(company|customer)/.test(made.error.message)) throw made.error
            const again = await tx.customerBan.findFirst({
              where: { customerId, liftedAt: null, bannedById: null },
              select: { id: true },
            })
            result = { banId: again?.id, created: false }
          }
        }
      }
    }
    await syncCustomerBanMirror(tx, customerId)
    return result
  })
}

/**
 * Reverse a strike (a manager forgives it). When the customer's servd-wide
 * active weight falls below 3, every active AUTO ban on them is lifted (any
 * company's, legacy NULL ones too) — never a staff ban.
 */
export async function reverseStrike(
  strikeId: string,
  reversedById: string,
  reversalReason: string,
): Promise<{ unbanned: boolean }> {
  const strike = await serviceClient.customerStrike.findUnique({
    where: { id: strikeId },
    select: { id: true, customerId: true, reversedAt: true },
  })
  if (!strike) throw new NotFoundError('Strike', strikeId)
  if (strike.reversedAt) return { unbanned: false }

  return serviceClient.$transaction(async (tx) => {
    await lockBan(tx, strike.customerId)
    const claimed = await tx.customerStrike.updateMany({
      where: { id: strikeId, reversedAt: null },
      data:  { reversedAt: new Date(), reversedById, reversalReason },
    })
    if (claimed.count === 0) return { unbanned: false }

    const now = new Date()
    let unbanned = false
    if ((await activeStrikeWeight(tx, strike.customerId, now)) < BAN_THRESHOLD) {
      const lifted = await tx.customerBan.updateMany({
        where: { customerId: strike.customerId, bannedById: null, liftedAt: null },
        data:  { liftedAt: now, liftedById: reversedById, liftReason: 'Strike reversed → below threshold' },
      })
      unbanned = lifted.count > 0
    }

    await syncCustomerBanMirror(tx, strike.customerId)
    return { unbanned }
  })
}

// ─── Lift and release (crm/routes.ts; the appeals desk resolves through these) ───

/**
 * Lift a ban (the CRM "unblock", or an appeal granted). The caller has already
 * checked the actor may decide it — the CEO, or a manager of the company that
 * raised it (crm/routes.ts findBanInScope; 404 / 403 otherwise). A legacy
 * NULL-company ban has no raising company, so only the CEO (role admin) may
 * lift it (403 LEGACY_BAN_ADMIN_ONLY). The strikes STAY (owner Q6: lifting
 * on appeal keeps the strike history; they expire after a year). Linked open
 * ban_appeal complaints resolve with 'Block lifted: <reason>'. Idempotent:
 * an already-lifted ban is left as it is.
 */
export async function liftBanTx(tx: Tx, a: { banId: string; actorId: string; reason: string; actorRole?: string }): Promise<void> {
  const ban = await tx.customerBan.findUnique({ where: { id: a.banId }, select: { id: true, tenantId: true, customerId: true, liftedAt: true } })
  if (!ban) throw new NotFoundError('Ban', a.banId)
  if (!ban.tenantId && a.actorRole !== 'admin') {
    throw new AppError('LEGACY_BAN_ADMIN_ONLY', 'This block has no company that raised it — only the CEO can lift it.', 403)
  }
  const now = new Date()
  if (!ban.liftedAt) {
    await tx.customerBan.updateMany({
      where: { id: ban.id, liftedAt: null },
      data:  { liftedAt: now, liftedById: a.actorId, liftReason: a.reason },
    })
  }
  await resolveOpenAppealsTx(tx, ban.id, `Block lifted: ${a.reason}`, now)
  if (ban.customerId) await syncCustomerBanMirror(tx, ban.customerId)
}

/**
 * Release one contact from a ban (owner Q7: a recycled phone number). Clears
 * that fingerprint on the ban AND removes the same phone (or email) from the
 * banned customer's account — Customer.phone / email are unique, so the next
 * sign-in with it creates a fresh account, which this ban no longer matches.
 * The old account keeps its other sign-in and stays blocked by customerId.
 * Resolves the linked open appeal. A legacy NULL-company ban: CEO only.
 */
export async function releaseBanContactTx(
  tx: Tx,
  a: { banId: string; contact: 'phone' | 'email'; actorId: string; reason: string; actorRole?: string },
): Promise<{ released: string | null }> {
  const ban = await tx.customerBan.findUnique({ where: { id: a.banId }, select: { id: true, tenantId: true, customerId: true, email: true, phone: true } })
  if (!ban) throw new NotFoundError('Ban', a.banId)
  if (!ban.tenantId && a.actorRole !== 'admin') {
    throw new AppError('LEGACY_BAN_ADMIN_ONLY', 'This block has no company that raised it — only the CEO can change it.', 403)
  }
  const value = a.contact === 'phone' ? ban.phone : ban.email
  if (!value) throw new AppError('NOTHING_TO_RELEASE', `This block holds no ${a.contact === 'phone' ? 'phone number' : 'email'}.`, 409)

  await tx.customerBan.update({ where: { id: ban.id }, data: a.contact === 'phone' ? { phone: null } : { email: null } })
  if (ban.customerId) {
    if (a.contact === 'phone') {
      await tx.customer.updateMany({ where: { id: ban.customerId, phone: value }, data: { phone: null } })
    } else {
      await tx.customer.updateMany({ where: { id: ban.customerId, email: { equals: value, mode: 'insensitive' } }, data: { email: null } })
    }
  }
  const label = a.contact === 'phone' ? 'Phone number' : 'Email'
  await resolveOpenAppealsTx(tx, ban.id, `${label} released from the block: ${a.reason}`, new Date())
  return { released: value }
}

async function resolveOpenAppealsTx(tx: Tx, banId: string, resolution: string, now: Date): Promise<void> {
  await tx.orderComplaint.updateMany({
    where: { banId, kind: 'ban_appeal', status: { in: ['open', 'in_progress'] } },
    data:  { status: 'resolved', resolvedAt: now, resolution },
  })
}

// ─── Ban checks — servd-wide (owner, 2026-10-15) ─────────────────────────────
//
// ONE blocking mechanism: CustomerBan. An active ban applies at every brand of
// every company, whichever company raised it (its tenantId says who raised it,
// for audit and for who may lift it — never where it applies). The `tenantId`
// the readers take is the company being asked about; it no longer narrows the
// match and is kept so callers stay explicit about where the customer is.

type BanMatch = { customerId?: string | null; email?: string | null; phone?: string | null }

function activeBanWhere(m: BanMatch, now: Date): Prisma.CustomerBanWhereInput | null {
  const or: Prisma.CustomerBanWhereInput[] = []
  if (m.customerId) or.push({ customerId: m.customerId })
  if (m.email)      or.push({ email: m.email.toLowerCase() })
  if (m.phone)      or.push({ phone: m.phone })
  if (or.length === 0) return null
  return { AND: [{ OR: or }, activeBanFilter(now)] }
}

type ActiveBan = { id: string; tenantId: string | null; reason: string; bannedAt: Date; ipAddresses: string[] }

/**
 * The active ban matching the customer, their email or phone — servd-wide, any
 * company's — or null. When the asking company raised one of them, that one is
 * returned (it can lift it); otherwise the latest.
 */
export async function activeBanAtCompany(args: BanMatch & { tenantId?: string | null }): Promise<ActiveBan | null> {
  const where = activeBanWhere(args, new Date())
  if (!where) return null
  const bans = await serviceClient.customerBan.findMany({
    where,
    select: { id: true, tenantId: true, reason: true, bannedAt: true, ipAddresses: true },
    orderBy: { bannedAt: 'desc' },
  })
  if (bans.length === 0) return null
  return (args.tenantId ? bans.find((b) => b.tenantId === args.tenantId) : undefined) ?? bans[0]!
}

export type BanAppealState = { status: 'none' | 'open' | 'declined'; at: Date | null }

/** The appeal state of a ban: an open appeal, else the latest declined ('closed') one, else none. */
export async function banAppealState(db: Db, banId: string): Promise<BanAppealState> {
  const latest = await db.orderComplaint.findFirst({
    where: { banId, kind: 'ban_appeal' },
    orderBy: { createdAt: 'desc' },
    select: { status: true, createdAt: true, resolvedAt: true, updatedAt: true },
  })
  if (!latest) return { status: 'none', at: null }
  if (latest.status === 'open' || latest.status === 'in_progress') return { status: 'open', at: latest.createdAt }
  if (latest.status === 'closed') return { status: 'declined', at: latest.resolvedAt ?? latest.updatedAt }
  return { status: 'none', at: null }
}

/**
 * Refuse an order/booking at any brand when an active ban (servd-wide) matches
 * this customer, their email or phone. Records the IP on the ban as a forensic
 * signal. The BANNED error carries details { banId, companyName: null, appeal }
 * so the storefront / app can offer the appeal; it never names the company that
 * raised the block (the block is on the servd account).
 */
export async function assertNotBannedAtCompany(args: BanMatch & {
  tenantId?: string | null
  ip?: string | null
  intent?: 'order' | 'reservation' | 'signup'
}): Promise<void> {
  const ban = await activeBanAtCompany(args)
  if (!ban) return
  if (args.ip && !ban.ipAddresses.includes(args.ip)) {
    await serviceClient.customerBan.update({ where: { id: ban.id }, data: { ipAddresses: { push: args.ip } } }).catch(() => {})
  }
  const appeal = await banAppealState(serviceClient, ban.id).catch((): BanAppealState => ({ status: 'none', at: null }))
  const verb = args.intent === 'reservation' ? 'book' : args.intent === 'signup' ? 'sign up' : 'order'
  throw new AppError('BANNED', `This servd account can't ${verb} right now. If you think this is a mistake, contact us.`, 403, {
    banId: ban.id,
    companyName: null,
    appeal,
  })
}

/**
 * Customers with an active ban (for marketing reach). Servd-wide: every active
 * ban applies at every company, so `tenantId` (the sending company) does not
 * narrow it.
 */
export async function bannedCustomerIdsAtCompany(_tenantId?: string): Promise<string[]> {
  const bans = await serviceClient.customerBan.findMany({
    where: { customerId: { not: null }, ...activeBanFilter(new Date()) },
    select: { customerId: true },
  })
  return [...new Set(bans.map((b) => b.customerId!))]
}
