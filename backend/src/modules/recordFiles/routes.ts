// /api/v1/record-files — files on any record (lib/recordFiles.ts is the
// contract; providers.ts holds each record type's own rule).
//
//   GET  /:ownerType/:ownerId           the files' metadata (id, fileName, mime, sizeBytes, createdAt,
//                                       uploadedByName) — NEVER bytes. Mode read.
//   POST /:ownerType/:ownerId           { files: [{ fileName, mime, dataBase64 }] } 1..5 — every file is
//                                       checked before anything is written, then all are written in one
//                                       transaction stamped with the RECORD's company; ≤ 10 per record
//                                       (409 TOO_MANY_FILES). Mode write. 201 { files }.
//   GET  /:ownerType/:ownerId/:fileId   the bytes (images / PDF inline, Office / text as an attachment;
//                                       private, no-store, nosniff). Mode read.
//
// An unknown ownerType is 404; a foreign or missing record is 404; a role or
// Module Access refusal is 403 exactly as the owning module answers. There is
// deliberately NO delete (see lib/recordFiles.ts): evidence on posted money is
// never removed, and a removal would have to be a parked Trash item.
//
// Not a central GATED_PREFIXES prefix: each provider applies its module's gate.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { sendEvidence } from '../../lib/evidenceFile.js'
import {
  recordFileProvider, decodeRecordFiles, writeRecordFilesTx, listRecordFiles, readRecordFile,
  zRecordFiles, RECORD_FILES_BODY_LIMIT, type RecordFileMode, type RecordFileProvider,
} from '../../lib/recordFiles.js'
import './providers.js'

type OwnerParams = { ownerType: string; ownerId: string }

async function ownerOf(req: FastifyRequest<{ Params: OwnerParams }>, mode: RecordFileMode): Promise<{ p: RecordFileProvider; tenantId: string }> {
  const p = recordFileProvider(req.params.ownerType)
  if (!p) throw new NotFoundError('Record type', req.params.ownerType)
  const { tenantId } = await p.resolve(req, req.params.ownerId, mode)
  return { p, tenantId }
}

export async function recordFileRoutes(fastify: FastifyInstance) {
  const guard = requireAuth(...ALL_STAFF)

  fastify.get<{ Params: OwnerParams }>('/:ownerType/:ownerId', { preHandler: guard }, async (req) => {
    const { p, tenantId } = await ownerOf(req, 'read')
    const files = await listRecordFiles(prisma, { ownerType: p.ownerType, ownerId: req.params.ownerId, tenantId })
    return { files: files.map(({ uploadedById: _u, ...f }) => f) }
  })

  fastify.post<{ Params: OwnerParams }>('/:ownerType/:ownerId', { preHandler: guard, bodyLimit: RECORD_FILES_BODY_LIMIT }, async (req, reply) => {
    const body = z.object({ files: zRecordFiles }).parse(req.body)
    const { p, tenantId } = await ownerOf(req, 'write')
    // Every file is decoded and checked before the transaction opens.
    const files = decodeRecordFiles(body.files, { allowOffice: p.allowOffice, stem: p.fileStem })
    const saved = await prisma.$transaction((tx) => writeRecordFilesTx(tx, {
      ownerType: p.ownerType, ownerId: req.params.ownerId, tenantId, uploadedById: req.staffUser!.id, files, label: p.label,
    }))
    await audit({
      category: p.auditCategory, action: 'record_file.upload', entity: p.ownerType, entityId: req.params.ownerId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      before: null, after: { files: saved.map((f) => ({ id: f.id, fileName: f.fileName, mime: f.mime, sizeBytes: f.sizeBytes })) },
    })
    return reply.status(201).send({
      files: saved.map(({ uploadedById: _u, ...f }) => ({ ...f, uploadedByName: req.staffUser!.name ?? null })),
    })
  })

  fastify.get<{ Params: OwnerParams & { fileId: string } }>('/:ownerType/:ownerId/:fileId', { preHandler: guard }, async (req, reply) => {
    const { p, tenantId } = await ownerOf(req, 'read')
    const file = await readRecordFile(prisma, { ownerType: p.ownerType, ownerId: req.params.ownerId, tenantId, fileId: req.params.fileId })
    if (!file) throw new NotFoundError('File', req.params.fileId)
    return sendEvidence(reply, file, file.fileName ?? `${p.fileStem}-${req.params.fileId.slice(0, 8)}`)
  })
}
