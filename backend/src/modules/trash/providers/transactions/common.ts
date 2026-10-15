// Shared helpers for the transaction providers (strategy 'none' and the F1–F5
// money snapshots). A transaction is read from its OWN status columns — there
// is no second status store — and is never restored or erased; "Recover as
// copy" builds a payload from the original with the reset rules applied, or
// injects the module's own create route as the caller.
//
// Company scope: every list / get reads on serviceClient with the EXPLICIT
// company ids of ctx.readScope (an empty scope matches nothing). The core
// re-checks each row's tenantId against the scope (service.ts inScope).

import { AppError } from '../../../../lib/errors.js'
import type { TenantIdWhere } from '../../../../lib/tenantScope.js'
import type { CopyResult, TrashCtx, TrashListFilter, TrashRow } from '../../types.js'

/** The company ids of a scope ([] = deny). */
export function scopeIds(scope: TenantIdWhere): string[] {
  const t = scope.tenantId
  return typeof t === 'string' ? [t] : [...t.in]
}

/** Prisma fragment on a DateTime column: from / to and the (at desc, id desc) cursor. */
export function atWhere(field: string, f: Pick<TrashListFilter, 'from' | 'to' | 'before'>, idField = 'id'): Record<string, unknown> {
  const and: Array<Record<string, unknown>> = []
  if (f.from) and.push({ [field]: { gte: f.from } })
  if (f.to) and.push({ [field]: { lte: f.to } })
  if (f.before) {
    and.push({ OR: [{ [field]: { lt: f.before.at } }, { [field]: f.before.at, [idField]: { lt: f.before.id } }] })
  }
  return and.length ? { AND: and } : {}
}

/** Case-insensitive contains on any of the fields (nothing when q is empty). */
export function qWhere(q: string | undefined, fields: string[]): Record<string, unknown> {
  const s = q?.trim()
  if (!s) return {}
  return { OR: fields.map((f) => ({ [f]: { contains: s, mode: 'insensitive' } })) }
}

/** Sort a provider's rows the way the core merges them (at desc, id desc) and cut. */
export function sortRows(rows: TrashRow[], limit: number): TrashRow[] {
  return rows
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0))
    .slice(0, limit)
}

export const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))

export function pkr(cents: unknown): string {
  return `PKR ${(n(cents) / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
}

/** A PKT calendar date (YYYY-MM-DD) of an instant. */
export function pktDate(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const t = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(t.getTime())) return null
  return new Date(t.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
}

export function prefill(link: string, payload: Record<string, unknown>): CopyResult {
  return { mode: 'prefill', link, payload }
}

/**
 * "Recover as copy" in mode 'created': call the module's EXISTING create route
 * as the caller (its own guards, company binding and validation decide). A
 * refusal is passed on with the module's own code and status.
 */
export async function injectCreate(
  ctx: TrashCtx,
  path: string,
  body: unknown,
  idOf: (json: Record<string, unknown>) => string | undefined,
): Promise<string> {
  const res = await ctx.inject('POST', path, body)
  const json = (res.json ?? {}) as Record<string, unknown>
  if (res.statusCode >= 400) {
    const err = (json.error ?? {}) as { code?: string; message?: string; details?: unknown }
    throw new AppError(err.code ?? 'COPY_FAILED', err.message ?? 'The copy could not be created', res.statusCode, err.details)
  }
  const id = idOf(json)
  if (!id) throw new AppError('COPY_FAILED', 'The copy was created but its id is unknown — check the module', 500)
  return id
}

/** The roles a module's guard lists, typed for the provider contract. */
export const roles = <T extends readonly string[]>(r: T) => r as unknown as readonly import('@prisma/client').UserRole[]
