// The rota — who works when — read from ONE place.
//
// Owner decision 33: standing shifts and weekly offs are set in HR (the
// 'shift' master and approved 'roster' records). The weekly grid on
// /scheduling is GENERATED from them; managers store only the exceptions
// there (scheduled_shifts rows), and an approved HR 'shift_swap' moves a day.
// Attendance marks late against the same answer, and /scheduling costs it
// from HR salaries. So every reader asks rotaFor() — nothing re-derives it.
//
// Precedence for one person on one day, last wins:
//   1. roster      the latest approved roster covering the day: its shift, or
//                  'off' on a weekly off
//   2. swap        an approved shift_swap for that day (either side of it)
//   3. exception   the manager's dated rows on /scheduling for that day

import type { HrEmployee } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/** Marks a /scheduling exception row that takes the day OFF rather than
 *  setting hours. (scheduled_shifts has no kind column yet — see the report.) */
export const OFF_MARK = '[off]'

export const ymd = (d: Date) => d.toISOString().slice(0, 10)
export const dayDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`)

/** HH:MM → minutes after midnight, or null when it is not a time. */
export function toMinutes(hhmm: unknown): number | null {
  if (typeof hhmm !== 'string') return null
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Length of a shift segment in minutes. An end at or before the start runs
 *  past midnight (18:00–02:00 is 8 hours). */
export function segmentMinutes(start: string, end: string): number {
  const a = toMinutes(start), b = toMinutes(end)
  if (a == null || b == null) return 0
  return b > a ? b - a : b + 1440 - a
}

export interface ShiftDef {
  id: string
  name: string
  start: string
  end: string
  breakMinutes: number
}

/** The company's shift master: approved 'shift' records with real times. */
export async function shiftMaster(tenantId: string): Promise<Map<string, ShiftDef>> {
  const rows = await prisma.hrRecord.findMany({ where: { tenantId, section: 'shift', status: 'approved' } })
  const out = new Map<string, ShiftDef>()
  for (const r of rows) {
    const d = (r.data ?? {}) as Record<string, unknown>
    if (toMinutes(d['start']) == null || toMinutes(d['end']) == null) continue
    out.set(r.id, {
      id: r.id,
      name: typeof d['name'] === 'string' && d['name'] ? d['name'] : `${d['start']}–${d['end']}`,
      start: String(d['start']), end: String(d['end']),
      breakMinutes: typeof d['breakMinutes'] === 'number' && d['breakMinutes'] > 0 ? d['breakMinutes'] : 0,
    })
  }
  return out
}

export interface RotaSegment {
  start: string
  end: string
  /** HR shift record, when the hours come from the shift master. */
  shiftId: string | null
  shiftName: string | null
  breakMinutes: number
  /** /scheduling exception row, when the hours come from one. */
  exceptionId: string | null
  conceptId: string | null
  role: string | null
  notes: string | null
}

export interface RotaCell {
  employeeId: string
  date: string // YYYY-MM-DD
  kind: 'shift' | 'off' | 'none'
  source: 'roster' | 'swap' | 'exception' | 'none'
  segments: RotaSegment[]
  /** The day-off exception row, when an exception took the day off. */
  offExceptionId: string | null
}

type Emp = Pick<HrEmployee, 'id' | 'userId'>

const shiftSegment = (s: ShiftDef): RotaSegment => ({
  start: s.start, end: s.end, shiftId: s.id, shiftName: s.name, breakMinutes: s.breakMinutes,
  exceptionId: null, conceptId: null, role: null, notes: null,
})

/** Paid minutes of a cell: segments less their breaks. */
export function cellMinutes(c: RotaCell): number {
  if (c.kind !== 'shift') return 0
  return c.segments.reduce((a, s) => a + Math.max(0, segmentMinutes(s.start, s.end) - s.breakMinutes), 0)
}

/** Every day from `from` to `to` inclusive, as YYYY-MM-DD. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = dayDate(from); d <= dayDate(to) && out.length < 400; d = new Date(d.getTime() + 86_400_000)) out.push(ymd(d))
  return out
}

/**
 * The rota for `emps` (all of one company) over [from, to]. One cell per
 * person per day, whether or not anything is planned.
 */
export async function rotaFor(tenantId: string, emps: Emp[], from: string, to: string): Promise<RotaCell[]> {
  if (emps.length === 0) return []
  const days = daysBetween(from, to)
  const lo = dayDate(from)
  const hi = new Date(dayDate(to).getTime() + 86_399_999)
  const swaps = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'shift_swap', status: 'approved', startDate: { gte: lo, lte: hi } },
    orderBy: { updatedAt: 'asc' },
  })
  // A swap reads the other side's standing shift, so their roster is loaded
  // too even when they are not on this grid.
  const partnerIds = new Set<string>()
  for (const s of swaps) {
    if (s.employeeId) partnerIds.add(s.employeeId)
    const w = (s.data as Record<string, unknown>)['swapWith']
    if (typeof w === 'string') partnerIds.add(w)
  }
  const rosterIds = Array.from(new Set([...emps.map((e) => e.id), ...partnerIds]))
  const userIds = emps.map((e) => e.userId).filter((u): u is string => !!u)
  const [shifts, rosters, exceptions] = await Promise.all([
    shiftMaster(tenantId),
    prisma.hrRecord.findMany({
      where: {
        tenantId, section: 'roster', status: 'approved', employeeId: { in: rosterIds },
        startDate: { lte: hi }, OR: [{ endDate: null }, { endDate: { gte: lo } }],
      },
      orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    }),
    userIds.length
      ? prisma.scheduledShift.findMany({
          where: { userId: { in: userIds }, date: { gte: lo, lte: hi }, concept: { tenantId, deletedAt: null } },
          orderBy: { startTime: 'asc' },
        })
      : Promise.resolve([]),
  ])

  const baseCell = (employeeId: string, date: string): RotaCell => {
    const d = dayDate(date)
    const covering = rosters.filter((r) => r.employeeId === employeeId && r.startDate && r.startDate <= d && (!r.endDate || r.endDate >= d))
    const r = covering[covering.length - 1]
    const cell: RotaCell = { employeeId, date, kind: 'none', source: 'none', segments: [], offExceptionId: null }
    if (!r) return cell
    const offs = (r.data as Record<string, unknown>)['weeklyOff']
    if (Array.isArray(offs) && offs.includes(WEEKDAYS[d.getUTCDay()]!)) return { ...cell, kind: 'off', source: 'roster' }
    const s = r.refId ? shifts.get(r.refId) : undefined
    return s ? { ...cell, kind: 'shift', source: 'roster', segments: [shiftSegment(s)] } : cell
  }

  const out: RotaCell[] = []
  for (const e of emps) {
    for (const date of days) {
      let cell = baseCell(e.id, date)
      // Approved swaps for the day, oldest first so the latest decision stands.
      for (const s of swaps) {
        if (!s.startDate || ymd(s.startDate) !== date) continue
        const d = s.data as Record<string, unknown>
        const partner = typeof d['swapWith'] === 'string' ? d['swapWith'] : null
        if (s.employeeId === e.id) {
          const to = s.refId ? shifts.get(s.refId) : undefined
          const next = to ? { ...cell, kind: 'shift' as const, segments: [shiftSegment(to)] } : partner ? baseCell(partner, date) : null
          if (next) cell = { ...next, employeeId: e.id, date, source: 'swap' }
        } else if (partner === e.id && s.employeeId) {
          const fromId = typeof d['fromShift'] === 'string' ? d['fromShift'] : null
          const from = fromId ? shifts.get(fromId) : undefined
          const next = from ? { ...cell, kind: 'shift' as const, segments: [shiftSegment(from)] } : baseCell(s.employeeId, date)
          cell = { ...next, employeeId: e.id, date, source: 'swap' }
        }
      }
      const mine = e.userId ? exceptions.filter((x) => x.userId === e.userId && ymd(x.date) === date) : []
      if (mine.length) {
        const off = mine.find((x) => x.role === OFF_MARK)
        cell = off
          ? { employeeId: e.id, date, kind: 'off', source: 'exception', segments: [], offExceptionId: off.id }
          : {
              employeeId: e.id, date, kind: 'shift', source: 'exception', offExceptionId: null,
              segments: mine.map((x) => ({
                start: x.startTime, end: x.endTime, shiftId: null, shiftName: null, breakMinutes: 0,
                exceptionId: x.id, conceptId: x.conceptId, role: x.role, notes: x.notes,
              })),
            }
      }
      out.push(cell)
    }
  }
  return out
}

/** One person's rota for one day. */
export async function rotaDay(tenantId: string, emp: Emp, date: string): Promise<RotaCell> {
  const [cell] = await rotaFor(tenantId, [emp], date, date)
  return cell ?? { employeeId: emp.id, date, kind: 'none', source: 'none', segments: [], offExceptionId: null }
}
