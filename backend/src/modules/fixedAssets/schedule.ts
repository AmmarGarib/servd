// The depreciation schedule — pure maths, PKT months (fixed assets v2).
//
// Straight line, full-month convention: the in-service month is charged, the
// disposal month is not. Each month's charge is
//
//     remaining depreciable ÷ remaining UNCHARGED months of the life
//
// where remaining depreciable = cost − salvage − what is already on the
// accumulated account (every live charge, in ANY month, + accumulated carried
// in by a pool-unit transfer + impairments − accumulated taken out by partial
// write-offs / transfers). The last uncharged month takes the remainder, so
// the lifetime total is exactly cost − salvage — never a paisa over, even when
// legacy months were charged out of order (M-01: the old engine charged a
// later month before an earlier one and could pass cost − salvage). Months
// are charged strictly in order from the in-service month.
//
// Impairments, changes of estimate (the asset row carries the new life and
// salvage) and partial outs therefore act prospectively by construction: the
// formula re-spreads whatever remains over the months that remain.
//
// Nothing here touches the database; service.ts (chargeThrough) is the ONE
// path that posts what this plans.

const PKT_OFFSET_MS = 5 * 3600_000
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

// ─── PKT months ─────────────────────────────────────────────────────────────

export function isPeriod(s: string): boolean {
  return PERIOD_RE.test(s)
}

/** The PKT month ('YYYY-MM') an instant falls in — 00:30 PKT on the 1st is already the new month. */
export function periodOfPkt(d: Date): string {
  const p = new Date(d.getTime() + PKT_OFFSET_MS)
  return `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Months since year 0 — for ordering and arithmetic. */
export function periodIndex(period: string): number {
  const m = PERIOD_RE.exec(period)
  if (!m) throw new RangeError(`not a period: ${period}`)
  return Number(m[1]) * 12 + (Number(m[2]) - 1)
}

export function periodFromIndex(i: number): string {
  const y = Math.floor(i / 12)
  const m = i - y * 12 + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

export function addMonths(period: string, n: number): string {
  return periodFromIndex(periodIndex(period) + n)
}

/** 12:00 PKT on the last day of the month — the natural date of a month's depreciation. */
export function lastDayPkt(period: string): Date {
  const i = periodIndex(period)
  const y = Math.floor(i / 12)
  const m = i - y * 12 + 1
  return new Date(Date.UTC(y, m, 0, 12) - PKT_OFFSET_MS)
}

/** 00:00 PKT on the 1st of the month. */
export function startOfMonthPkt(period: string): Date {
  const i = periodIndex(period)
  const y = Math.floor(i / 12)
  const m = i - y * 12
  return new Date(Date.UTC(y, m, 1) - PKT_OFFSET_MS)
}

/** 23:59:59.999 PKT on the last day of the month (the instant a month-end PeriodLock stores). */
export function endOfMonthPkt(period: string): Date {
  return new Date(startOfMonthPkt(addMonths(period, 1)).getTime() - 1)
}

/** The PKT month `now` is in (not yet ended). */
export function currentPeriodPkt(now: Date = new Date()): string {
  return periodOfPkt(now)
}

/** The last PKT month that has fully ended at `now`. */
export function lastCompletedPeriodPkt(now: Date = new Date()): string {
  return addMonths(periodOfPkt(now), -1)
}

/** The last month whose PKT end is on or before `at` (a lock through 30 Sep 23:59:59.999 PKT → '…-09'). */
export function lastPeriodEndingBy(at: Date): string {
  const p = periodOfPkt(at)
  return endOfMonthPkt(p).getTime() <= at.getTime() ? p : addMonths(p, -1)
}

// ─── The plan ───────────────────────────────────────────────────────────────

export interface ScheduleAsset {
  /** Depreciation starts in this PKT month (legacy rows: acquiredAt). */
  inServiceAt: Date
  /** Cost still on the books (after partial outs). */
  costCents: number
  salvageCents: number
  /** Total life in months from the in-service month (a change of estimate rewrites it). */
  usefulLifeMonths: number
  /** 'straight_line' | 'none' (land). */
  method: string
  /** False for a class that is never depreciated (land). Default true. */
  depreciable?: boolean
  /** Accumulated brought in by a pool-unit transfer. */
  carriedAccumulatedCents?: number
  /** Disposal date: the disposal month and later are never charged. */
  disposedAt?: Date | null
  /** Leasehold: the life is capped at the lease-end month. */
  leaseEndsAt?: Date | null
  /**
   * First month THIS row may be charged (a pool layer split off by a unit
   * transfer: its source charged the months before; the life window still
   * runs from the original in-service month). Null = the in-service month.
   */
  chargeFrom?: Date | null
}

/** Live (un-reversed) charges by period, in paisa. */
export type ChargedMap = ReadonlyMap<string, number>

/** Movements on the accumulated account other than monthly charges. */
export interface ScheduleAdjustment {
  period: string
  /** impairment: + accumulated; accum_out: − accumulated (partial write-off / transfer out). */
  kind: 'impairment' | 'accum_out'
  cents: number
}

export interface PlannedCharge {
  period: string
  amountCents: number
}

/** First and last month of the asset's life (null: never depreciated). */
export function lifeWindow(asset: ScheduleAsset): { start: string; end: string } | null {
  if (asset.method === 'none' || asset.depreciable === false || asset.usefulLifeMonths <= 0) return null
  const start = periodIndex(periodOfPkt(asset.inServiceAt))
  let end = start + asset.usefulLifeMonths - 1
  if (asset.leaseEndsAt) end = Math.min(end, periodIndex(periodOfPkt(asset.leaseEndsAt)))
  end = Math.max(end, start)
  return { start: periodFromIndex(start), end: periodFromIndex(end) }
}

/** What sits on the accumulated account for this asset now. */
export function accumulatedOf(asset: ScheduleAsset, charged: ChargedMap, adjustments: readonly ScheduleAdjustment[] = []): number {
  let a = asset.carriedAccumulatedCents ?? 0
  for (const v of charged.values()) a += v
  for (const adj of adjustments) a += adj.kind === 'impairment' ? adj.cents : -adj.cents
  return a
}

/** cost − salvage − accumulated: what is still to be charged over the remaining life. */
export function remainingDepreciable(asset: ScheduleAsset, charged: ChargedMap, adjustments: readonly ScheduleAdjustment[] = []): number {
  return Math.max(0, asset.costCents - asset.salvageCents) - accumulatedOf(asset, charged, adjustments)
}

/**
 * The charges still owed, month by month in order, for every uncharged month
 * from the in-service month through `throughPeriod` (and never past the end
 * of the life or into the disposal month). Months already charged are
 * skipped; a month whose share rounds to 0 is left out (the remainder lands
 * in the last month of the life).
 */
export function planCharges(
  asset: ScheduleAsset,
  charged: ChargedMap,
  adjustments: readonly ScheduleAdjustment[],
  throughPeriod: string,
): PlannedCharge[] {
  const win = lifeWindow(asset)
  if (!win) return []
  const end = periodIndex(win.end)
  const start = asset.chargeFrom
    ? Math.max(periodIndex(win.start), periodIndex(periodOfPkt(asset.chargeFrom)))
    : periodIndex(win.start)
  if (start > end) return []
  let stop = Math.min(periodIndex(throughPeriod), end)
  if (asset.disposedAt) stop = Math.min(stop, periodIndex(periodOfPkt(asset.disposedAt)) - 1)
  if (stop < start) return []

  let remaining = remainingDepreciable(asset, charged, adjustments)
  // Uncharged months from the current month to the end of the life.
  let unchargedLeft = 0
  for (let i = start; i <= end; i++) if (!charged.has(periodFromIndex(i))) unchargedLeft++

  const out: PlannedCharge[] = []
  for (let i = start; i <= stop; i++) {
    const period = periodFromIndex(i)
    if (charged.has(period)) continue
    if (remaining <= 0) break
    const amount = unchargedLeft <= 1 ? remaining : Math.floor(remaining / unchargedLeft)
    if (amount > 0) {
      out.push({ period, amountCents: amount })
      remaining -= amount
    }
    unchargedLeft--
  }
  return out
}

/** Every charge still to come to the end of the life (past uncharged months included). */
export function forecast(
  asset: ScheduleAsset,
  charged: ChargedMap,
  adjustments: readonly ScheduleAdjustment[] = [],
): PlannedCharge[] {
  const win = lifeWindow(asset)
  if (!win) return []
  return planCharges(asset, charged, adjustments, win.end)
}

/** The next charge the schedule will post (0 when nothing is left). */
export function nextMonthlyCharge(
  asset: ScheduleAsset,
  charged: ChargedMap,
  adjustments: readonly ScheduleAdjustment[] = [],
): number {
  return forecast(asset, charged, adjustments)[0]?.amountCents ?? 0
}

// ─── Net book value at a date ───────────────────────────────────────────────

export interface NbvAsset {
  originalCostCents: number
  costCents: number
  carriedAccumulatedCents: number
  inServiceAt: Date
  status: string
  disposedAt: Date | null
  /** A layer split off by a pool-unit transfer is on these books from its creation. */
  splitFromAssetId?: string | null
  createdAt?: Date | null
}

export interface NbvEvent {
  kind: string
  status: string
  effectiveDate: Date
  amountCents?: number | null
  costOutCents?: number | null
  accumOutCents?: number | null
}

export interface NbvCharge {
  period: string
  amountCents: number
  reversedAt?: Date | null
}

/**
 * Cost, accumulated depreciation and NBV of one asset as of `asOf`, from the
 * register (economic months — a charge counts once its month has ended):
 *   cost  = cost when capitalised − cost taken out by write-off / transfer
 *           allocations effective by then (0 before it was on the books, once
 *           disposed, or when voided);
 *   accum = carried + charges of months ended by then (live at that date) +
 *           impairments − accumulated taken out.
 */
export function nbvAt(
  asset: NbvAsset,
  events: readonly NbvEvent[],
  charges: readonly NbvCharge[],
  asOf: Date,
): { costCents: number; accumulatedCents: number; nbvCents: number } {
  const zero = { costCents: 0, accumulatedCents: 0, nbvCents: 0 }
  if (asset.status === 'voided') return zero
  const from = asset.splitFromAssetId && asset.createdAt ? asset.createdAt : asset.inServiceAt
  if (asOf.getTime() < from.getTime()) return zero
  if (asset.status === 'disposed' && asset.disposedAt && asset.disposedAt.getTime() <= asOf.getTime()) return zero

  const t = asOf.getTime()
  const posted = events.filter((e) => e.status === 'posted' && e.effectiveDate.getTime() <= t)
  let cost = asset.originalCostCents > 0 ? asset.originalCostCents : asset.costCents
  let accum = asset.carriedAccumulatedCents
  for (const e of posted) {
    if (e.kind === 'pool_write_off_alloc' || e.kind === 'pool_transfer_alloc') {
      cost -= e.costOutCents ?? 0
      accum -= e.accumOutCents ?? 0
    } else if (e.kind === 'impairment') {
      accum += e.amountCents ?? 0
    }
  }
  for (const c of charges) {
    if (c.reversedAt && c.reversedAt.getTime() <= t) continue
    if (endOfMonthPkt(c.period).getTime() > t) continue
    accum += c.amountCents
  }
  return { costCents: cost, accumulatedCents: accum, nbvCents: cost - accum }
}
