// Snapshots for strategy 'snapshot' (types.ts): the row and its children are
// stored as JSON in trash_entries.snapshot BEFORE the module's hard delete, and
// re-created with the SAME ids on restore. Fields are filtered against the
// CURRENT schema (Prisma.dmmf): a column that no longer exists is dropped; a new
// required column with no default refuses the restore (409
// RESTORE_SCHEMA_CHANGED) rather than inventing a value.

import { Prisma } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import type { Tx } from './types.js'

export interface Snapshot {
  v: 1
  model: string
  row: Record<string, unknown>
  /** Child rows by Prisma model name, re-created after the row, in key order. */
  children: Record<string, Array<Record<string, unknown>>>
}

/** 1 MB — a bigger snapshot refuses the DELETE (413) rather than losing data. */
export const SNAPSHOT_MAX_BYTES = 1_000_000

type DmmfField = (typeof Prisma.dmmf.datamodel.models)[number]['fields'][number]
const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]))

function modelOrThrow(name: string) {
  const m = MODELS.get(name)
  if (!m) throw new AppError('RESTORE_SCHEMA_CHANGED', `"${name}" no longer exists — this item cannot be restored`, 409)
  return m
}

/** JSON-safe copy of a row (Date → ISO, bigint → number, Decimal → string). */
function toJsonRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString()
    else if (typeof v === 'bigint') out[k] = Number(v)
    else if (v instanceof Prisma.Decimal) out[k] = v.toString()
    else if (v && typeof v === 'object' && (v as Buffer) instanceof Uint8Array) out[k] = { __bytes: Buffer.from(v as Uint8Array).toString('base64') }
    else out[k] = v
  }
  return out
}

/** Build the snapshot JSON (scalar fields only — relations are children). */
export function takeSnapshot(
  model: string,
  row: Record<string, unknown>,
  children: Record<string, Array<Record<string, unknown>>> = {},
): Snapshot {
  const scalarOnly = (name: string, r: Record<string, unknown>) => {
    const m = modelOrThrow(name)
    const keep = new Set(m.fields.filter((f) => f.kind !== 'object').map((f) => f.name))
    return toJsonRow(Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))))
  }
  const snap: Snapshot = {
    v: 1,
    model,
    row: scalarOnly(model, row),
    children: Object.fromEntries(Object.entries(children).map(([m, rows]) => [m, rows.map((r) => scalarOnly(m, r))])),
  }
  if (Buffer.byteLength(JSON.stringify(snap)) > SNAPSHOT_MAX_BYTES) {
    throw new AppError('SNAPSHOT_TOO_LARGE', 'This item is too large to keep in the Trash, so it was not deleted', 413)
  }
  return snap
}

/** Convert a stored JSON row back into create data for the CURRENT schema. */
export function rowForCreate(model: string, row: Record<string, unknown>, override: Record<string, unknown> = {}): Record<string, unknown> {
  const m = modelOrThrow(model)
  const data: Record<string, unknown> = {}
  const merged = { ...row, ...override }
  for (const f of m.fields as DmmfField[]) {
    if (f.kind === 'object') continue
    if (f.isUpdatedAt) continue
    if (!(f.name in merged)) {
      const required = f.isRequired && !f.hasDefaultValue && !f.isList
      if (required) {
        throw new AppError('RESTORE_SCHEMA_CHANGED', `"${model}.${f.name}" was added after this item was deleted — it cannot be restored`, 409)
      }
      continue
    }
    const v = merged[f.name]
    if (v === null || v === undefined) { data[f.name] = v; continue }
    if (f.type === 'DateTime') data[f.name] = f.isList ? (v as string[]).map((d) => new Date(d)) : new Date(v as string)
    else if (f.type === 'Bytes' && typeof v === 'object' && v && '__bytes' in (v as object)) data[f.name] = Buffer.from((v as { __bytes: string }).__bytes, 'base64')
    else if (f.type === 'Json') data[f.name] = v as Prisma.InputJsonValue
    else data[f.name] = v
  }
  return data
}

function delegate(tx: Tx, model: string): { create(args: { data: unknown }): Promise<unknown> } {
  const key = model.charAt(0).toLowerCase() + model.slice(1)
  const d = (tx as unknown as Record<string, { create(args: { data: unknown }): Promise<unknown> }>)[key]
  if (!d) throw new AppError('RESTORE_SCHEMA_CHANGED', `"${model}" no longer exists — this item cannot be restored`, 409)
  return d
}

/**
 * Re-create the row and its children with their ids. `tenantId` (the ENTRY's
 * company) always overrides a tenantId stored inside the snapshot.
 */
export async function restoreSnapshot(
  tx: Tx,
  snap: Snapshot,
  opts: { tenantId?: string | null; override?: Record<string, unknown> } = {},
): Promise<string> {
  if (!snap || snap.v !== 1) throw new AppError('RESTORE_SCHEMA_CHANGED', 'This item was kept in an older format and cannot be restored', 409)
  const withTenant = (model: string, row: Record<string, unknown>) => {
    const m = modelOrThrow(model)
    const hasTenant = m.fields.some((f) => f.name === 'tenantId')
    return hasTenant && opts.tenantId !== undefined && 'tenantId' in row ? { ...row, tenantId: opts.tenantId } : row
  }
  await delegate(tx, snap.model).create({ data: rowForCreate(snap.model, withTenant(snap.model, snap.row), opts.override) })
  for (const [model, rows] of Object.entries(snap.children ?? {})) {
    for (const r of rows) await delegate(tx, model).create({ data: rowForCreate(model, withTenant(model, r)) })
  }
  return String(snap.row.id)
}
