// Tip pool — sums Order.tipCents a brand collected during the period,
// distributes it across the staff who worked THAT BRAND's branches in the
// period, and posts the journal:
//   On post: records member shareCents (no JE — the liability already exists
//            from order completion).
//   On pay:  Dr 2095 Tips Payable / Cr Bank or Cash for total disbursed.
//            The paying account is a cash/bank asset of the pool's own
//            company (PPL-R2-03), and a till still open with tips from the
//            window blocks posting and paying — its tips reach 2095 only at
//            the till's close (PPL-R2-04).
//
// A pool is computed once its window is over, and posting re-checks it
// (audit HR-R3 / HR-R4): the tips are added up again under the brand's lock,
// and posting is refused while anyone who worked the window is missing from
// the draft, has hours with no known branch, or is still clocked in. Hours a
// pool cannot hold are listed with the reason, never dropped silently.
//
// Kiosk-only staff (an HR record, no servd login) cannot be pool members yet:
// tip_pool_members.userId is a required link to a login (HR-R7 — the schema
// change is in the report). Splitting the whole pot among the login holders
// would hand the kitchen's share to front of house, so a pool whose window a
// kiosk-only person worked at the brand is not posted until they are given a
// login linked to their HR record (and the draft is computed again) — or the
// approver records, by name and with a reason, that they are not in the pool
// (e.g. a house rule). That decision is audited.
//
// A tip is pooled once (audit PPL-01). A brand's pools may not overlap in
// time — the window is half-open, [periodStart, periodEnd), so back-to-back
// pools share no instant and no order. Posting and paying re-check it under
// the brand's lock, so two pools over the same tips (left from before this
// rule) can never both be paid. A draft can be deleted and computed again.
// (Stamping each pooled order with its pool would need an orders column —
// see the report.)

import { tenantForConcept } from '../../lib/setup-config.js'
import type { FastifyInstance } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, APPROVERS, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { postJournalEntry, ACCT } from '../accounting/journal.js'
import { homeShiftOf } from '../accounting/orderPosting.js'
import { conceptIdsInScope, assertConceptOwned } from '../../lib/tenantScope.js'
import { getOperationsConfig, tipPoolWeights, getGeofenceConfig } from '../../lib/setup-config.js'
import { nearestAnchor } from '../timeclock/policy.js'
import { attendanceKeys, isMissedClockOut, MISSING_PUNCH_AFTER_MS, type PunchEntry } from '../hr/attendance.js'
import { getFormat } from '../hr/service.js'
import { rotaFor, toMinutes, ymd } from '../hr/rota.js'

// The rules are the company's, set in /configuration/operations
// (OperationsConfig): whether pooling is on, how it is split, and the weight
// of each role (decision 36: servers 1.0, cashiers and baristas 0.75, kitchen
// 0.5 — setup-config.ts TIP_POOL_DEFAULT_WEIGHTS). A role with no weight is not
// in the pool. Split:
//   equal           one share each for everyone in the pool who worked
//   by_hours        hours worked
//   by_role_weight  hours worked × role weight

/** Who drafts and reviews pools. Narrowed by the 'payroll' module
 *  (lib/moduleAccess.ts gates /tip-pools): by default the CEO, owners,
 *  management, finance and HR. Posting and paying stay with APPROVERS. */
const POOL_TEAM = Array.from(new Set([...MANAGERS, 'finance', 'hr'])) as UserRole[]

type Tx = Prisma.TransactionClient

export interface WorkedSpan { inAt: Date; outAt: Date; locationId: string | null }

/**
 * Pair sorted punches into worked spans. An in followed by another in is a
 * forgotten clock-out and pairs with nothing; a span longer than the
 * missing-punch limit (16 h) is a late out from another day, not a shift, and
 * counts nothing until HR corrects the day (audit PPL-03 — it gave one cashier
 * 25 h and the whole pool).
 */
export function pairSpans(punches: Array<{ type: string; at: Date; locationId?: string | null }>): WorkedSpan[] {
  const out: WorkedSpan[] = []
  let open: { at: Date; locationId: string | null } | null = null
  for (const p of punches) {
    if (p.type === 'in') open = { at: p.at, locationId: p.locationId ?? null }
    else if (p.type === 'out' && open) {
      const ms = p.at.getTime() - open.at.getTime()
      if (ms > 0 && ms <= MISSING_PUNCH_AFTER_MS) out.push({ inAt: open.at, outAt: p.at, locationId: open.locationId })
      open = null
    }
  }
  return out
}

/** Milliseconds of a span inside [from, to). */
const msWithin = (s: WorkedSpan, from: Date, to: Date) =>
  Math.max(0, Math.min(s.outAt.getTime(), to.getTime()) - Math.max(s.inAt.getTime(), from.getTime()))

/** A Karachi wall-clock time on a day (stored as UTC midnight) as an instant. */
const pktAt = (day: Date, hhmm: string) => new Date(day.getTime() + (toMinutes(hhmm) ?? 0) * 60_000 - 5 * 3_600_000)

/** Where a punch was made: its geofence branch when it matched one. */
const punchLocation = (p: Pick<PunchEntry, 'locationId' | 'geofenceMatched'>) =>
  p.locationId && p.geofenceMatched !== false ? p.locationId : null

/**
 * The spans one attendance day was worked, and its in still open at the end
 * (an in with no out yet). An approved correction's times replace the punched
 * ones (that is how HR fixes a missed clock-out); a day closed as a missed
 * clock-out has an unpaired in, so it gives nothing.
 */
function dayWork(rec: { startDate: Date | null; data: unknown }, keys: { checkIn: string; checkOut: string }): { spans: WorkedSpan[]; openIn: { at: Date; locationId: string | null } | null } {
  const d = (rec.data ?? {}) as Record<string, unknown>
  const punches = ((d['_punches'] as PunchEntry[] | undefined) ?? [])
    .map((p) => ({ type: p.type, at: new Date(p.at), locationId: punchLocation(p) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  if (d['_source'] === 'correction' && rec.startDate) {
    const inT = d[keys.checkIn], outT = d[keys.checkOut]
    if (typeof inT !== 'string' || typeof outT !== 'string' || toMinutes(inT) == null || toMinutes(outT) == null) return { spans: [], openIn: null }
    const day = new Date(Date.UTC(rec.startDate.getUTCFullYear(), rec.startDate.getUTCMonth(), rec.startDate.getUTCDate()))
    const inAt = pktAt(day, inT)
    let outAt = pktAt(day, outT)
    if (outAt <= inAt) outAt = new Date(outAt.getTime() + 86_400_000)
    const loc = typeof d['location'] === 'string' ? d['location'] : punches.find((p) => p.type === 'in')?.locationId ?? null
    return { spans: pairSpans([{ type: 'in', at: inAt, locationId: loc }, { type: 'out', at: outAt }]), openIn: null }
  }
  const last = punches[punches.length - 1]
  const openIn = last?.type === 'in' && !d['_missedOut'] && !d[keys.checkOut] ? { at: last.at, locationId: last.locationId } : null
  return { spans: pairSpans(punches), openIn }
}

/** Why someone's hours in the window are not in the pool. */
export type ExcludedReason =
  /** worked with no known branch (no geofence match, no HR branch, no rota
   *  brand) in a company with several brands — could have been any of them */
  | 'no_branch'
  /** still clocked in: the shift is not over, so its hours are not known yet */
  | 'still_on_shift'
  /** kiosk-only staff (no servd login): a pool member needs a login until
   *  tip_pool_members gets an employee column (HR-R7). Posting waits for
   *  them unless the approver records that they are not in the pool. */
  | 'no_login'

export interface ExcludedHours {
  name: string
  userId: string | null
  employeeId: string | null
  role: string | null
  designation: string | null
  hours: number
  reason: ExcludedReason
}

export interface WorkedAtBrand { userId: string; name: string; role: string; designation: string | null; hours: number }

/**
 * Hours each person of the brand's company worked AT THE BRAND in the window
 * (audit PPL-02: a Stackd pool paid a cook from the Flipd kitchen). A span
 * counts for the brand when it was worked at one of the brand's branches
 * (ConceptLocation): the branch the punch matched, else the person's HR
 * branch, else the brand of their rota that day (a /scheduling shift). A span
 * with no known place counts only when this is the company's one brand —
 * there is nothing else it could have been for.
 *
 * Hours that cannot go in the pool are never dropped silently (audit HR-R4 /
 * HR-R7): they come back in `excluded`, per person, with the reason — no
 * known branch, still on shift, or kiosk-only staff.
 *
 * Someone with an HR record here is read from that company's attendance
 * punches — a person on two companies' payrolls is paid by each for its own
 * hours. Someone without one is read from the punch log, but only when this is
 * their only company (the punch log does not say which company a punch was
 * for); their branch is the company branch nearest the punch.
 */
export async function hoursAtBrand(concept: { id: string; tenantId: string }, from: Date, to: Date, now = new Date()): Promise<{ worked: WorkedAtBrand[]; excluded: ExcludedHours[] }> {
  const tenantId = concept.tenantId
  const [links, otherBrands] = await Promise.all([
    prisma.conceptLocation.findMany({ where: { conceptId: concept.id }, select: { locationId: true } }),
    prisma.concept.count({ where: { tenantId, deletedAt: null, isActive: true, id: { not: concept.id } } }),
  ])
  const brandLocs = new Set(links.map((l) => l.locationId))
  const soleBrand = otherBrands === 0
  if (brandLocs.size === 0 && !soleBrand) {
    throw new AppError('BRAND_HAS_NO_BRANCH', 'This brand is not linked to any branch, so the pool cannot tell who worked it — link it to its branches in Configuration → Locations first', 422)
  }
  /** Where a span was worked, for this brand: here, at another brand, or unknown. */
  const place = (loc: string | null, rotaBrands: Set<string> | undefined): 'here' | 'elsewhere' | 'unknown' => {
    if (brandLocs.size === 0) return 'here'
    if (loc) return brandLocs.has(loc) ? 'here' : 'elsewhere'
    if (rotaBrands?.size) return rotaBrands.has(concept.id) ? 'here' : 'elsewhere'
    return soleBrand ? 'here' : 'unknown'
  }

  const users = await prisma.user.findMany({
    where: { deletedAt: null, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
    select: { id: true, name: true, role: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } },
  })
  const dayFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()) - 86_400_000)
  // Everyone with attendance in the window: login holders, and kiosk-only
  // staff (no login) — they are reported, never silently left out.
  const attendance = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'attendance', employeeId: { not: null }, startDate: { gte: dayFrom, lte: to }, status: { notIn: ['draft', 'rejected', 'cancelled'] } },
    select: { employeeId: true, startDate: true, data: true },
  })
  const userIds = new Set(users.map((u) => u.id))
  const emps = await prisma.hrEmployee.findMany({
    where: { tenantId, OR: [{ userId: { in: Array.from(userIds) } }, { userId: null, id: { in: Array.from(new Set(attendance.map((a) => a.employeeId!))) } }] },
    select: { id: true, userId: true, fullName: true, designationId: true, locationId: true },
  })
  const empByUser = new Map(emps.filter((e) => e.userId && userIds.has(e.userId)).map((e) => [e.userId!, e]))
  const designations = await prisma.hrOrgUnit.findMany({ where: { tenantId, id: { in: emps.map((e) => e.designationId).filter(Boolean) as string[] } }, select: { id: true, name: true } })
  const designationName = new Map(designations.map((d) => [d.id, d.name]))
  const keys = attendanceKeys((await getFormat(tenantId, 'attendance')).fields)

  // Each employee's days: spans (tagged with the day, for the rota fallback)
  // and an in still open.
  type DaySpan = WorkedSpan & { day: string }
  const work = new Map<string, { spans: DaySpan[]; open: Array<{ at: Date; locationId: string | null; day: string }> }>()
  const empById = new Map(emps.map((e) => [e.id, e]))
  for (const a of attendance) {
    const e = empById.get(a.employeeId!)
    if (!e) continue
    const day = a.startDate ? ymd(a.startDate) : ''
    const w = work.get(e.id) ?? { spans: [], open: [] }
    const { spans, openIn } = dayWork(a, keys)
    w.spans.push(...spans.map((sp) => ({ ...sp, locationId: sp.locationId ?? e.locationId ?? null, day })))
    if (openIn) w.open.push({ at: openIn.at, locationId: openIn.locationId ?? e.locationId ?? null, day })
    work.set(e.id, w)
  }

  // The rota fallback, only for the days a span has no branch.
  const needRota = soleBrand ? [] : emps.filter((e) => e.userId && (work.get(e.id)?.spans.some((sp) => !sp.locationId) || work.get(e.id)?.open.some((o) => !o.locationId)))
  const rotaBrands = new Map<string, Set<string>>()
  if (needRota.length) {
    const days = Array.from(attendance.filter((a) => a.startDate).map((a) => ymd(a.startDate!))).sort()
    const cells = await rotaFor(tenantId, needRota, days[0]!, days[days.length - 1]!)
    for (const c of cells) {
      const brands = new Set(c.segments.map((sg) => sg.conceptId).filter((x): x is string => !!x))
      if (brands.size) rotaBrands.set(`${c.employeeId}:${c.date}`, brands)
    }
  }

  const soloUserIds = users.filter((u) => !empByUser.has(u.id) && (u.tenantMemberships.every((m) => m.tenantId === tenantId)) && (!u.tenantId || u.tenantId === tenantId)).map((u) => u.id)
  const logs = soloUserIds.length ? await prisma.clockLog.findMany({
    where: { userId: { in: soloUserIds }, recordedAt: { gte: new Date(from.getTime() - MISSING_PUNCH_AFTER_MS), lte: new Date(to.getTime() + MISSING_PUNCH_AFTER_MS) } },
    orderBy: { recordedAt: 'asc' }, select: { userId: true, type: true, recordedAt: true, lat: true, lng: true },
  }) : []
  const geofence = logs.length ? await getGeofenceConfig(tenantId) : null
  const logBranch = (l: { lat: number | null; lng: number | null }) => {
    if (!geofence || l.lat == null || l.lng == null) return null
    const near = nearestAnchor(geofence.anchors, l.lat, l.lng)
    return near && near.distanceM <= geofence.radiusM ? near.anchor.locationId : null
  }

  const excluded: ExcludedHours[] = []
  const exclude = (who: Omit<ExcludedHours, 'hours' | 'reason'>, reason: ExcludedReason, ms: number) => {
    if (ms <= 0) return
    const cur = excluded.find((x) => x.reason === reason && x.userId === who.userId && x.employeeId === who.employeeId)
    if (cur) cur.hours += ms / 3_600_000
    else excluded.push({ ...who, hours: ms / 3_600_000, reason })
  }
  /** The part of a still-open shift inside the window, up to now. */
  const openMs = (o: { at: Date }) => isMissedClockOut(o.at, now) || o.at >= to ? 0 : msWithin({ inAt: o.at, outAt: now < to ? now : to, locationId: null }, from, to)

  const worked = users.map((u) => {
    const emp = empByUser.get(u.id)
    const designation = emp?.designationId ? designationName.get(emp.designationId) ?? null : null
    const who = { name: u.name, userId: u.id, employeeId: emp?.id ?? null, role: u.role, designation }
    let ms = 0
    if (emp) {
      const w = work.get(emp.id) ?? { spans: [], open: [] }
      for (const sp of w.spans) {
        const where = place(sp.locationId, rotaBrands.get(`${emp.id}:${sp.day}`))
        if (where === 'here') ms += msWithin(sp, from, to)
        else if (where === 'unknown') exclude(who, 'no_branch', msWithin(sp, from, to))
      }
      for (const o of w.open) {
        if (place(o.locationId, rotaBrands.get(`${emp.id}:${o.day}`)) !== 'elsewhere') exclude(who, 'still_on_shift', openMs(o))
      }
    } else {
      const mine = logs.filter((l) => l.userId === u.id).map((l) => ({ type: l.type, at: l.recordedAt, locationId: logBranch(l) }))
      for (const sp of pairSpans(mine)) {
        const where = place(sp.locationId, undefined)
        if (where === 'here') ms += msWithin(sp, from, to)
        else if (where === 'unknown') exclude(who, 'no_branch', msWithin(sp, from, to))
      }
      const last = mine[mine.length - 1]
      if (last?.type === 'in' && place(last.locationId, undefined) !== 'elsewhere') exclude(who, 'still_on_shift', openMs(last))
    }
    return { userId: u.id, name: u.name, role: u.role, designation, hours: ms / 3_600_000 }
  })

  // Kiosk-only staff: hours at the brand (or of unknown place) that a pool
  // member row cannot hold yet.
  for (const e of emps.filter((x) => !x.userId)) {
    const w = work.get(e.id)
    if (!w) continue
    const designation = e.designationId ? designationName.get(e.designationId) ?? null : null
    const who = { name: e.fullName, userId: null, employeeId: e.id, role: null, designation }
    let ms = 0
    for (const sp of w.spans) if (place(sp.locationId, undefined) !== 'elsewhere') ms += msWithin(sp, from, to)
    for (const o of w.open) if (place(o.locationId, undefined) !== 'elsewhere') ms += openMs(o)
    exclude(who, 'no_login', ms)
  }
  for (const x of excluded) x.hours = Number(x.hours.toFixed(2))
  return { worked, excluded: excluded.sort((a, b) => a.name.localeCompare(b.name)) }
}

/** One pool at a time per brand: creating, posting and paying take this. */
async function lockBrandPools(tx: Tx, conceptId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tippool:${conceptId}`}))`
}

/** A pool of this brand whose window shares any instant with [start, end). */
function overlappingPool(tx: Tx, conceptId: string, start: Date, end: Date, opts: { exceptId?: string; statuses?: Array<'draft' | 'posted' | 'paid'> } = {}) {
  return tx.tipPool.findFirst({
    where: {
      conceptId, periodStart: { lt: end }, periodEnd: { gt: start },
      ...(opts.exceptId && { id: { not: opts.exceptId } }),
      ...(opts.statuses && { status: { in: opts.statuses } }),
    },
    orderBy: { periodStart: 'asc' },
    select: { id: true, name: true, status: true, periodStart: true, periodEnd: true },
  })
}

const pktStamp = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')

function poolOverlap(clash: { id: string; name: string; status: string; periodStart: Date; periodEnd: Date }, what: string) {
  return new AppError(
    'POOL_OVERLAP',
    `${what}: the tips from ${pktStamp(clash.periodStart)} to ${pktStamp(clash.periodEnd)} are already in pool "${clash.name}" (${clash.status}). A tip can be pooled once — start this pool when that one ends${clash.status === 'draft' ? ', or delete that draft and compute again' : ''}.`,
    409,
    { poolId: clash.id, status: clash.status },
  )
}

type Distribution = 'equal' | 'by_hours' | 'by_role_weight'

/**
 * Who a brand's pool over [start, end) holds under the company's rules, and
 * whose hours it cannot hold (with the reason). Create stores `members`;
 * GET and post compute it again to show — and refuse on — anything that
 * changed or is missing.
 */
async function computePool(concept: { id: string; tenantId: string }, start: Date, end: Date, now = new Date()) {
  const cfg = await getOperationsConfig(concept.tenantId)
  const weights = tipPoolWeights(cfg)
  const mode = (cfg?.tipPoolDistribution ?? 'equal') as Distribution
  // A barista is a designation, not a login role.
  const weightOf = (w: { role: string | null; designation: string | null }) =>
    w.designation && /barista/i.test(w.designation) && weights['barista'] != null ? weights['barista']! : w.role ? weights[w.role] ?? 0 : 0
  const { worked, excluded } = await hoursAtBrand(concept, start, end, now)
  const members = worked.map((w) => {
    const weight = weightOf(w)
    const units = mode === 'equal' ? 1 : mode === 'by_hours' ? w.hours : w.hours * weight
    return { ...w, weight, units }
  }).filter((w) => w.hours > 0 && w.weight > 0)
  // Only people the pool would hold matter: a role with no weight is not in
  // it, whatever its hours. Kiosk-only staff have no login role, so they are
  // always listed.
  const relevant = excluded.filter((x) => x.reason === 'no_login' || weightOf(x) > 0)
  return { cfg, mode, members, excluded: relevant }
}

const fmtHours = (h: number) => `${h.toFixed(1)} h`
const REASON_TEXT: Record<ExcludedReason, string> = {
  no_branch: 'no branch is known for their punches — set their branch in HR (or roster them on this brand), then delete this draft and compute again',
  still_on_shift: 'still clocked in — compute the pool after they clock out',
  no_login: 'kiosk-only staff (no servd login) — a pool can only pay staff with a login: give them a login linked to their HR record, then delete this draft and compute again (or, if they are not in the tip pool, say so when posting)',
}

/** A till still holding tips from a pool's window: `open`, or `unposted` —
 *  closed, but its close is not on the books (yet). */
interface TillHoldingTips { shiftId: string; openedAt: Date; closedAt: Date | null; cashier: string; state: 'open' | 'unposted' }

/**
 * Tills holding this brand's tips from the window (audit PPL-R2-04,
 * RV-P-01). A till's tips reach Tips Payable 2095 only through its close
 * posting (accounting/shiftPosting.ts → `shift.close:<shiftId>`), which runs
 * after the till is marked closed and can be refused (a locked period, an
 * unbalanced entry — BOOKS-07 raises an exception, the till stays closed).
 * Posting or paying a pool before that posting is on the books would pay out
 * tips the books do not hold — 2095 in debit. So a till holds its tips until
 * its close entry exists, not merely until it is closed. Each tipped order's
 * tips belong to its home till (homeShiftOf — the one that books its sale);
 * tips on an order with no till receipt (online) post with the order itself.
 */
async function tillsHoldingTips(conceptId: string, periodStart: Date, periodEnd: Date): Promise<TillHoldingTips[]> {
  const orders = await prisma.order.findMany({
    where: {
      conceptId, deletedAt: null, tipCents: { gt: 0 },
      status: { in: ['completed', 'refunded'] }, completedAt: { gte: periodStart, lt: periodEnd },
      payments: { some: { shiftId: { not: null } } },
    },
    select: { payments: { select: { id: true, shiftId: true, method: true, status: true, gatewayRef: true, createdAt: true } } },
    take: 20_000,
  })
  const homeIds = new Set<string>()
  for (const o of orders) {
    const home = homeShiftOf(o)
    if (home) homeIds.add(home)
  }
  if (homeIds.size === 0) return []
  const shifts = await prisma.shift.findMany({
    where: { id: { in: Array.from(homeIds) } },
    select: { id: true, status: true, openedAt: true, closedAt: true, user: { select: { name: true, email: true } } },
  })
  const closedIds = shifts.filter((s) => s.status !== 'open').map((s) => s.id)
  const onBooks = closedIds.length
    ? new Set((await prisma.journalEntry.findMany({
        where: { reference: { in: closedIds.map((id) => `shift.close:${id}`) } },
        select: { reference: true },
      })).map((e) => e.reference!.slice('shift.close:'.length)))
    : new Set<string>()
  return shifts
    .filter((s) => s.status === 'open' || !onBooks.has(s.id))
    .map((s) => ({
      shiftId: s.id, openedAt: s.openedAt, closedAt: s.closedAt,
      cashier: s.user?.name ?? s.user?.email ?? 'a cashier',
      state: s.status === 'open' ? 'open' as const : 'unposted' as const,
    }))
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
}

/** Cash and bank codes a payout may come from: cash on hand, the drawer, the
 *  operating bank and its 102x children — plus any code a live bank account of
 *  the company points at (Configuration → Bank accounts). */
const PAYOUT_CASH_CODES = new Set<string>([ACCT.CASH_ON_HAND, ACCT.CASH_DRAWER, ACCT.BANK, '1021', '1022', '1023', '1024', '1025', '1026', '1027', '1028', '1029'])

/**
 * The account a tip payout is paid from (audit PPL-R2-03): the operating bank
 * when none is named, else an active cash/bank ASSET account in the pool's
 * own company's chart. Anything else — a revenue code, another company's
 * code, a code not in the chart — is 422, never a 500 or a posting that books
 * paid-out tips as revenue.
 */
async function payingAccount(tenantId: string, requested: string | undefined): Promise<string> {
  const code = (requested ?? '').trim() || ACCT.BANK
  const [account, bank] = await Promise.all([
    prisma.account.findFirst({ where: { tenantId, code }, select: { type: true, isActive: true, name: true } }),
    PAYOUT_CASH_CODES.has(code) ? Promise.resolve(null) : prisma.bankAccount.findFirst({ where: { tenantId, accountCode: code, deletedAt: null, isActive: true }, select: { id: true } }),
  ])
  if (!account || !account.isActive) {
    throw new AppError('ACCOUNT_NOT_IN_CHART', `Code ${code} is not an active account in this company's chart of accounts`, 422)
  }
  if (account.type !== 'asset' || (!PAYOUT_CASH_CODES.has(code) && !bank)) {
    throw new AppError('NOT_A_CASH_ACCOUNT', `${code} ${account.name} is not a cash or bank account — pay tips from cash (1010, 1015) or a bank account (1020 or a bank set up in Configuration → Bank accounts)`, 422)
  }
  return code
}

function tillText(tills: TillHoldingTips[]): string {
  const open = tills.filter((t) => t.state === 'open')
  const unposted = tills.filter((t) => t.state === 'unposted')
  const parts: string[] = []
  if (open.length) {
    parts.push(`${open.map((t) => `${t.cashier}'s till (opened ${pktStamp(t.openedAt)})`).join(', ')} ${open.length === 1 ? 'is' : 'are'} still open with tips from this window — close the till first, so its tips reach Tips Payable before they are paid out`)
  }
  if (unposted.length) {
    parts.push(`${unposted.map((t) => `${t.cashier}'s till (closed ${t.closedAt ? pktStamp(t.closedAt) : 'without a time'})`).join(', ')} closed but its takings did not reach the books — see Exceptions, and re-post it from Reconciliation → Backfill unposted, so its tips reach Tips Payable before they are paid out`)
  }
  return parts.join('; ')
}

/** What stands between a draft and posting it, computed now. */
async function reviewDraft(pool: { id: string; conceptId: string | null; periodStart: Date; periodEnd: Date; totalTipsCents: number; members: Array<{ userId: string }> }, now = new Date()) {
  if (!pool.conceptId) return null
  const concept = await prisma.concept.findUnique({ where: { id: pool.conceptId }, select: { id: true, tenantId: true } })
  if (!concept?.tenantId) return null
  const blockers: string[] = []
  if (pool.periodEnd > now) {
    blockers.push(`The window ends at ${pktStamp(pool.periodEnd)} — post it after the window is over, so every tip and every shift is in it`)
  }
  const tills = await tillsHoldingTips(pool.conceptId, pool.periodStart, pool.periodEnd)
  if (tills.length) blockers.push(tillText(tills))
  let computed: Awaited<ReturnType<typeof computePool>>
  try {
    computed = await computePool({ id: concept.id, tenantId: concept.tenantId }, pool.periodStart, pool.periodEnd, now)
  } catch (e) {
    // e.g. the brand lost its branch links since the draft was computed.
    if (e instanceof AppError) return { excluded: [], missing: [], kioskStaff: [], totalTipsNow: pool.totalTipsCents, blockers: [...blockers, e.message] }
    throw e
  }
  const { members, excluded } = computed
  const inDraft = new Set(pool.members.map((m) => m.userId))
  const missing = members.filter((m) => !inDraft.has(m.userId)).map((m) => ({ userId: m.userId, name: m.name, hours: Number(m.hours.toFixed(2)) }))
  if (missing.length) {
    blockers.push(`${missing.map((m) => `${m.name} (${fmtHours(m.hours)})`).join(', ')} worked the window but ${missing.length === 1 ? 'is' : 'are'} not in this draft — delete it and compute again`)
  }
  for (const x of excluded.filter((e) => e.reason !== 'no_login')) blockers.push(`${x.name}: ${fmtHours(x.hours)} not counted — ${REASON_TEXT[x.reason]}`)
  // Kiosk-only staff who worked the window at the brand (HR-R7): posting
  // waits for them unless the approver leaves them out by name (see post).
  const kioskStaff = excluded.filter((e) => e.reason === 'no_login')
  const tips = await prisma.order.aggregate({
    where: { status: { in: ['completed', 'refunded'] }, completedAt: { gte: pool.periodStart, lt: pool.periodEnd }, conceptId: pool.conceptId, deletedAt: null },
    _sum: { tipCents: true },
  })
  return { excluded, missing, kioskStaff, totalTipsNow: tips._sum.tipCents ?? 0, blockers }
}

/** The kiosk-only staff a post leaves out, by HR record, and why (HR-R7). */
const LeaveOutKiosk = z.object({
  employeeIds: z.array(z.string().uuid()).max(500),
  reason: z.string().trim().min(5).max(300),
})

export async function tipPoolRoutes(fastify: FastifyInstance) {
  // List
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...POOL_TEAM) },
    async (req) => {
      const inScope = await conceptIdsInScope(req, 'read')
      const ids = req.query.conceptId ? inScope.filter((c) => c === req.query.conceptId) : inScope
      return prisma.tipPool.findMany({
        where: { conceptId: { in: ids } },
        orderBy: { periodStart: 'desc' },
        include: { _count: { select: { members: true } }, },
        take: 50,
      })
    },
  )

  // GET /tip-pools/:id — full pool with members
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...POOL_TEAM) },
    async (req) => {
      const pool = await prisma.tipPool.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'read') } },
        include: { members: { orderBy: { userName: 'asc' } } },
      })
      if (!pool) throw new NotFoundError('TipPool', req.params.id)
      // A draft shows what posting would refuse on: hours left out (and why),
      // anyone who worked since it was computed, and the tips as they stand.
      return { ...pool, review: pool.status === 'draft' ? await reviewDraft(pool) : null }
    },
  )

  // Compute a draft pool for one brand — tips from its completed orders, hours
  // worked at its branches — split by the company's rules. The operator can
  // adjust shares before posting. Refused (409) when the window overlaps
  // another pool of the brand: those tips are already pooled.
  fastify.post<{ Body: { conceptId: string; name: string; periodStart: string; periodEnd: string } }>(
    '/',
    { preHandler: requireAuth(...POOL_TEAM) },
    async (req, reply) => {
      const body = z.object({
        // A pool belongs to a brand, and so to one company: tips and hours from
        // every company can never be pooled together, and post/pay look the
        // pool up by its brand.
        conceptId: z.string().uuid(),
        name: z.string().min(1).max(80),
        periodStart: z.string().datetime(),
        periodEnd:   z.string().datetime(),
      }).parse(req.body)
      const concept = await assertConceptOwned(req, body.conceptId, 'create')
      if (!concept.tenantId) throw new NotFoundError('Concept', body.conceptId)
      const periodStart = new Date(body.periodStart)
      const periodEnd   = new Date(body.periodEnd)
      if (!(periodEnd > periodStart)) throw new AppError('BAD_PERIOD', 'The period must end after it starts', 400)
      // The tips and the hours are added up once, here. A window still
      // running would freeze the tips taken so far and leave out the shifts
      // still open — and the overlap rule then stops the rest ever being
      // pooled (audit HR-R3). Compute a pool once its window is over.
      const now = new Date()
      if (periodEnd > now) {
        throw new AppError('PERIOD_NOT_OVER', `The window ends at ${pktStamp(periodEnd)} — compute the pool once it is over, so every tip and every shift is in it`, 422)
      }
      if (!(await getOperationsConfig(concept.tenantId))?.tipPoolEnabled) {
        throw new AppError('TIP_POOL_DISABLED', 'Tip pooling is switched off for this company — turn it on in Configuration → Operations', 422)
      }
      const { mode, members: worked, excluded } = await computePool({ id: concept.id, tenantId: concept.tenantId }, periodStart, periodEnd, now)

      const created = await prisma.$transaction(async (tx) => {
        await lockBrandPools(tx, concept.id)
        const clash = await overlappingPool(tx, concept.id, periodStart, periodEnd)
        if (clash) throw poolOverlap(clash, 'Not created')
        const tipAgg = await tx.order.aggregate({
          where: {
            status: { in: ['completed', 'refunded'] },  // tip stays even on refund — liability owed to staff
            // Half-open, like the overlap rule: an order at the boundary is in
            // exactly one of two back-to-back pools.
            completedAt: { gte: periodStart, lt: periodEnd },
            conceptId: concept.id,
            deletedAt: null,
          },
          _sum: { tipCents: true },
        })
        const pool = await tx.tipPool.create({
          data: {
            conceptId:    concept.id,
            name:         body.name,
            periodStart, periodEnd,
            totalTipsCents: tipAgg._sum.tipCents ?? 0,
            createdById:  req.staffUser?.id ?? null,
          },
        })
        if (worked.length) {
          await tx.tipPoolMember.createMany({
            data: worked.map((w) => ({
              poolId:      pool.id,
              userId:      w.userId,
              userName:    w.name,
              hoursWorked: Number(w.hours.toFixed(2)),
              roleWeight:  w.weight,
              shareUnits:  Number(w.units.toFixed(3)),
              shareCents:  0,
              notes:       mode === 'equal' ? 'equal share' : null,
            })),
          })
        }
        return tx.tipPool.findUniqueOrThrow({
          where: { id: pool.id },
          include: { members: { orderBy: { userName: 'asc' } } },
        })
      })
      // Hours the pool cannot hold are listed, never dropped silently (HR-R4,
      // HR-R7); posting is refused while any of them could still be placed.
      return reply.status(201).send({ ...created, distribution: mode, excluded, review: await reviewDraft(created, now) })
    },
  )

  // Delete a draft — to compute it again over a corrected window or after HR
  // fixed someone's punches. A posted or paid pool stays.
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...POOL_TEAM) },
    async (req, reply) => {
      const pool = await prisma.tipPool.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'write') } },
      })
      if (!pool) throw new NotFoundError('TipPool', req.params.id)
      const n = await prisma.tipPool.deleteMany({ where: { id: pool.id, status: 'draft' } })
      if (n.count === 0) throw new AppError('ALREADY_POSTED', `Pool is ${pool.status} — only a draft can be deleted`, 409)
      await audit({ category: 'accounting',
        action: 'tippool.delete_draft', entity: 'TipPool', entityId: pool.id,
        userId: req.staffUser?.id ?? null, tenantId: (pool.conceptId ? await tenantForConcept(pool.conceptId) : null) ?? req.staffUser?.tenantId ?? null, userEmail: req.staffUser?.email ?? null,
        before: { name: pool.name, totalCents: pool.totalTipsCents, periodStart: pool.periodStart, periodEnd: pool.periodEnd },
      })
      return reply.status(204).send()
    },
  )

  // Adjust a member share manually
  fastify.patch<{ Params: { memberId: string }; Body: { shareUnits?: number; notes?: string } }>(
    '/members/:memberId',
    { preHandler: requireAuth(...POOL_TEAM) },
    async (req) => {
      const body = z.object({
        shareUnits: z.number().min(0).max(1000).optional(),
        notes: z.string().max(300).optional(),
      }).parse(req.body)
      // Through its pool: a member of another company's pool is not found, and
      // shares are frozen once the pool is posted.
      const member = await prisma.tipPoolMember.findFirst({
        where: { id: req.params.memberId, pool: { conceptId: { in: await conceptIdsInScope(req, 'write') } } },
        include: { pool: { select: { status: true } } },
      })
      if (!member) throw new NotFoundError('TipPoolMember', req.params.memberId)
      if (member.pool.status !== 'draft') throw new AppError('ALREADY_POSTED', `Pool is ${member.pool.status}`, 422)
      return prisma.tipPoolMember.update({ where: { id: member.id }, data: body })
    },
  )

  // Post — locks the pool, computes per-member shareCents, no JE (liability
  // is already on the books from each order's tip).
  fastify.post<{ Params: { id: string }; Body: { leaveOutKioskStaff?: { employeeIds: string[]; reason: string } } | undefined }>(
    '/:id/post',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const body = z.object({ leaveOutKioskStaff: LeaveOutKiosk.optional() }).parse(req.body ?? {})
      // Tip pools belong to a brand, and therefore to one company. Looking one
      // up by bare id let a manager distribute another company's pool.
      const found = await prisma.tipPool.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'write') } },
        select: { id: true },
      })
      if (!found) throw new NotFoundError('TipPool', req.params.id)

      // Posting splits what the draft holds, so the draft must still be the
      // whole story (audit HR-R3 / HR-R4): the window is over, nobody who
      // worked it is missing from the draft, and no hours sit unplaced or on
      // a shift still open.
      //
      // Kiosk-only staff (no login) cannot be members yet (HR-R7). Posting
      // without them would split their share among the login holders, so it
      // waits until they have a login and the draft is computed again — unless
      // the approver names each of them as not in this pool, with a reason.
      const draft = await prisma.tipPool.findUniqueOrThrow({ where: { id: found.id }, include: { members: { select: { userId: true } } } })
      let kioskLeftOut: Array<{ employeeId: string | null; name: string; hours: number }> = []
      if (draft.status === 'draft') {
        const review = await reviewDraft(draft)
        if (review?.blockers.length) {
          throw new AppError('POOL_NOT_READY', `Not posted: ${review.blockers.join('. ')}.`, 409, review)
        }
        const kiosk = review?.kioskStaff ?? []
        const named = new Set(body.leaveOutKioskStaff?.employeeIds ?? [])
        const unnamed = kiosk.filter((k) => !k.employeeId || !named.has(k.employeeId))
        if (unnamed.length) {
          throw new AppError(
            'KIOSK_STAFF_NOT_IN_POOL',
            `Not posted: ${unnamed.map((k) => `${k.name} (${fmtHours(k.hours)})`).join(', ')} worked this window at the brand but ${unnamed.length === 1 ? 'has' : 'have'} no servd login, so the pool cannot pay them — posting now would give their share to the others. Give them a login linked to their HR record, delete this draft and compute again; or, if they are not in the tip pool, leave them out by name with a reason.`,
            409,
            review,
          )
        }
        kioskLeftOut = kiosk.map((k) => ({ employeeId: k.employeeId, name: k.name, hours: k.hours }))
      }

      const { pool, updated } = await prisma.$transaction(async (tx) => {
        const pool = await tx.tipPool.findUniqueOrThrow({ where: { id: found.id }, include: { members: true } })
        if (pool.conceptId) await lockBrandPools(tx, pool.conceptId)
        if (pool.status !== 'draft') throw new AppError('ALREADY_POSTED', `Pool is ${pool.status}`, 422)
        // The tips are added up again here, under the brand's lock: the total
        // posted is the window's tips as they stand, never a figure frozen
        // when the draft was computed.
        if (pool.conceptId) {
          const tips = await tx.order.aggregate({
            where: { status: { in: ['completed', 'refunded'] }, completedAt: { gte: pool.periodStart, lt: pool.periodEnd }, conceptId: pool.conceptId, deletedAt: null },
            _sum: { tipCents: true },
          })
          const total = tips._sum.tipCents ?? 0
          if (total !== pool.totalTipsCents) {
            await tx.tipPool.update({ where: { id: pool.id }, data: { totalTipsCents: total } })
            pool.totalTipsCents = total
          }
        }
        // A pool over tips another pool of the brand already distributed
        // (made before overlaps were refused) is never posted.
        if (pool.conceptId) {
          const clash = await overlappingPool(tx, pool.conceptId, pool.periodStart, pool.periodEnd, { exceptId: pool.id, statuses: ['posted', 'paid'] })
          if (clash) throw poolOverlap(clash, 'Not posted')
        }

        const totalUnits = pool.members.reduce((s, m) => s + m.shareUnits, 0)
        if (totalUnits <= 0) throw new AppError('NO_UNITS', 'Pool has no shareable hours', 422)

        // Distribute totalTipsCents proportionally; residue to last member
        let allocated = 0
        for (const [i, m] of pool.members.entries()) {
          const isLast = i === pool.members.length - 1
          const share = isLast
            ? pool.totalTipsCents - allocated
            : Math.floor((pool.totalTipsCents * m.shareUnits) / totalUnits)
          allocated += share
          await tx.tipPoolMember.update({ where: { id: m.id }, data: { shareCents: share } })
        }
        const n = await tx.tipPool.updateMany({ where: { id: pool.id, status: 'draft' }, data: { status: 'posted', postedAt: new Date() } })
        if (n.count === 0) throw new AppError('ALREADY_POSTED', 'Pool is no longer a draft', 422)
        const updated = await tx.tipPool.findUniqueOrThrow({ where: { id: pool.id }, include: { members: { orderBy: { userName: 'asc' } } } })
        return { pool, updated }
      })
      // The pool's own company (its brand's), never the operator's active one.
      const poolTenantId = (pool.conceptId ? await tenantForConcept(pool.conceptId) : null) ?? req.staffUser?.tenantId ?? null
      await audit({ category: 'accounting',
        action: 'tippool.post', entity: 'TipPool', entityId: pool.id,
        userId: req.staffUser?.id ?? null, tenantId: poolTenantId, userEmail: req.staffUser?.email ?? null,
        after: { totalCents: pool.totalTipsCents, members: updated.members.length },
        // Kiosk-only staff who worked the window and were left out on purpose
        // (HR-R7): who, their hours, and the approver's reason.
        ...(kioskLeftOut.length > 0 && { metadata: { kioskStaffLeftOut: kioskLeftOut, reason: body.leaveOutKioskStaff?.reason ?? null } }),
      })

      // Per-member audit row so each individual share is independently
      // verifiable. Without this, a manager could quietly give themselves a
      // bigger cut and the pool-level audit log wouldn't show it.
      for (const m of updated.members) {
        await audit({ category: 'accounting',
          action: 'tippool.distribute',
          entity: 'TipPoolMember',
          entityId: m.id,
          userId: req.staffUser?.id ?? null, tenantId: poolTenantId,
          userEmail: req.staffUser?.email ?? null,
          after: { recipient: m.userName, recipientId: m.userId, units: m.shareUnits, cents: m.shareCents },
          metadata: { tipPoolId: pool.id, totalPool: pool.totalTipsCents },
        })
      }

      // Outlier flag: if any member is taking > 40% of the pool, flag.
      // Indicates either a real high-units worker (legit, reviewer can
      // resolve) or a manipulated split.
      const big = updated.members.find((m) => m.shareCents > pool.totalTipsCents * 0.4)
      if (big && updated.members.length >= 3) {
        const { flagException } = await import('../../lib/exceptions.js')
        await flagException({
          tenantId: poolTenantId ?? req.staffUser!.tenantId,
          kind: 'high_value_void',
          severity: 'medium',
          title: `Tip pool: ${big.userName} taking ${((big.shareCents / pool.totalTipsCents) * 100).toFixed(0)}%`,
          description: `${big.userName} took ${((big.shareCents / pool.totalTipsCents) * 100).toFixed(0)}% of a PKR ${(pool.totalTipsCents / 100).toFixed(0)} pool across ${updated.members.length} members. Confirm units (${big.shareUnits}) reflect actual hours/role.`,
          entityType: 'TipPool',
          entityId: pool.id,
          actorId: req.staffUser?.id ?? null,
          amountCents: big.shareCents,
          metadata: { recipient: big.userName, totalCents: pool.totalTipsCents, units: big.shareUnits, memberCount: updated.members.length },
        })
      }

      return updated
    },
  )

  // Pay — disburses funds. Posts: Dr 2095 / Cr Bank. The status claim, the
  // overlap check and the posting are one transaction under the brand's lock:
  // the same tips are never paid twice, by a double click or by a second pool.
  fastify.post<{ Params: { id: string }; Body: { paidFromAccountCode?: string } }>(
    '/:id/pay',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const body = z.object({ paidFromAccountCode: z.string().optional() }).parse(req.body)
      const pool = await prisma.tipPool.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'write') } },
      })
      if (!pool) throw new NotFoundError('TipPool', req.params.id)
      if (pool.status !== 'posted') throw new AppError('NOT_POSTABLE', `Pool is ${pool.status}`, 422)

      const payoutTenantId = pool.conceptId
        ? (await prisma.concept.findUnique({ where: { id: pool.conceptId }, select: { tenantId: true } }))?.tenantId ?? req.staffUser!.tenantId
        : req.staffUser!.tenantId
      if (!payoutTenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before paying out a tip pool', 422)
      // The money leaves a cash or bank account of the pool's own company —
      // never a revenue or liability code (audit PPL-R2-03).
      const cashAccount = await payingAccount(payoutTenantId, body.paidFromAccountCode)
      // Tips in a till whose close is not on the books — still open, or
      // closed with its posting refused or not run yet — are not in Tips
      // Payable (PPL-R2-04, RV-P-01).
      if (pool.conceptId && pool.totalTipsCents > 0) {
        const tills = await tillsHoldingTips(pool.conceptId, pool.periodStart, pool.periodEnd)
        if (tills.length) throw new AppError('TILL_OPEN', `Not paid: ${tillText(tills)}.`, 409, { tills })
      }
      return prisma.$transaction(async (tx) => {
        if (pool.conceptId) {
          await lockBrandPools(tx, pool.conceptId)
          const clash = await overlappingPool(tx, pool.conceptId, pool.periodStart, pool.periodEnd, { exceptId: pool.id, statuses: ['paid'] })
          if (clash) throw poolOverlap(clash, 'Not paid')
        }
        const n = await tx.tipPool.updateMany({ where: { id: pool.id, status: 'posted' }, data: { status: 'paid', paidAt: new Date() } })
        if (n.count === 0) throw new AppError('NOT_POSTABLE', 'Pool is no longer posted — it may have just been paid', 422)
        if (pool.totalTipsCents > 0) {
          await postJournalEntry({
            tenantId: payoutTenantId,
            sourceType: 'tippool.payout',
            sourceId: pool.id,
            description: `Tip pool payout · ${pool.name}`,
            entryDate: new Date(),
            postedBy: req.staffUser?.id ?? 'system',
            lines: [
              { accountCode: ACCT.TIPS_PAYABLE, type: 'debit',  amountCents: pool.totalTipsCents, memo: 'Tips disbursed' },
              { accountCode: cashAccount,        type: 'credit', amountCents: pool.totalTipsCents, memo: 'Tips paid out' },
            ],
          }, { tx })
        }
        return tx.tipPool.findUniqueOrThrow({ where: { id: pool.id } })
      })
    },
  )
}
