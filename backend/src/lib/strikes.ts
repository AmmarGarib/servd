// Customer strike + ban engine — PER COMPANY (owner, 2026-10-13).
//
// Three-strike accountability. Every offense (no-show, refused-at-door, a
// manual CRM strike) writes a CustomerStrike stamped with the company whose
// incident it is (the order's / reservation's brand's company, or the ACTIVE
// company for a manual strike). When a company's ACTIVE strikes on a customer
// reach 3 (sum of severities), that company auto-bans the customer: a
// CustomerBan with that company's tenantId, locking out the account, its email
// and its phone at THAT company's brands only. Another company is unaffected
// (CLAUDE.md: bans stay inside the company that issued them). Strikes decay
// after 12 months.
//
// "Active" strikes = not reversed, not expired.
//
// Customer.strikeCount / bannedAt / isBlacklisted are a MIRROR for old screens
// (sum across companies / any active ban). Nothing enforces on them; every
// check reads CustomerBan through activeBanAtCompany.
//
// Legacy rows: the wave-B migration stamped tenantId on every strike and ban
// it could attribute. A row still NULL is read by the old attribution
// (crm/customerScope.ts strikeCompanies / banCompanies); a NULL ban that
// cannot be attributed applies at every company and only the CEO (admin) can
// lift it.
//
// `recordStrike` is fire-and-forget safe: never let a strike write break the
// upstream flow (reservation seating, order delivery). On any internal error,
// log and return without throwing.

import type { Prisma, PrismaClient } from '@prisma/client'
import { serviceClient } from './prisma.js'
import { AppError, NotFoundError } from './errors.js'
import { withSavepoint } from './savepoint.js'

const STRIKE_TTL_DAYS = 365
/** Sum of severities of a company's ACTIVE strikes that triggers that company's auto ban. */
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

async function lockBan(tx: Tx, tenantId: string, customerId: string): Promise<void> {
  const key = `ban:${tenantId}:${customerId}`
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
 * Returns `banId` when the company's auto ban is in force after this strike.
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
 * Weight (sum of severities) of the customer's ACTIVE strikes at `tenantId`:
 * rows stamped with that company, plus legacy NULL rows the old attribution
 * gives to it (an unattributable legacy row counts everywhere, as it always did).
 */
export async function activeStrikeWeightAt(db: Db, customerId: string, tenantId: string, now = new Date()): Promise<number> {
  const rows = await db.customerStrike.findMany({
    where: { customerId, AND: [activeStrikeWhere(now), { OR: [{ tenantId }, { tenantId: null }] }] },
    select: { id: true, customerId: true, sourceType: true, sourceId: true, recordedById: true, severity: true, tenantId: true },
  })
  const legacy = rows.filter((r) => r.tenantId === null)
  let weight = rows.filter((r) => r.tenantId === tenantId).reduce((s, r) => s + r.severity, 0)
  if (legacy.length > 0) {
    const { strikeCompanies } = await import('../modules/crm/customerScope.js')
    const sc = await strikeCompanies(legacy)
    for (const r of legacy) {
      const c = sc.get(r.id)
      if (c === null || c?.has(tenantId)) weight += r.severity
    }
  }
  return weight
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
 * Promote the customer to an auto ban AT `tenantId` when that company's active
 * strikes weigh 3 or more — unless that company already has an active ban on
 * them (staff or auto). Another company's ban never stops it. Runs under the
 * per-(company, customer) advisory lock, so racing strikes create one ban; the
 * partial unique customer_bans_one_active_auto_per_company is the backstop
 * (a violation reads as "exists"). Always re-syncs the Customer mirror.
 */
export async function maybePromoteToBan(
  customerId: string,
  tenantId: string,
  db: Db = serviceClient,
): Promise<{ banId?: string; created: boolean }> {
  return inTx(db, async (tx) => {
    await lockBan(tx, tenantId, customerId)
    const now = new Date()
    const weight = await activeStrikeWeightAt(tx, customerId, tenantId, now)
    let result: { banId?: string; created: boolean } = { created: false }
    if (weight >= BAN_THRESHOLD) {
      const existing = await tx.customerBan.findFirst({
        where: { customerId, tenantId, ...activeBanFilter(now) },
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
              reason:     `Auto-banned: ${weight} active strikes (3-strike threshold)`,
              bannedById: null,
            },
            select: { id: true },
          }))
          if (made.ok) {
            result = { banId: made.value.id, created: true }
          } else {
            const code = (made.error as { code?: string }).code
            if (code !== 'P2002' && !/customer_bans_one_active_auto_per_company/.test(made.error.message)) throw made.error
            const again = await tx.customerBan.findFirst({
              where: { customerId, tenantId, liftedAt: null, bannedById: null },
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
 * Reverse a strike (a manager forgives it). Per the strike's company: when
 * that company's active weight falls below 3, ITS auto ban is lifted — never
 * another company's, never a staff ban. A legacy NULL-company auto ban is
 * lifted only when every company it is attributed to is below 3.
 */
export async function reverseStrike(
  strikeId: string,
  reversedById: string,
  reversalReason: string,
): Promise<{ unbanned: boolean }> {
  const strike = await serviceClient.customerStrike.findUnique({
    where: { id: strikeId },
    select: { id: true, customerId: true, reversedAt: true, tenantId: true, sourceType: true, sourceId: true, recordedById: true },
  })
  if (!strike) throw new NotFoundError('Strike', strikeId)
  if (strike.reversedAt) return { unbanned: false }

  // The companies the strike counts at.
  let companies: string[]
  if (strike.tenantId) {
    companies = [strike.tenantId]
  } else {
    const { strikeCompanies } = await import('../modules/crm/customerScope.js')
    const c = (await strikeCompanies([strike])).get(strike.id)
    if (c === null || c === undefined) {
      // Unattributable legacy strike: it counted everywhere — re-check every
      // company with an active auto ban on the customer.
      const bans = await serviceClient.customerBan.findMany({
        where: { customerId: strike.customerId, bannedById: null, tenantId: { not: null }, ...activeBanFilter(new Date()) },
        select: { tenantId: true },
      })
      companies = [...new Set(bans.map((b) => b.tenantId!))]
    } else {
      companies = [...c]
    }
  }
  companies.sort()

  return serviceClient.$transaction(async (tx) => {
    for (const t of companies) await lockBan(tx, t, strike.customerId)
    const claimed = await tx.customerStrike.updateMany({
      where: { id: strikeId, reversedAt: null },
      data:  { reversedAt: new Date(), reversedById, reversalReason },
    })
    if (claimed.count === 0) return { unbanned: false }

    const now = new Date()
    let unbanned = false
    for (const t of companies) {
      if ((await activeStrikeWeightAt(tx, strike.customerId, t, now)) >= BAN_THRESHOLD) continue
      const lifted = await tx.customerBan.updateMany({
        where: { customerId: strike.customerId, tenantId: t, bannedById: null, liftedAt: null },
        data:  { liftedAt: now, liftedById: reversedById, liftReason: 'Strike reversed → below threshold' },
      })
      if (lifted.count > 0) unbanned = true
    }

    // Legacy NULL-company auto bans: lift when no company they are attributed to is still at 3.
    const legacyBans = await tx.customerBan.findMany({
      where: { customerId: strike.customerId, tenantId: null, bannedById: null, liftedAt: null },
      select: { id: true, customerId: true, bannedById: true, tenantId: true },
    })
    if (legacyBans.length > 0) {
      const { banCompanies } = await import('../modules/crm/customerScope.js')
      const bc = await banCompanies(legacyBans)
      for (const b of legacyBans) {
        const at = bc.get(b.id)
        const still = at === null || at === undefined
          ? (await tx.customerStrike.findMany({ where: { customerId: strike.customerId, ...activeStrikeWhere(now) }, select: { severity: true } }))
              .reduce((s, r) => s + r.severity, 0) >= BAN_THRESHOLD
          : (await Promise.all([...at].map((t) => activeStrikeWeightAt(tx, strike.customerId, t, now)))).some((w) => w >= BAN_THRESHOLD)
        if (still) continue
        await tx.customerBan.updateMany({
          where: { id: b.id, liftedAt: null },
          data:  { liftedAt: now, liftedById: reversedById, liftReason: 'Strike reversed → below threshold' },
        })
        unbanned = true
      }
    }

    await syncCustomerBanMirror(tx, strike.customerId)
    return { unbanned }
  })
}

// ─── Lift and release (crm/routes.ts; the appeals desk resolves through these) ───

/**
 * Lift a ban (the CRM "unblock", or an appeal granted). The caller has already
 * checked the ban is its company's (404 otherwise). A legacy NULL-company ban
 * applies everywhere, so only the CEO (role admin) may lift it
 * (403 LEGACY_BAN_ADMIN_ONLY). The company's strikes STAY (owner Q6: lifting
 * on appeal keeps the strike history; they expire after a year). Linked open
 * ban_appeal complaints resolve with 'Block lifted: <reason>'. Idempotent:
 * an already-lifted ban is left as it is.
 */
export async function liftBanTx(tx: Tx, a: { banId: string; actorId: string; reason: string; actorRole?: string }): Promise<void> {
  const ban = await tx.customerBan.findUnique({ where: { id: a.banId }, select: { id: true, tenantId: true, customerId: true, liftedAt: true } })
  if (!ban) throw new NotFoundError('Ban', a.banId)
  if (!ban.tenantId && a.actorRole !== 'admin') {
    throw new AppError('LEGACY_BAN_ADMIN_ONLY', 'This block is from before blocks were per company and applies at every company — only the CEO can lift it.', 403)
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
    throw new AppError('LEGACY_BAN_ADMIN_ONLY', 'This block is from before blocks were per company and applies at every company — only the CEO can change it.', 403)
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

// ─── Per-company ban checks (owner decision 15) ──────────────────────────────
//
// ONE blocking mechanism: CustomerBan. A ban applies at the brands of the
// company in its tenantId column. A legacy NULL row is attributed the old way
// (crm/customerScope.banCompanies); one that cannot be attributed applies
// everywhere — the conservative reading.

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

/** This company's active ban matching the customer, their email or phone — or null. */
export async function activeBanAtCompany(args: BanMatch & { tenantId: string | null }): Promise<ActiveBan | null> {
  const where = activeBanWhere(args, new Date())
  if (!where) return null
  const bans = await serviceClient.customerBan.findMany({
    where: args.tenantId ? { AND: [where, { OR: [{ tenantId: args.tenantId }, { tenantId: null }] }] } : where,
    select: { id: true, customerId: true, bannedById: true, tenantId: true, reason: true, bannedAt: true, ipAddresses: true },
    orderBy: { bannedAt: 'desc' },
  })
  if (bans.length === 0) return null
  const strip = ({ customerId: _c, bannedById: _b, ...rest }: (typeof bans)[number]): ActiveBan => rest
  if (!args.tenantId) return strip(bans[0]!)
  const own = bans.find((b) => b.tenantId === args.tenantId)
  if (own) return strip(own)
  const legacy = bans.filter((b) => b.tenantId === null)
  if (legacy.length === 0) return null
  const { banCompanies } = await import('../modules/crm/customerScope.js')
  const companies = await banCompanies(legacy)
  const hit = legacy.find((b) => {
    const c = companies.get(b.id)
    return c === null || (c !== undefined && c.has(args.tenantId!))
  })
  return hit ? strip(hit) : null
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
 * Refuse an order/booking at a brand of `tenantId` when that company has an
 * active ban on this customer. Records the IP on the ban as a forensic signal.
 * The BANNED error carries details { banId, companyName, appeal } so the
 * storefront / app can offer the appeal.
 */
export async function assertNotBannedAtCompany(args: BanMatch & {
  tenantId: string | null
  ip?: string | null
  intent?: 'order' | 'reservation' | 'signup'
}): Promise<void> {
  const ban = await activeBanAtCompany(args)
  if (!ban) return
  if (args.ip && !ban.ipAddresses.includes(args.ip)) {
    await serviceClient.customerBan.update({ where: { id: ban.id }, data: { ipAddresses: { push: args.ip } } }).catch(() => {})
  }
  const companyId = ban.tenantId ?? args.tenantId
  const [company, appeal] = await Promise.all([
    companyId ? serviceClient.tenant.findUnique({ where: { id: companyId }, select: { name: true } }).catch(() => null) : null,
    banAppealState(serviceClient, ban.id).catch((): BanAppealState => ({ status: 'none', at: null })),
  ])
  const verb = args.intent === 'reservation' ? 'book' : args.intent === 'signup' ? 'sign up' : 'order'
  throw new AppError('BANNED', `This account can't ${verb} here. If you think this is a mistake, contact the venue directly.`, 403, {
    banId: ban.id,
    companyName: company?.name ?? null,
    appeal,
  })
}

/** Customers with an active ban that applies at `tenantId` (for marketing reach). */
export async function bannedCustomerIdsAtCompany(tenantId: string): Promise<string[]> {
  const now = new Date()
  const bans = await serviceClient.customerBan.findMany({
    where: { customerId: { not: null }, ...activeBanFilter(now), AND: [{ OR: [{ tenantId }, { tenantId: null }] }] },
    select: { id: true, customerId: true, bannedById: true, tenantId: true },
  })
  if (bans.length === 0) return []
  const out = new Set<string>(bans.filter((b) => b.tenantId === tenantId).map((b) => b.customerId!))
  const legacy = bans.filter((b) => b.tenantId === null)
  if (legacy.length > 0) {
    const { banCompanies } = await import('../modules/crm/customerScope.js')
    const companies = await banCompanies(legacy)
    for (const b of legacy) {
      const c = companies.get(b.id)
      if (c === null || c?.has(tenantId)) out.add(b.customerId!)
    }
  }
  return [...out]
}
