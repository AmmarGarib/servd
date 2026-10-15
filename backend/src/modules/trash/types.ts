// The Trash bin (owner, 2026-10-15) — the provider contract. README.md is the
// human contract; this file is the typed one. Every type that can sit in the
// Trash is ONE TrashProvider in the registry (registry.ts), keyed by
// `entityType`. Kind, strategy, module, roles and erasable rules live here,
// never on the trash_entries row.
//
// Strategies:
//   soft      the row carries deletedAt (set by the module's delete route);
//             restore clears it (+ provider rules), purge hard-deletes it.
//   snapshot  the module hard-deletes after moveToTrash stored the row (and its
//             children) in trash_entries.snapshot; restore re-creates them
//             with the SAME ids, purge drops the snapshot (tombstone stays).
//   status    "delete" is a status flip (archive / dismiss / end); restore
//             writes meta.previous back; never erasable.
//   none      a voided / cancelled TRANSACTION read from its own status by
//             the provider's list(); no restore, only "Recover as copy";
//             never erasable; the CEO may archive (hide) it.

import type { FastifyRequest } from 'fastify'
import type { Prisma, TrashEntry, UserRole } from '@prisma/client'
import type { TenantIdWhere } from '../../lib/tenantScope.js'

export type TrashKind = 'master' | 'transaction'
export type TrashStrategy = 'soft' | 'snapshot' | 'status' | 'none'
export type TrashState = 'in_trash' | 'restored' | 'purged' | 'archived'
export type Tx = Prisma.TransactionClient

export interface InjectResult { statusCode: number; json: unknown }

/** Everything a provider may need about the caller. Built once per request. */
export interface TrashCtx {
  req: FastifyRequest
  user: { id: string; role: UserRole; name: string | null; email: string | null }
  isCeo: boolean
  /** The caller's effective modules (admin: all). */
  modules: Set<string>
  /** scopeTenantWhere(req, 'read' | 'write' | 'create'). An empty scope DENIES. */
  readScope: TenantIdWhere
  writeScope: TenantIdWhere
  /** The ACTIVE company (create mode), or null. */
  activeTenantId: string | null
  /** Call another route AS the caller (same headers, same company view). */
  inject(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<InjectResult>
}

/** A row a provider lists (transactions) or the core builds from an entry. */
export interface TrashRow {
  id: string
  tenantId: string | null
  conceptId?: string | null
  title: string
  subtitle?: string | null
  /** When it was deleted / voided / cancelled. */
  at: Date
  byId?: string | null
  reason?: string | null
  /** The transaction's own status label ("Cancelled", "Voided"…). */
  statusLabel?: string | null
  /** Online orders etc.: listed but not copyable (null = copyable). */
  notCopyableReason?: string | null
}

export interface TrashListFilter {
  from?: Date
  to?: Date
  q?: string
  /** Rows strictly older than this (at desc, id desc). */
  before?: { at: Date; id: string }
  limit: number
}

export interface Reference { label: string; count: number }

export interface Clash {
  field: string
  value: string
  suggestion?: string
  renamable: boolean
  code?: string // default TRASH_CLASH
  message?: string
}

export type CopyResult =
  | { mode: 'created'; id: string; link: string; newEntityType?: string }
  | { mode: 'prefill'; link: string; payload: unknown }

export interface RestoreOpts { rename?: Record<string, string>; unlink?: boolean; reason?: string }

export interface TrashProvider {
  key: string
  label: string
  /** The caller's effective modules must hold it (admin always does). */
  moduleId: string
  /** = the module's own delete / create route guards (import its constant, never retype). */
  roles: { list: readonly UserRole[]; restore: readonly UserRole[]; copy?: readonly UserRole[] }
  kind: TrashKind
  strategy: TrashStrategy
  auditCategory: 'identity' | 'accounting'
  /** brands, logins, CEO site pages, period locks…: the CEO only, whatever the roles say. */
  ceoOnly?: boolean
  /** Prisma model name ('MenuItem') — lets the core do the default soft restore / purge and status restore. */
  model?: string
  /** Where the restored / original thing lives in the admin (for links). */
  linkOf?(entityId: string, entry?: TrashEntry | null): string | null
  /** Never restorable (F1–F5 money snapshots): only viewed, copied or archived. */
  restorable?: boolean

  // ── transactions (strategy 'none') ────────────────────────────────────────
  /** Voided / cancelled rows in ctx.readScope, at desc. */
  list?(ctx: TrashCtx, f: TrashListFilter): Promise<TrashRow[]>
  /** One row by id in ctx.readScope, or null (→ 404). */
  get?(ctx: TrashCtx, id: string): Promise<TrashRow | null>
  /** Field preview for the detail drawer. */
  preview?(ctx: TrashCtx, id: string, entry: TrashEntry | null): Promise<Array<{ label: string; value: string }>>

  // ── restore (masters) ─────────────────────────────────────────────────────
  /** Default: soft → clear deletedAt; snapshot → re-create; status → write meta.previous. */
  restore?(tx: Tx, ctx: TrashCtx, entry: TrashEntry, opts: RestoreOpts): Promise<{ id: string; link?: string | null } | void>
  /** → 409 PARENT_IN_TRASH when that parent has an OPEN entry. */
  parentOf?(entry: TrashEntry): { type: string; id: string } | null
  /** → 409 TRASH_CLASH (or clash.code) unless opts.rename resolves it. */
  clashOf?(tx: Tx, entry: TrashEntry, opts: RestoreOpts): Promise<Clash | null>

  // ── copy (transactions, and any master that offers it) ─────────────────────
  copy?(ctx: TrashCtx, id: string): Promise<CopyResult>
  notCopyableReason?: string

  // ── purge (CEO "Delete forever") ──────────────────────────────────────────
  /** What still points at it → 409 IN_USE. */
  references?(tx: Tx, entry: TrashEntry): Promise<Reference[]>
  /** false for books / tax / stock (static or per row). Default: no references. */
  erasable(entry: TrashEntry | null, refs: Reference[]): boolean
  /** Default: soft → hard delete of `model`; snapshot → drop the snapshot. */
  purge?(tx: Tx, entry: TrashEntry): Promise<void>
}

/** The list item the admin renders (frontend/admin/src/lib/trash.ts TrashItem). */
export interface TrashItem {
  type: string
  id: string
  kind: TrashKind
  label: string
  title: string
  subtitle?: string | null
  tenantId: string | null
  companyName?: string | null
  brandName?: string | null
  at: string
  byName?: string | null
  reason?: string | null
  state: TrashState
  restoredAt?: string | null
  restoredByName?: string | null
  purgedAt?: string | null
  archivedAt?: string | null
  statusLabel?: string | null
  canRestore: boolean
  canCopy: boolean
  notCopyableReason?: string | null
  erasable?: boolean
  link?: string | null
  copies?: { count: number; lastByName?: string | null; lastAt?: string | null }
}
