// Money in paisa — the ONE boundary for BIGINT money columns (BOOKS-06).
//
// The ledger, AP, AR, bank lines and balances, exception amounts, allocation
// runs, fixed assets, capex/opex and Customer.totalSpentCents are BIGINT in
// Postgres (migration 20261012140000_money_bigint): a restaurant GROUP outgrows
// INT4 (PKR 21,474,836.47) in one amount. Per-ticket (orders, payments, till),
// per-unit stock cost and per-person HR amounts stay INT4.
//
// Prisma returns BIGINT as a JS `bigint`, which JSON.stringify refuses and which
// does not mix with `number` arithmetic. `moneyAsNumbers` (a Prisma query
// extension installed on the base client in lib/prisma.ts, UNDER the RLS
// extension) turns every BIGINT in every model-operation result into a JS
// number — on `prisma`, `serviceClient` and every $transaction client — so the
// rest of the app, and every client, keeps seeing plain numbers.
//
// Prisma still TYPES those fields `bigint`: convert with toCents()/sumCents()
// where tsc asks (they accept bigint | number, so they are right on a raw
// client too). Never bigint literals, BigInt() or bigint math in src/ (a test
// scans for it).
//
// Raw SQL is NOT converted: $queryRaw that returns a BIGINT column — including
// SELECT * / t.* of a widened table — comes back as bigint, and SUM(int8) as a
// Prisma.Decimal (which reaches JSON as a STRING). Select ids and re-read
// through the model API, or cast sums ::bigint and pass them through toCents.

import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AppError } from './errors.js' // errors.ts imports nothing, so there is no cycle

/** INT4 columns (till, orders, payments, per-unit stock cost): PKR 21,474,836.47. */
export const INT4_MAX_CENTS = 2_147_483_647
/** One amount on a BIGINT column: PKR 900,000,000,000.00. ~MAX_SAFE_INTEGER/100,
 *  so a sum of up to 100 maximal amounts is still exact in JS. */
export const MAX_MONEY_CENTS = 90_000_000_000_000

/** A money field as Prisma TYPES it. At runtime (through lib/prisma.ts) it is always a number. */
export type DbMoney = number | bigint

/** A money value from the DB as an exact JS number. Throws (500) rather than round beyond 2^53. */
export function toCents(v: DbMoney): number
export function toCents(v: DbMoney | null): number | null
export function toCents(v: DbMoney | null | undefined): number | null | undefined
export function toCents(v: DbMoney | null | undefined): number | null | undefined {
  if (v === null || v === undefined) return v
  const n = typeof v === 'bigint' ? Number(v) : v
  if (!Number.isSafeInteger(n)) {
    throw new AppError('AMOUNT_OUT_OF_RANGE', `A money value (${String(v)} paisa) is outside the exact range`, 500)
  }
  return n
}

/** _sum/_min/_max of a BIGINT column; no rows (null) → 0. NEVER for _avg (float). */
export function sumCents(v: DbMoney | null | undefined): number {
  return v == null ? 0 : toCents(v)
}

const pkr = (c: number) =>
  `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** 422 AMOUNT_TOO_LARGE: "<what> comes to PKR X, which is more than the PKR <max> one amount can be — check the figure". */
export function amountTooLarge(what: string, cents?: number, max: number = MAX_MONEY_CENTS): AppError {
  const got = cents !== undefined && Number.isFinite(cents) ? ` comes to ${pkr(cents)}, which is` : ' is'
  return new AppError(
    'AMOUNT_TOO_LARGE',
    `${what}${got} more than the ${pkr(max)} one amount can be — check the figure`,
    422,
  )
}

/** One amount bound for a BIGINT column (≤ MAX_MONEY_CENTS in magnitude), else 422. */
export function assertMoneyFits(cents: number, what: string): void {
  if (!Number.isFinite(cents) || Math.abs(cents) > MAX_MONEY_CENTS) throw amountTooLarge(what, cents)
}

/** One amount bound for an INT4 column (≤ INT4_MAX_CENTS in magnitude), else 422. */
export function assertInt4Fits(cents: number, what: string): void {
  if (!Number.isFinite(cents) || Math.abs(cents) > INT4_MAX_CENTS) throw amountTooLarge(what, cents, INT4_MAX_CENTS)
}

type Sign = 'positive' | 'nonnegative' | 'any'

/** Zod money input: an integer (sign per opts, default nonnegative) ≤ max (default
 *  MAX_MONEY_CENTS). Over the cap throws 422 AMOUNT_TOO_LARGE through .parse();
 *  non-integers and sign violations stay ZodErrors (400). */
export function zMoneyCents(what: string, opts: { sign?: Sign; max?: number } = {}) {
  const max = opts.max ?? MAX_MONEY_CENTS
  const int = z.number().int()
  const base = opts.sign === 'positive' ? int.positive() : opts.sign === 'any' ? int : int.nonnegative()
  return base.transform((v) => {
    if (Math.abs(v) > max) throw amountTooLarge(what, v, max)
    return v
  })
}

/** zMoneyCents capped at INT4 — for inputs bound for INT4 columns. */
export const zInt4Cents = (what: string, opts: { sign?: Sign } = {}) =>
  zMoneyCents(what, { ...opts, max: INT4_MAX_CENTS })

// ─── The boundary ───────────────────────────────────────────────────────────

/** Generic in-place walk: every bigint anywhere becomes a number. Used for
 *  results whose model is not in the DMMF (never expected) and by tests. */
export function bigintsToNumbers<T>(value: T): T {
  return walk(value) as T
}

function walk(v: unknown): unknown {
  if (typeof v === 'bigint') return toCents(v)
  if (
    v === null ||
    typeof v !== 'object' ||
    v instanceof Date ||
    ArrayBuffer.isView(v) ||
    Prisma.Decimal.isDecimal(v)
  ) {
    return v
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const w = walk(v[i])
      if (w !== v[i]) v[i] = w
    }
    return v
  }
  const o = v as Record<string, unknown>
  for (const k in o) {
    const w = walk(o[k])
    if (w !== o[k]) o[k] = w
  }
  return o
}

// Precise walk driven by the runtime DMMF. Per model: its relation fields
// (with target model). In a row, a bigint value is converted wherever it
// sits at the row's own level — Prisma only ever produces a bigint for a
// BIGINT column (Json is JSON-parsed, Decimal is a Decimal), so that is
// exact; only relation keys whose target can reach a BIGINT model are
// descended, plus the _sum/_min/_max buckets of aggregate/groupBy. Json and
// every other non-relation object (Date, Decimal, Bytes) is never visited.
interface ModelMoneyShape {
  bigints: ReadonlySet<string>
  relations: ReadonlyMap<string, string>
}

const SHAPES = new Map<string, ModelMoneyShape>()
for (const m of Prisma.dmmf.datamodel.models) {
  SHAPES.set(m.name, {
    bigints: new Set(m.fields.filter((f) => f.kind === 'scalar' && f.type === 'BigInt').map((f) => f.name)),
    relations: new Map(m.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type])),
  })
}

/** Models that have a BigInt field. */
export const BIGINT_MODELS: ReadonlySet<string> = new Set(
  [...SHAPES].filter(([, s]) => s.bigints.size > 0).map(([name]) => name),
)

// Models from which an include/select can reach a BIGINT model (fixpoint).
const REACHES_BIGINT = new Set<string>(BIGINT_MODELS)
for (let changed = true; changed; ) {
  changed = false
  for (const [name, s] of SHAPES) {
    if (REACHES_BIGINT.has(name)) continue
    for (const target of s.relations.values()) {
      if (REACHES_BIGINT.has(target)) {
        REACHES_BIGINT.add(name)
        changed = true
        break
      }
    }
  }
}

const AGG_BUCKETS: ReadonlySet<string> = new Set(['_sum', '_min', '_max'])

function convertRow(shape: ModelMoneyShape, row: unknown): void {
  if (row === null || typeof row !== 'object') return
  const o = row as Record<string, unknown>
  for (const k in o) {
    const v = o[k]
    if (typeof v === 'bigint') {
      o[k] = toCents(v)
      continue
    }
    if (v === null || typeof v !== 'object') continue
    const target = shape.relations.get(k)
    if (target !== undefined) {
      if (REACHES_BIGINT.has(target)) convertModelValue(target, v)
    } else if (AGG_BUCKETS.has(k)) {
      // aggregate: { _sum, _min, _max, … }; groupBy rows: { …by, _sum, … }
      convertBucket(v)
    }
  }
}

function convertBucket(bucket: unknown): void {
  if (bucket === null || typeof bucket !== 'object') return
  const b = bucket as Record<string, unknown>
  for (const k in b) {
    const v = b[k]
    if (typeof v === 'bigint') b[k] = toCents(v)
  }
}

function convertModelValue(model: string, value: unknown): void {
  const shape = SHAPES.get(model)
  if (!shape) {
    walk(value)
    return
  }
  if (Array.isArray(value)) {
    for (const row of value) convertRow(shape, row)
  } else {
    convertRow(shape, value)
  }
}

// Operations that return many rows (or a count/aggregate): never fluent.
const LIST_OPERATIONS: ReadonlySet<string> = new Set([
  'findMany', 'createMany', 'createManyAndReturn', 'updateMany', 'deleteMany', 'groupBy', 'aggregate', 'count',
])

/**
 * The model a result's rows belong to. The fluent API
 * (`prisma.journalEntry.findUnique(…).lines()`) reaches the extension as the
 * SOURCE model with `select: { lines: … }`, but its result is already the
 * unpacked relation (the lines array). Follow a single-relation select chain
 * while the result does not carry that key itself.
 */
function resultModel(model: string, operation: string | undefined, args: unknown, result: unknown): string {
  if (operation !== undefined && LIST_OPERATIONS.has(operation)) return model
  let m = model
  let a = args as { select?: unknown } | undefined
  for (let depth = 0; depth < 16; depth++) {
    const sel = a?.select
    if (sel === null || typeof sel !== 'object') return m
    const keys = Object.keys(sel)
    if (keys.length !== 1) return m
    const k = keys[0]!
    const target = SHAPES.get(m)?.relations.get(k)
    if (target === undefined) return m
    if (!Array.isArray(result) && Object.prototype.hasOwnProperty.call(result, k)) return m
    m = target
    const sub = (sel as Record<string, unknown>)[k]
    a = sub !== null && typeof sub === 'object' ? (sub as { select?: unknown }) : undefined
  }
  return m
}

/** Convert a model operation's result in place (exported for tests). */
export function convertModelResult<T>(model: string, result: T, operation?: string, args?: unknown): T {
  if (result === null || typeof result !== 'object') return result
  if (!SHAPES.has(model)) return bigintsToNumbers(result)
  const m = resultModel(model, operation, args, result)
  if (!REACHES_BIGINT.has(m)) return result
  convertModelValue(m, result)
  return result
}

export const moneyAsNumbers = Prisma.defineExtension({
  name: 'money-bigint-as-number',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args)
        const a = args as { include?: unknown; select?: unknown } | undefined
        if (!BIGINT_MODELS.has(model) && !a?.include && !a?.select) return result
        return convertModelResult(model, result, operation, args)
      },
    },
  },
})

/** Safety net only (the extension is the mechanism of record): a bigint that
 *  slips through still serialises as a JSON number, and throws beyond 2^53
 *  rather than rounding. Idempotent. */
export function installBigIntJson(): void {
  if (Object.prototype.hasOwnProperty.call(BigInt.prototype, 'toJSON')) return
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint) {
      return toCents(this)
    },
    writable: true,
    configurable: true,
    enumerable: false,
  })
}
