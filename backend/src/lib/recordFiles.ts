// Record files — THE private store for supporting documents on any record
// (owner, 2026-10-16: switch every supporting-document URL to an upload, and
// "One private store … so any record can carry files — only staff of that
// company can open them, View + Download. One store across servd, no new
// copies").
//
// The store is the existing evidence table (CashVoucherAttachment, bytes in
// the DB, RLS by tenantId) with a GENERIC owner: kind 'record_file',
// (ownerType, ownerId). This file is the ONE writer / reader:
//
//   • a provider per ownerType (registerRecordFileProvider) — it applies the
//     owning module's OWN access rule (the same roles, the same Module Access
//     gate and the same company scope as that module's routes for the record;
//     foreign or missing → 404) and returns the RECORD's company. Rows are
//     always stamped with that company, never the actor's;
//   • files decode ONLY through lib/evidenceFile.ts decodeEvidenceFile
//     (JPEG / PNG / WebP / PDF, magic bytes; Office / CSV / text where the
//     provider allows it), ≤ 3 MB each, ≤ 10 per record (409 TOO_MANY_FILES,
//     counted under an advisory lock on the record), every file of an upload
//     checked BEFORE anything is written;
//   • lists carry metadata only — never bytes.
//
// There is NO remove: files are evidence. Most owners are posted money (a paid
// OpEx payment, a posted supplier bill, a goods receipt's lots and GRNI, a
// capitalised asset) whose evidence is never removed, and the Trash rules
// (CLAUDE.md) would make any delete a parked, restorable thing. A wrong file is
// superseded by uploading the right one; the CEO's Trash purge of an owner
// (e.g. an HR document) erases its files with it (purgeRecordFilesTx).
//
// A new screen with supporting documents = a provider (modules/recordFiles/
// providers.ts) + a two-company test — never a URL field, never a new table.

import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from './errors.js'
import { decodeEvidenceFile, safeFileName, EVIDENCE_EXT } from './evidenceFile.js'
import type { AuditCategory } from './audit.js'

export const RECORD_FILE_KIND = 'record_file'
/** Most files one record may carry. */
export const RECORD_FILES_MAX_PER_RECORD = 10
/** Most files in one upload call. */
export const RECORD_FILES_MAX_PER_UPLOAD = 5
/** 5 files × 3 MB, base64 (+⅓) and JSON overhead — the bodyLimit of every route that takes record files. */
export const RECORD_FILES_BODY_LIMIT = 22 * 1024 * 1024

/** One uploaded file as the client sends it. */
export const zRecordFile = z.object({
  fileName:   z.string().max(200).optional(),
  mime:       z.string().min(1).max(100),
  dataBase64: z.string().min(1),
})
export type RecordFileInput = z.infer<typeof zRecordFile>
/** 1..5 files (an upload call) — create routes that take files inline use `.max()` of this and allow 0. */
export const zRecordFiles = z.array(zRecordFile)
  .min(1, 'Choose a file')
  .max(RECORD_FILES_MAX_PER_UPLOAD, `At most ${RECORD_FILES_MAX_PER_UPLOAD} files at a time`)

export type RecordFileMode = 'read' | 'write'

export interface RecordFileProvider {
  /** The ownerType key (URL segment and stored column). */
  ownerType: string
  /** Human name of the record, for messages ('OpEx payment'). */
  label: string
  /** Office / CSV / text documents too (named by fileName) — else images and PDFs only. */
  allowOffice: boolean
  /** Which audit trail an upload goes on (lib/audit.ts: books → 'accounting', people / ops → 'identity'). */
  auditCategory: AuditCategory
  /** Prefix of the download name when a file has no name ('opex-receipt'). */
  fileStem: string
  /**
   * The module's own rule for this record: role, Module Access gate, company
   * scope. 403 for a role / module refused exactly as the module refuses it;
   * 404 when the record is missing or outside the caller's companies for
   * `mode`. Returns the RECORD's company (files are stamped with it).
   */
  resolve(req: FastifyRequest, ownerId: string, mode: RecordFileMode): Promise<{ tenantId: string }>
}

const registry = new Map<string, RecordFileProvider>()

export function registerRecordFileProvider(p: RecordFileProvider): void {
  if (registry.has(p.ownerType) && registry.get(p.ownerType) !== p) {
    throw new Error(`record file provider '${p.ownerType}' registered twice`)
  }
  registry.set(p.ownerType, p)
}
export function recordFileProvider(ownerType: string): RecordFileProvider | null {
  return registry.get(ownerType) ?? null
}
export function recordFileOwnerTypes(): string[] {
  return [...registry.keys()].sort()
}

export interface DecodedRecordFile { bytes: Buffer; mime: string; sizeBytes: number; fileName: string }

/**
 * Decode and check EVERY file (throws 400 BAD_FILE on the first bad one, so a
 * caller that decodes before its transaction writes nothing on a bad file).
 */
export function decodeRecordFiles(
  files: readonly RecordFileInput[],
  opts: { allowOffice: boolean; stem: string },
): DecodedRecordFile[] {
  return files.map((f, i) => {
    if (opts.allowOffice) {
      const d = decodeEvidenceFile(f.dataBase64, f.mime, { allowOffice: true, fileName: f.fileName ?? '' })
      return { bytes: d.bytes, mime: d.mime, sizeBytes: d.sizeBytes, fileName: d.fileName }
    }
    const d = decodeEvidenceFile(f.dataBase64, f.mime, { allowPdf: true })
    return { ...d, fileName: safeFileName(f.fileName ?? '', `${opts.stem}-${i + 1}.${EVIDENCE_EXT[d.mime]}`) }
  })
}

/** What a list returns per file — never the bytes. */
export const RECORD_FILE_META = {
  id: true, fileName: true, mime: true, sizeBytes: true, createdAt: true, uploadedById: true,
} as const satisfies Prisma.CashVoucherAttachmentSelect
export type RecordFileMeta = { id: string; fileName: string | null; mime: string; sizeBytes: number; createdAt: Date; uploadedById: string }

type Db = Prisma.TransactionClient

/**
 * Write decoded files under a record, INSIDE the caller's transaction. Takes
 * an advisory lock on (ownerType, ownerId) so two uploads never pass the cap
 * together; 409 TOO_MANY_FILES past RECORD_FILES_MAX_PER_RECORD. `tenantId`
 * is the RECORD's company (a provider's resolve, or the record just created).
 */
export async function writeRecordFilesTx(
  tx: Db,
  input: { ownerType: string; ownerId: string; tenantId: string; uploadedById: string; files: readonly DecodedRecordFile[]; label?: string },
): Promise<RecordFileMeta[]> {
  if (input.files.length === 0) return []
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`record_files:${input.ownerType}:${input.ownerId}`}::text))`
  const have = await tx.cashVoucherAttachment.count({
    where: { kind: RECORD_FILE_KIND, ownerType: input.ownerType, ownerId: input.ownerId },
  })
  if (have + input.files.length > RECORD_FILES_MAX_PER_RECORD) {
    throw new AppError(
      'TOO_MANY_FILES',
      `A${/^[aeiou]/i.test(input.label ?? 'record') ? 'n' : ''} ${input.label ?? 'record'} takes at most ${RECORD_FILES_MAX_PER_RECORD} files (${have} already attached)`,
      409,
    )
  }
  const out: RecordFileMeta[] = []
  for (const f of input.files) {
    out.push(await tx.cashVoucherAttachment.create({
      data: {
        tenantId: input.tenantId, kind: RECORD_FILE_KIND, ownerType: input.ownerType, ownerId: input.ownerId,
        mime: f.mime, fileName: f.fileName, sizeBytes: f.sizeBytes, data: f.bytes, uploadedById: input.uploadedById,
      },
      select: RECORD_FILE_META,
    }))
  }
  return out
}

/** The files of a record (metadata, oldest first, with the uploader's name). Company-pinned. */
export async function listRecordFiles(
  db: Db | PrismaClient,
  where: { ownerType: string; ownerId: string; tenantId: string },
): Promise<Array<RecordFileMeta & { uploadedByName: string | null }>> {
  const rows = await db.cashVoucherAttachment.findMany({
    where: { kind: RECORD_FILE_KIND, ...where },
    select: RECORD_FILE_META,
    orderBy: { createdAt: 'asc' },
  })
  const ids = [...new Set(rows.map((r) => r.uploadedById))]
  const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  const name = new Map(users.map((u) => [u.id, u.name]))
  return rows.map((r) => ({ ...r, uploadedByName: name.get(r.uploadedById) ?? null }))
}

/** One file with its bytes, or null — pinned to the record AND its company. */
export async function readRecordFile(
  db: Db | PrismaClient,
  where: { ownerType: string; ownerId: string; tenantId: string; fileId: string },
): Promise<{ mime: string; data: Uint8Array; fileName: string | null } | null> {
  const { fileId, ...owner } = where
  return db.cashVoucherAttachment.findFirst({
    where: { id: fileId, kind: RECORD_FILE_KIND, ...owner },
    select: { mime: true, data: true, fileName: true },
  })
}

/** The CEO's Trash "Delete forever" of an owning record erases its files too. */
export async function purgeRecordFilesTx(tx: Db, owner: { ownerType: string; ownerId: string; tenantId: string | null }): Promise<number> {
  const r = await tx.cashVoucherAttachment.deleteMany({
    where: { kind: RECORD_FILE_KIND, ownerType: owner.ownerType, ownerId: owner.ownerId, ...(owner.tenantId ? { tenantId: owner.tenantId } : {}) },
  })
  return r.count
}
