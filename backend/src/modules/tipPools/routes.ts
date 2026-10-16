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
// A pool belongs to ONE company (TipPool.tenantId, HR-R7): created in the
// operator's ACTIVE company, for one of that company's brands. The pool's own
// company — never the operator's — decides who can see and edit it, the chart
// its payout posts to and the inbox its flags reach.
//
// Staff with no working servd login (kiosk / time-clock staff: an HR record
// only, or one whose login was deleted) are pool members like anyone else
// (tip_pool_members.employeeId), read from that company's attendance punches.
// Their tip-pool role is read strictly from their HR designation (or, with
// none, an exact department name) — see hrRoleKey. Someone whose HR record
// does not plainly say which role they work is never split silently: posting
// waits until an approver adds them on the draft with a weight, or records by
// name and with a reason that they are not in the pool (e.g. a security
// guard) — for all their hours, placed or not. That decision is audited.
//
// Paying out: one journal entry for the pool (Dr 2095 Tips Payable / Cr the
// cash or bank account the tips are paid from), and each member's share —
// login holder or employee alike — is recorded on their member row (name
// snapshot, shareCents) with its own audit entry. Tips are handed out by the
// company, not run through payroll.
//
// A tip is pooled once (audit PPL-01). A brand's pools may not overlap in
// time — the window is half-open, [periodStart, periodEnd), so back-to-back
// pools share no instant and no order. Posting and paying re-check it under
// the brand's lock, so two pools over the same tips (left from before this
// rule) can never both be paid. A draft can be deleted and computed again.
// (Stamping each pooled order with its pool would need an orders column —
// see the report.)

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma, type UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval, delegatedTenantsByType } from '../../lib/approvalRights.js'
import { widenRls } from '../../lib/headOffice.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { postJournalEntry, ACCT } from '../accounting/journal.js'
import { homeShiftOf } from '../accounting/orderPosting.js'
import { conceptIdsInScope, assertConceptOwned, scopeTenantWhere, activeTenantId } from '../../lib/tenantScope.js'
import { flagException } from '../../lib/exceptions.js'
import { getOperationsConfig, tipPoolWeights, getGeofenceConfig } from '../../lib/setup-config.js'
import { nearestAnchor } from '../timeclock/policy.js'
import { attendanceKeys, isMissedClockOut, MISSING_PUNCH_AFTER_MS, type PunchEntry } from '../hr/attendance.js'
import { getFormat } from '../hr/service.js'
import { rotaFor, toMinutes, ymd } from '../hr/rota.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'

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
export const POOL_TEAM = Array.from(new Set([...MANAGERS, 'finance', 'hr'])) as UserRole[]

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
  /** staff with no servd login whose HR designation / department does not
   *  say which tip-pool role they work (HR-R7). Posting waits until they are
   *  added on the draft with a weight, or left out by name with a reason. */
  | 'no_role'

export interface ExcludedHours {
  name: string
  userId: string | null
  employeeId: string | null
  role: string | null
  designation: string | null
  hours: number
  reason: ExcludedReason
}

/** Someone who worked at the brand: a login holder (userId) or, with no
 *  login, an HR employee (employeeId, userId null). */
export interface WorkedAtBrand { userId: string | null; employeeId: string | null; name: string; role: string | null; designation: string | null; hours: number }

/** A pool member's identity: the login when there is one, else the HR record. */
export const memberKey = (m: { userId: string | null; employeeId: string | null }) =>
  m.userId ? `u:${m.userId}` : `e:${m.employeeId}`

/** Jobs that are never tip-pool roles, whatever else the title says
 *  ("Ghost Kitchen Driver", "Maintenance Helper", "Security Guard"). */
const NOT_TIP_STAFF = /\b(?:drivers?|riders?|delivery|security|guards?|maintenance|electricians?|plumbers?|technicians?|mechanics?|accountants?|accounts|office|admin|clerks?|cleaners?|janitors?|sweepers?|gardeners?|mali|chowkidar|watchman|peon)\b/i
/** A designation that names a tip-pool role — whole words only. */
const DESIGNATION_ROLE: Array<[RegExp, string]> = [
  [/\bbaristas?\b/i, 'barista'],
  [/\bcashiers?\b/i, 'cashier'],
  [/\bexpedit(?:er|or)s?\b|\bexpo\b/i, 'expediter'],
  [/\b(?:servers?|waiters?|waitress(?:es)?|waitstaff|host(?:ess)?(?:es|s)?|front of house|foh)\b/i, 'foh'],
  [/\b(?:cooks?|chefs?|commis|grill(?:er)?|tandoori?(?:ya|a)?|dishwashers?|boh|back of house|kitchen (?:helper|hand|assistant|porter|staff)s?)\b/i, 'kitchen'],
]
/** Department names that name a tip-pool role — exact names only. */
const DEPARTMENT_ROLE: Record<string, string> = {
  'kitchen': 'kitchen', 'main kitchen': 'kitchen', 'boh': 'kitchen', 'back of house': 'kitchen',
  'foh': 'foh', 'front of house': 'foh',
}

/**
 * The tip-pool role of someone with no login, from their HR record: the
 * weight keys of /configuration/operations (TIP_POOL_DEFAULT_WEIGHTS — foh,
 * cashier, barista, kitchen, boh, expediter). Null when the record does not
 * plainly say — the pool then asks (reason 'no_role') rather than guess.
 *
 * Strict on purpose (review D-RV-1: "Security Guard" in "Security Services"
 * matched /service/ and took half the pot). The designation decides when
 * there is one: a tip role named as a whole word, and nothing that names a
 * non-tip job (driver, guard, maintenance…). An unrecognised designation is
 * null — the department is NOT read then. Only someone with no designation
 * falls back to the department, and only an exact Kitchen / Main Kitchen /
 * BOH / Back of House / FOH / Front of House.
 */
export function hrRoleKey(designation: string | null, department: string | null): string | null {
  const title = designation?.trim()
  if (title) {
    if (NOT_TIP_STAFF.test(title)) return null
    for (const [re, role] of DESIGNATION_ROLE) if (re.test(title)) return role
    return null
  }
  const dept = department?.trim().toLowerCase().replace(/\s+/g, ' ')
  return dept ? DEPARTMENT_ROLE[dept] ?? null : null
}

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
 * known branch or still on shift. Staff with no login (kiosk / time-clock)
 * are in `worked` with their employeeId and the role their HR record gives.
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
  // Everyone with attendance here is read: a login holder of this company by
  // their login, and everyone else — no login, a login since deleted, or a
  // login that is not (any more) of this company — as staff with no login,
  // by HR record (review D-RV-2: someone whose login was deleted was in
  // neither group and their hours were dropped without a word).
  const attendedIds = Array.from(new Set(attendance.map((a) => a.employeeId!)))
  const emps = await prisma.hrEmployee.findMany({
    where: { tenantId, OR: [{ userId: { in: Array.from(userIds) } }, { id: { in: attendedIds } }] },
    select: { id: true, userId: true, fullName: true, designationId: true, departmentId: true, locationId: true },
  })
  /** No working login of this company: read by HR record, never by login. */
  const noLogin = (e: { userId: string | null }) => !e.userId || !userIds.has(e.userId)
  const empByUser = new Map(emps.filter((e) => !noLogin(e)).map((e) => [e.userId!, e]))
  const designations = await prisma.hrOrgUnit.findMany({ where: { tenantId, id: { in: emps.map((e) => e.designationId).filter(Boolean) as string[] } }, select: { id: true, name: true } })
  const designationName = new Map(designations.map((d) => [d.id, d.name]))
  const kioskDeptIds = emps.filter((e) => noLogin(e) && e.departmentId).map((e) => e.departmentId!)
  const departments = kioskDeptIds.length ? await prisma.department.findMany({ where: { tenantId, id: { in: kioskDeptIds } }, select: { id: true, name: true } }) : []
  const departmentName = new Map(departments.map((d) => [d.id, d.name]))
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
  const needRota = soleBrand ? [] : emps.filter((e) => !noLogin(e) && (work.get(e.id)?.spans.some((sp) => !sp.locationId) || work.get(e.id)?.open.some((o) => !o.locationId)))
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

  const worked: WorkedAtBrand[] = users.map((u) => {
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
    return { userId: u.id, employeeId: emp?.id ?? null, name: u.name, role: u.role, designation, hours: ms / 3_600_000 }
  })

  // Staff with no working login (kiosk / time-clock, or a login since
  // deleted or not of this company): their own attendance punches,
  // placed by the punch's branch or their HR branch (the rota's brand is read
  // from /scheduling shifts, which only login holders have). Their role is
  // what their HR record says (hrRoleKey).
  for (const e of emps.filter(noLogin)) {
    const w = work.get(e.id)
    if (!w) continue
    const designation = e.designationId ? designationName.get(e.designationId) ?? null : null
    const role = hrRoleKey(designation, e.departmentId ? departmentName.get(e.departmentId) ?? null : null)
    const who = { name: e.fullName, userId: null, employeeId: e.id, role, designation }
    let ms = 0
    for (const sp of w.spans) {
      const where = place(sp.locationId, undefined)
      if (where === 'here') ms += msWithin(sp, from, to)
      else if (where === 'unknown') exclude(who, 'no_branch', msWithin(sp, from, to))
    }
    for (const o of w.open) if (place(o.locationId, undefined) !== 'elsewhere') exclude(who, 'still_on_shift', openMs(o))
    worked.push({ userId: null, employeeId: e.id, name: e.fullName, role, designation, hours: ms / 3_600_000 })
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
    const units = unitsFor(mode, w.hours, weight)
    return { ...w, weight, units }
  }).filter((w) => w.hours > 0 && w.weight > 0)
  // Staff with no login whose HR record names no tip-pool role: the pool
  // cannot tell whether they are in it, so it asks (HR-R7) — about ALL their
  // hours in the window: placed at the brand, with no known branch, or on a
  // shift still open (review D-RV-4). Whether they are in the pool comes
  // first; an approver who says they are not (a guard) must be able to say so
  // by name, so their unplaced hours are never a blocker of their own.
  const unknownRole = (x: { userId: string | null; role: string | null; designation: string | null }) => !x.userId && x.role == null && weightOf(x) === 0
  const asked = new Map<string, ExcludedHours>()
  for (const w of worked) {
    if (!unknownRole(w) || !w.employeeId) continue
    asked.set(w.employeeId, { name: w.name, userId: null, employeeId: w.employeeId, role: null, designation: w.designation, hours: w.hours, reason: 'no_role' })
  }
  const rest: ExcludedHours[] = []
  for (const x of excluded) {
    const row = x.employeeId && unknownRole(x) ? asked.get(x.employeeId) : undefined
    if (row) row.hours += x.hours
    else rest.push(x)
  }
  for (const row of asked.values()) {
    row.hours = Number(row.hours.toFixed(2))
    if (row.hours > 0) rest.push(row)
  }
  // Only people the pool would hold matter: a role with no weight is not in
  // it, whatever its hours. Staff with no login and no known role are asked
  // about (no_role) above.
  const relevant = rest.filter((x) => x.reason === 'no_role' || weightOf(x) > 0)
  return { cfg, mode, weightOf, members, excluded: relevant.sort((a, b) => a.name.localeCompare(b.name)) }
}

const unitsFor = (mode: Distribution, hours: number, weight: number) =>
  mode === 'equal' ? 1 : mode === 'by_hours' ? hours : hours * weight

const fmtHours = (h: number) => `${h.toFixed(1)} h`
const REASON_TEXT: Record<ExcludedReason, string> = {
  no_branch: 'no branch is known for their punches — set their branch in HR (or roster them on this brand), then delete this draft and compute again',
  still_on_shift: 'still clocked in — compute the pool after they clock out',
  no_role: 'no servd login, and their HR designation does not say which tip-pool role they work — add them on this draft with a weight, set their designation in HR and compute again, or, if they are not in the tip pool, say so when posting',
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
 * The account a tip payout is paid from (audit PPL-R2-03; finance audit
 * 2026-10-17 item 7): with no code named, `moneyAccountCode` of the pool's
 * company for the chosen method (cash, or a bank); with a code (legacy
 * `paidFromAccountCode`), an active cash/bank ASSET account in the pool's
 * own company's chart. Anything else — a revenue code, another company's
 * code, a code not in the chart — is 422, never a 500 or a posting that books
 * paid-out tips as revenue.
 */
async function payingAccount(
  tenantId: string,
  input: { paidFromAccountCode?: string; method?: string; bankAccountId?: string | null },
): Promise<string> {
  const requested = (input.paidFromAccountCode ?? '').trim()
  // No code named: THE money-account rule (lib/bankAccounts.ts
  // moneyAccountCode) in the pool's company — cash → 1010, a bank → the named
  // live linked bank, else the company's only bank, 1020 when it has none,
  // 422 BANK_ACCOUNT_REQUIRED when it has two or more. Never a silent 1020.
  if (!requested) {
    const method = (input.method ?? '').trim() || 'bank_transfer'
    if (method !== 'cash' && !['bank', 'bank_transfer', 'bank_deposit', 'cheque'].includes(method)) {
      throw new AppError('BAD_PAYMENT_METHOD', 'Tips are paid in cash or from a bank account', 422)
    }
    return (await moneyAccountCode(prisma, tenantId, { method, bankAccountId: input.bankAccountId ?? null })).code
  }
  const code = requested
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

type PoolForReview = {
  id: string; tenantId: string; conceptId: string | null; periodStart: Date; periodEnd: Date; totalTipsCents: number
  members: Array<{ userId: string | null; employeeId: string | null }>
}

/** What stands between a draft and posting it, computed now. */
async function reviewDraft(pool: PoolForReview, now = new Date()) {
  if (!pool.conceptId) return null
  const concept = await prisma.concept.findUnique({ where: { id: pool.conceptId }, select: { id: true, tenantId: true } })
  if (!concept?.tenantId) return null
  const blockers: string[] = []
  // The brand moved to another company since the draft: its tips and hours
  // are that company's now, never this pool's.
  if (concept.tenantId !== pool.tenantId) {
    return { excluded: [], missing: [], staffWithoutRole: [], totalTipsNow: pool.totalTipsCents, blockers: ['This brand now belongs to another company — delete this draft and compute the pool in that company'] }
  }
  if (pool.periodEnd > now) {
    blockers.push(`The window ends at ${pktStamp(pool.periodEnd)} — post it after the window is over, so every tip and every shift is in it`)
  }
  const tills = await tillsHoldingTips(pool.conceptId, pool.periodStart, pool.periodEnd)
  if (tills.length) blockers.push(tillText(tills))
  let computed: Awaited<ReturnType<typeof computePool>>
  try {
    computed = await computePool({ id: concept.id, tenantId: pool.tenantId }, pool.periodStart, pool.periodEnd, now)
  } catch (e) {
    // e.g. the brand lost its branch links since the draft was computed.
    if (e instanceof AppError) return { excluded: [], missing: [], staffWithoutRole: [], totalTipsNow: pool.totalTipsCents, blockers: [...blockers, e.message] }
    throw e
  }
  const { members, excluded } = computed
  const inDraft = new Set(pool.members.map(memberKey))
  const missing = members.filter((m) => !inDraft.has(memberKey(m))).map((m) => ({ userId: m.userId, employeeId: m.employeeId, name: m.name, hours: Number(m.hours.toFixed(2)) }))
  if (missing.length) {
    blockers.push(`${missing.map((m) => `${m.name} (${fmtHours(m.hours)})`).join(', ')} worked the window but ${missing.length === 1 ? 'is' : 'are'} not in this draft — delete it and compute again`)
  }
  for (const x of excluded.filter((e) => e.reason !== 'no_role')) blockers.push(`${x.name}: ${fmtHours(x.hours)} not counted — ${REASON_TEXT[x.reason]}`)
  // Staff with no login and no known role who worked the window at the
  // brand (HR-R7), and are not on the draft: posting waits for them unless
  // the approver leaves them out by name (see post).
  const staffWithoutRole = excluded.filter((e) => e.reason === 'no_role' && !inDraft.has(memberKey(e)))
  const tips = await prisma.order.aggregate({
    where: { status: { in: ['completed', 'refunded'] }, completedAt: { gte: pool.periodStart, lt: pool.periodEnd }, conceptId: pool.conceptId, deletedAt: null },
    _sum: { tipCents: true },
  })
  return { excluded: excluded.filter((e) => e.reason !== 'no_role' || !inDraft.has(memberKey(e))), missing, staffWithoutRole, totalTipsNow: tips._sum.tipCents ?? 0, blockers }
}

/**
 * Members of a pool who are not (any more) of the pool's company: a login
 * that is neither based in nor a member of it, or an HR record of another
 * company. Never paid from this company's pool.
 */
async function membersOutsideCompany(tenantId: string, members: Array<{ userId: string | null; employeeId: string | null; userName: string }>): Promise<string[]> {
  const userIds = members.map((m) => m.userId).filter((x): x is string => !!x)
  const empIds = members.map((m) => m.employeeId).filter((x): x is string => !!x)
  const [users, emps] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] }, select: { id: true } }) : [],
    empIds.length ? prisma.hrEmployee.findMany({ where: { id: { in: empIds }, tenantId }, select: { id: true } }) : [],
  ])
  const ok = new Set([...users.map((u) => u.id), ...emps.map((e) => e.id)])
  return members.filter((m) => !ok.has((m.userId ?? m.employeeId)!)).map((m) => m.userName)
}

/** A pool in the operator's companies for `mode`, or 404. */
async function poolInScope(req: FastifyRequest, id: string, mode: 'read' | 'write') {
  const pool = await prisma.tipPool.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) } })
  if (!pool) throw new NotFoundError('TipPool', id)
  return pool
}

/**
 * D3: the right to post or pay a pool (spec §7.3). The pool's own company
 * (TipPool.tenantId, A19) decides: the role path is today's APPROVERS in the
 * caller's member companies; a Finance hand-over from a head office that
 * serves the company also passes. Separation of duties: whoever computed the
 * draft (createdById) never posts or pays it (the CEO excepted), and a pool
 * created through a head office goes to the CEO or that head office's
 * delegate, never the company's own owners. The facts are read on
 * serviceClient (A5); on success the request's RLS context covers the pool's
 * company, so the pool is then read by id.
 */
async function poolDecision(req: FastifyRequest, id: string, action: 'post' | 'pay') {
  const s = await approvalSubject('tip_pool', id)
  if (!s) throw new NotFoundError('TipPool', id)
  const grant = await assertCanApprove(req, approvalInputOf('tip_pool', id, s, { entity: 'TipPool', action: `${action} a tip pool` }))
  const pool = await prisma.tipPool.findUnique({ where: { id } })
  if (!pool) throw new NotFoundError('TipPool', id)
  return { pool, grant }
}

/**
 * Read scope for the pool screens: the companies in view, plus — for a
 * delegate — the companies a live Finance hand-over of tip pools covers
 * (whatever the view), so the delegate can review what they are asked to post.
 */
async function poolReadWhere(req: FastifyRequest): Promise<Prisma.TipPoolWhereInput> {
  const scope = await scopeTenantWhere(req, 'read')
  const delegated = [...((await delegatedTenantsByType(req.staffUser?.id ?? '')).get('tip_pool') ?? [])]
  if (delegated.length === 0) return scope
  widenRls(req, delegated)
  return { OR: [scope, { tenantId: { in: delegated } }] }
}

const MEMBER_INCLUDE = {
  members: {
    orderBy: { userName: 'asc' as const },
    include: { employee: { select: { employeeCode: true } } },
  },
}

/** Staff with no known role a post leaves out, by HR record, and why (HR-R7). */
const LeaveOutStaff = z.object({
  employeeIds: z.array(z.string().uuid()).max(500),
  reason: z.string().trim().min(5).max(300),
})

export async function tipPoolRoutes(fastify: FastifyInstance) {
  // List
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...POOL_TEAM) },
    async (req) => {
      // The pool's own company (view-aware), narrowed to a brand when one is
      // asked for or picked in the global brand filter.
      const inScope = await conceptIdsInScope(req, 'read')
      // D3: a delegate also sees the pools of the companies handed to them.
      const delegated = [...((await delegatedTenantsByType(req.staffUser?.id ?? '')).get('tip_pool') ?? [])]
      if (delegated.length > 0) {
        widenRls(req, delegated)
        const theirs = await prisma.concept.findMany({ where: { tenantId: { in: delegated }, deletedAt: null }, select: { id: true } })
        for (const c of theirs) if (!inScope.includes(c.id)) inScope.push(c.id)
      }
      const ids = req.query.conceptId ? inScope.filter((c) => c === req.query.conceptId) : inScope
      return prisma.tipPool.findMany({
        where: {
          AND: [
            await poolReadWhere(req),
            req.query.conceptId ? { conceptId: { in: ids } } : { OR: [{ conceptId: { in: ids } }, { conceptId: null }] },
          ],
        },
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
        where: { AND: [{ id: req.params.id }, await poolReadWhere(req)] },
        include: MEMBER_INCLUDE,
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
        // A pool belongs to a brand of the ACTIVE company: tips and hours from
        // two companies can never be pooled together.
        conceptId: z.string().uuid(),
        name: z.string().min(1).max(80),
        periodStart: z.string().datetime(),
        periodEnd:   z.string().datetime(),
      }).parse(req.body)
      // The pool binds to the operator's ACTIVE company; its brand must be
      // that company's. A brand of another of the operator's companies is a
      // cross-company attach (422); one outside them all is 404.
      const tenantId = activeTenantId(req, 'a tip pool belongs to one company')
      const owned = await assertConceptOwned(req, body.conceptId, 'write')
      if (owned.tenantId !== tenantId) {
        throw new AppError('BRAND_NOT_IN_COMPANY', 'That brand belongs to another company — switch to it to pool its tips', 422)
      }
      const concept = { id: owned.id, tenantId }
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
            tenantId:     concept.tenantId,
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
              // A login holder by login; staff with no login by HR record —
              // exactly one (CHECK tip_pool_members_one_person).
              userId:      w.userId,
              employeeId:  w.userId ? null : w.employeeId,
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
          include: MEMBER_INCLUDE,
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
      const pool = await poolInScope(req, req.params.id, 'write')
      // To the Trash WITH its members (modules/trash), in the delete's
      // transaction; the conditional delete keeps a posted pool where it is.
      await prisma.$transaction(async (tx) => {
        const members = await tx.tipPoolMember.findMany({ where: { poolId: pool.id } })
        await moveToTrash(tx, req, {
          type: 'tip_pool', entityId: pool.id, tenantId: pool.tenantId, conceptId: pool.conceptId,
          title: pool.name, subtitle: `${members.length} member(s)`, reason: trashReasonOf(req),
          snapshot: takeSnapshot('TipPool', pool, { TipPoolMember: members }),
        })
        const n = await tx.tipPool.deleteMany({ where: { id: pool.id, status: 'draft' } })
        if (n.count === 0) throw new AppError('ALREADY_POSTED', `Pool is ${pool.status} — only a draft can be deleted`, 409)
      })
      await audit({ category: 'accounting',
        action: 'tippool.delete_draft', entity: 'TipPool', entityId: pool.id,
        userId: req.staffUser?.id ?? null, tenantId: pool.tenantId, userEmail: req.staffUser?.email ?? null,
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
        where: { id: req.params.memberId, pool: await scopeTenantWhere(req, 'write') },
        include: { pool: { select: { status: true } } },
      })
      if (!member) throw new NotFoundError('TipPoolMember', req.params.memberId)
      if (member.pool.status !== 'draft') throw new AppError('ALREADY_POSTED', `Pool is ${member.pool.status}`, 422)
      return prisma.tipPoolMember.update({ where: { id: member.id }, data: body })
    },
  )

  // Who can be added to a draft by hand: the pool's company's current HR
  // employees not already in it (name, code, designation — nothing else).
  fastify.get<{ Params: { id: string } }>(
    '/:id/candidates',
    { preHandler: requireAuth(...POOL_TEAM) },
    async (req) => {
      const pool = await poolInScope(req, req.params.id, 'write')
      const members = await prisma.tipPoolMember.findMany({ where: { poolId: pool.id }, select: { userId: true, employeeId: true } })
      const inPool = new Set(members.map(memberKey))
      const emps = await prisma.hrEmployee.findMany({
        where: { tenantId: pool.tenantId, status: { in: ['active', 'on_leave'] } },
        select: { id: true, employeeCode: true, fullName: true, userId: true, designationId: true },
        orderBy: { fullName: 'asc' },
        take: 2000,
      })
      const designations = await prisma.hrOrgUnit.findMany({
        where: { tenantId: pool.tenantId, id: { in: emps.map((e) => e.designationId).filter((x): x is string => !!x) } },
        select: { id: true, name: true },
      })
      const designation = new Map(designations.map((d) => [d.id, d.name]))
      return emps
        .filter((e) => !inPool.has(`e:${e.id}`) && !(e.userId && inPool.has(`u:${e.userId}`)))
        .map((e) => ({ employeeId: e.id, employeeCode: e.employeeCode, name: e.fullName, designation: e.designationId ? designation.get(e.designationId) ?? null : null, hasLogin: !!e.userId }))
    },
  )

  // Add someone to a draft by hand — typically staff with no servd login
  // whose HR record does not say their tip-pool role (HR-R7), or anyone the
  // punches missed. Either an HR employee (employeeId) or a login (userId);
  // an employee who has a login is added by that login, the way the pool
  // builder adds them. They must be of the POOL's company (422 otherwise).
  fastify.post<{ Params: { id: string } }>(
    '/:id/members',
    { preHandler: requireAuth(...POOL_TEAM) },
    async (req, reply) => {
      const body = z.object({
        employeeId:  z.string().uuid().optional(),
        userId:      z.string().uuid().optional(),
        hoursWorked: z.number().min(0).max(1000),
        // Defaults to the weight of the role their login / HR record gives.
        roleWeight:  z.number().min(0).max(10).optional(),
        notes:       z.string().trim().max(300).optional(),
      }).refine((b) => !!b.employeeId !== !!b.userId, { message: 'Give exactly one of employeeId or userId' }).parse(req.body)
      const pool = await poolInScope(req, req.params.id, 'write')
      if (pool.status !== 'draft') throw new AppError('ALREADY_POSTED', `Pool is ${pool.status} — only a draft takes new members`, 422)

      let who: { userId: string | null; employeeId: string | null; name: string; role: string | null; designation: string | null }
      if (body.employeeId) {
        const emp = await prisma.hrEmployee.findFirst({
          where: { id: body.employeeId, tenantId: pool.tenantId },
          select: { id: true, userId: true, fullName: true, designationId: true, departmentId: true },
        })
        if (!emp) throw new AppError('MEMBER_NOT_IN_COMPANY', 'That employee is not on this pool\'s company\'s HR records', 422)
        const [designation, department, user] = await Promise.all([
          emp.designationId ? prisma.hrOrgUnit.findFirst({ where: { id: emp.designationId, tenantId: pool.tenantId }, select: { name: true } }) : null,
          emp.departmentId ? prisma.department.findFirst({ where: { id: emp.departmentId, tenantId: pool.tenantId }, select: { name: true } }) : null,
          emp.userId ? prisma.user.findFirst({ where: { id: emp.userId, deletedAt: null }, select: { id: true, role: true } }) : null,
        ])
        who = {
          userId: user?.id ?? null, employeeId: user ? null : emp.id, name: emp.fullName,
          role: user ? user.role : hrRoleKey(designation?.name ?? null, department?.name ?? null),
          designation: designation?.name ?? null,
        }
      } else {
        const user = await prisma.user.findFirst({
          where: { id: body.userId!, deletedAt: null, OR: [{ tenantId: pool.tenantId }, { tenantMemberships: { some: { tenantId: pool.tenantId } } }] },
          select: { id: true, name: true, role: true },
        })
        if (!user) throw new AppError('MEMBER_NOT_IN_COMPANY', 'That login is not part of this pool\'s company', 422)
        who = { userId: user.id, employeeId: null, name: user.name, role: user.role, designation: null }
      }

      const cfg = await getOperationsConfig(pool.tenantId)
      const weights = tipPoolWeights(cfg)
      const mode = (cfg?.tipPoolDistribution ?? 'equal') as Distribution
      const derived = who.designation && /barista/i.test(who.designation) && weights['barista'] != null ? weights['barista']! : who.role ? weights[who.role] ?? 0 : 0
      const weight = body.roleWeight ?? derived
      if (!(weight > 0)) {
        throw new AppError('ROLE_WEIGHT_REQUIRED', `${who.name}'s role carries no tip-pool weight — give a weight (e.g. 0.5 for kitchen) to add them`, 422)
      }
      const dup = await prisma.tipPoolMember.findFirst({
        where: { poolId: pool.id, ...(who.userId ? { userId: who.userId } : { employeeId: who.employeeId }) },
        select: { id: true },
      })
      if (dup) throw new AppError('ALREADY_IN_POOL', `${who.name} is already in this pool`, 409)
      let member
      try {
        member = await prisma.tipPoolMember.create({
          data: {
            poolId: pool.id, userId: who.userId, employeeId: who.employeeId, userName: who.name,
            hoursWorked: Number(body.hoursWorked.toFixed(2)), roleWeight: weight,
            shareUnits: Number(unitsFor(mode, body.hoursWorked, weight).toFixed(3)), shareCents: 0,
            notes: body.notes || 'added by hand',
          },
        })
      } catch (e) {
        // The partial unique index, on a race with another add.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('ALREADY_IN_POOL', `${who.name} is already in this pool`, 409)
        throw e
      }
      await audit({ category: 'accounting',
        action: 'tippool.add_member', entity: 'TipPoolMember', entityId: member.id,
        userId: req.staffUser?.id ?? null, tenantId: pool.tenantId, userEmail: req.staffUser?.email ?? null,
        after: { recipient: who.name, userId: who.userId, employeeId: who.employeeId, hours: member.hoursWorked, weight, units: member.shareUnits },
        metadata: { tipPoolId: pool.id },
      })
      return reply.status(201).send(member)
    },
  )

  // Post — locks the pool, computes per-member shareCents, no JE (liability
  // is already on the books from each order's tip).
  fastify.post<{ Params: { id: string }; Body: { leaveOutStaff?: { employeeIds: string[]; reason: string }; leaveOutKioskStaff?: { employeeIds: string[]; reason: string } } | undefined }>(
    '/:id/post',
    // D3: APPROVERS of the pool's company, or a Finance hand-over — assertCanApprove decides.
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({ leaveOutStaff: LeaveOutStaff.optional(), leaveOutKioskStaff: LeaveOutStaff.optional() }).parse(req.body ?? {})
      // `leaveOutKioskStaff` is the field's old name (until 2026-10-12).
      const leaveOut = body.leaveOutStaff ?? body.leaveOutKioskStaff
      // The pool's own company decides — another company's pool is not found.
      const { pool: found, grant } = await poolDecision(req, req.params.id, 'post')

      // Posting splits what the draft holds, so the draft must still be the
      // whole story (audit HR-R3 / HR-R4): the window is over, nobody who
      // worked it is missing from the draft, and no hours sit unplaced or on
      // a shift still open.
      //
      // Staff with no login whose HR record names no tip-pool role (HR-R7):
      // posting without them would split their share among the others, so it
      // waits until they are added on the draft — unless the approver names
      // each of them as not in this pool, with a reason.
      const draft = await prisma.tipPool.findUniqueOrThrow({ where: { id: found.id }, include: { members: { select: { userId: true, employeeId: true, userName: true } } } })
      let leftOut: Array<{ employeeId: string | null; name: string; hours: number }> = []
      if (draft.status === 'draft') {
        const review = await reviewDraft(draft)
        if (review?.blockers.length) {
          throw new AppError('POOL_NOT_READY', `Not posted: ${review.blockers.join('. ')}.`, 409, review)
        }
        const unknown = review?.staffWithoutRole ?? []
        const named = new Set(leaveOut?.employeeIds ?? [])
        const unnamed = unknown.filter((k) => !k.employeeId || !named.has(k.employeeId))
        if (unnamed.length) {
          throw new AppError(
            'STAFF_ROLE_UNKNOWN',
            `Not posted: ${unnamed.map((k) => `${k.name} (${fmtHours(k.hours)})`).join(', ')} worked this window at the brand, but ${unnamed.length === 1 ? 'their' : 'these people\'s'} HR record does not say which tip-pool role they work — posting now would give their share to the others. Add them on the draft with a weight (or set their designation in HR, delete this draft and compute again); or, if they are not in the tip pool, leave them out by name with a reason.`,
            409,
            review,
          )
        }
        leftOut = unknown.map((k) => ({ employeeId: k.employeeId, name: k.name, hours: k.hours }))
        // Every member is of the pool's company — never pay another
        // company's staff from this company's tips.
        const outside = await membersOutsideCompany(draft.tenantId, draft.members)
        if (outside.length) {
          throw new AppError('MEMBER_NOT_IN_COMPANY', `Not posted: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not part of this pool's company — delete this draft and compute again`, 422)
        }
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
        const updated = await tx.tipPool.findUniqueOrThrow({ where: { id: pool.id }, include: MEMBER_INCLUDE })
        return { pool, updated }
      })
      // The pool's own company, never the operator's active one.
      const poolTenantId = pool.tenantId
      await audit({ category: 'accounting',
        action: 'tippool.post', entity: 'TipPool', entityId: pool.id,
        userId: req.staffUser?.id ?? null, tenantId: poolTenantId, userEmail: req.staffUser?.email ?? null,
        after: { totalCents: pool.totalTipsCents, members: updated.members.length },
        // Staff with no known role who worked the window and were left out on
        // purpose (HR-R7): who, their hours, and the approver's reason.
        ...(leftOut.length > 0 && { metadata: { staffLeftOut: leftOut, reason: leaveOut?.reason ?? null } }),
      })
      await auditApproval(req, { type: 'tip_pool', id: pool.id, tenantId: poolTenantId, decision: 'post', grant, entity: 'TipPool' })

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
          after: { recipient: m.userName, recipientId: m.userId, employeeId: m.employeeId, units: m.shareUnits, cents: m.shareCents },
          metadata: { tipPoolId: pool.id, totalPool: pool.totalTipsCents },
        })
      }

      // Outlier flag: if any member is taking > 40% of the pool, flag.
      // Indicates either a real high-units worker (legit, reviewer can
      // resolve) or a manipulated split. Raised once — a pool posts once.
      const big = updated.members.find((m) => m.shareCents > pool.totalTipsCents * 0.4)
      if (big && updated.members.length >= 3) {
        await flagException({
          tenantId: poolTenantId,
          kind: 'tip_pool_outlier',
          severity: 'medium',
          title: `Tip pool: ${big.userName} taking ${((big.shareCents / pool.totalTipsCents) * 100).toFixed(0)}%`,
          description: `${big.userName} took ${((big.shareCents / pool.totalTipsCents) * 100).toFixed(0)}% of a PKR ${(pool.totalTipsCents / 100).toFixed(0)} pool across ${updated.members.length} members. Confirm units (${big.shareUnits}) reflect actual hours/role.`,
          entityType: 'TipPool',
          entityId: pool.id,
          conceptId: pool.conceptId,
          actorId: req.staffUser?.id ?? null,
          amountCents: big.shareCents,
          metadata: { recipient: big.userName, userId: big.userId, employeeId: big.employeeId, totalCents: pool.totalTipsCents, units: big.shareUnits, memberCount: updated.members.length },
        })
      }

      return updated
    },
  )

  // Pay — disburses funds. Posts: Dr 2095 / Cr Bank, in the POOL's company.
  // The status claim, the overlap check and the posting are one transaction
  // under the brand's lock: the same tips are never paid twice, by a double
  // click or by a second pool. Each member's share (login holder or employee)
  // is already on their member row from posting; the entry is the pool's.
  fastify.post<{ Params: { id: string }; Body: { paidFromAccountCode?: string; method?: string; bankAccountId?: string | null } }>(
    '/:id/pay',
    // D3: APPROVERS of the pool's company, or a Finance hand-over — assertCanApprove decides.
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({
        paidFromAccountCode: z.string().optional(),
        method: z.enum(['cash', 'bank', 'bank_transfer', 'bank_deposit', 'cheque']).optional(),
        bankAccountId: z.string().min(1).nullish(),
      }).parse(req.body ?? {})
      const { pool, grant } = await poolDecision(req, req.params.id, 'pay')
      if (pool.status !== 'posted') throw new AppError('NOT_POSTABLE', `Pool is ${pool.status}`, 422)

      // The money leaves a cash or bank account of the pool's own company —
      // never a revenue or liability code (audit PPL-R2-03).
      const cashAccount = await payingAccount(pool.tenantId, body)
      // Tips in a till whose close is not on the books — still open, or
      // closed with its posting refused or not run yet — are not in Tips
      // Payable (PPL-R2-04, RV-P-01).
      if (pool.conceptId && pool.totalTipsCents > 0) {
        const tills = await tillsHoldingTips(pool.conceptId, pool.periodStart, pool.periodEnd)
        if (tills.length) throw new AppError('TILL_OPEN', `Not paid: ${tillText(tills)}.`, 409, { tills })
      }
      const paid = await prisma.$transaction(async (tx) => {
        if (pool.conceptId) {
          await lockBrandPools(tx, pool.conceptId)
          const clash = await overlappingPool(tx, pool.conceptId, pool.periodStart, pool.periodEnd, { exceptId: pool.id, statuses: ['paid'] })
          if (clash) throw poolOverlap(clash, 'Not paid')
        }
        const n = await tx.tipPool.updateMany({ where: { id: pool.id, status: 'posted' }, data: { status: 'paid', paidAt: new Date() } })
        if (n.count === 0) throw new AppError('NOT_POSTABLE', 'Pool is no longer posted — it may have just been paid', 422)
        if (pool.totalTipsCents > 0) {
          await postJournalEntry({
            tenantId: pool.tenantId,
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
        return tx.tipPool.findUniqueOrThrow({ where: { id: pool.id }, include: MEMBER_INCLUDE })
      })
      await auditApproval(req, { type: 'tip_pool', id: pool.id, tenantId: pool.tenantId, decision: 'pay', grant, entity: 'TipPool' })
      return paid
    },
  )
}
