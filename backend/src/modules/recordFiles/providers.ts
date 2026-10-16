// Record-file providers — one per record type that carries supporting
// documents (lib/recordFiles.ts is the store and the contract).
//
// Each provider applies the OWNING module's rule, imported, never retyped:
//   • its role arrays (read = the module's GET of that record, write = the
//     module's route that creates / edits it) → 403 like the module;
//   • its Module Access gate: either the central GATED_PREFIXES rule of the
//     module's own path, evaluated as if the request were to that path
//     (`gateAs`, GET for read, POST for write — so readAnyOf applies to reads
//     exactly as in the module), or the module's in-route gate
//     (moduleGateForNewRoles) → 403. /record-files is NOT a gated prefix
//     itself, so this is the ONLY gate; every provider must set one where its
//     module has one;
//   • its company scope (lib/tenantScope.ts; procurement's supplier scope) →
//     404 for a missing or foreign record. Returns the RECORD's company.
//
//   owner type      record           read                         write                          gate
//   opex_payment    OpexPayment      OPEX_TEAM                    OPEX_TEAM                      'capital' (moduleGateForNewRoles, managers exempt)
//   supplier_bill   SupplierBill     AP_READERS                   AP_WRITERS (POST /bills)       /procurement/bills (procurement|accounting) + requireApWriterModule on write
//   goods_receipt   GoodsReceipt     PROCUREMENT_TEAM             MANAGERS (dock receive)        none (the dock page is deliberately ungated, decision 27)
//   prep_batch      PrepBatch        ALL_STAFF                    the cook who logged it, or a manager   none (as /crosschecks/prep-batches)
//   hr_document     HrDocument       HR_ADMIN                     HR_ADMIN                       /hr/documents (staff_hr)
//   fixed_asset     FixedAsset       FINANCIALS_VIEWERS           FA_WRITER_ROLES                /accounting/fixed-assets (accounting)
//
// The Purchase-order screen's "Attachment URL" is the SUPPLIER BILL form's
// (POST /procurement/bills stores attachmentUrl on SupplierBill), hence
// 'supplier_bill'.

import type { FastifyRequest } from 'fastify'
import type { UserRole } from '@prisma/client'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type TenantIdWhere } from '../../lib/tenantScope.js'
import { enforceModuleAccess } from '../../lib/moduleAccess.js'
import { registerRecordFileProvider, type RecordFileMode, type RecordFileProvider } from '../../lib/recordFiles.js'
import { ALL_STAFF, FINANCIALS_VIEWERS, MANAGERS, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { OPEX_TEAM } from '../opex/routes.js'
import { AP_READERS, AP_WRITERS, requireApWriterModule } from '../procurement/routes.js'
import { supplierScopeWhere } from '../procurement/scope.js'
import { HR_ADMIN } from '../hr/routes.js'
import { FA_WRITER_ROLES } from '../fixedAssets/events.js'

export const RECORD_OWNER = {
  opex_payment: 'opex_payment',
  supplier_bill: 'supplier_bill',
  goods_receipt: 'goods_receipt',
  prep_batch: 'prep_batch',
  hr_document: 'hr_document',
  fixed_asset: 'fixed_asset',
} as const

/** 403 unless the caller's role is in the module's array for this mode. */
function assertRole(req: FastifyRequest, roles: readonly string[], label: string): void {
  if (!roles.includes(req.staffUser!.role)) throw new ForbiddenError(`Your role cannot open the files of this ${label}`)
}

/** The central Module Access rule of the module's own API path, as if the request went there. */
async function gateAs(req: FastifyRequest, path: string, mode: RecordFileMode): Promise<void> {
  const su = req.staffUser!
  const u = await serviceClient.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
  await enforceModuleAccess(`/api/v1${path}`, {
    role: su.role as UserRole, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [],
  }, mode === 'read' ? 'GET' : 'POST')
}

/** The ids a scope `where` admits (empty = deny). */
function idsOf(where: TenantIdWhere): string[] {
  return typeof where.tenantId === 'string' ? [where.tenantId] : where.tenantId.in
}
const scopeMode = (mode: RecordFileMode): 'read' | 'write' => (mode === 'read' ? 'read' : 'write')

const opexGate = moduleGateForNewRoles(['capital'])

const opexPayment: RecordFileProvider = {
  ownerType: RECORD_OWNER.opex_payment,
  label: 'OpEx payment',
  allowOffice: false,
  auditCategory: 'accounting',
  fileStem: 'opex-receipt',
  async resolve(req, ownerId, mode) {
    assertRole(req, OPEX_TEAM, this.label)
    await opexGate(req)
    const p = await prisma.opexPayment.findFirst({
      where: { id: ownerId, line: { category: { deletedAt: null, ...(await scopeTenantWhere(req, scopeMode(mode))) } } },
      select: { line: { select: { category: { select: { tenantId: true } } } } },
    })
    const tenantId = p?.line.category.tenantId
    if (!tenantId) throw new NotFoundError('OpexPayment', ownerId)
    return { tenantId }
  },
}

const supplierBill: RecordFileProvider = {
  ownerType: RECORD_OWNER.supplier_bill,
  label: 'supplier bill',
  allowOffice: true,
  auditCategory: 'accounting',
  fileStem: 'supplier-bill',
  async resolve(req, ownerId, mode) {
    assertRole(req, mode === 'read' ? AP_READERS : AP_WRITERS, this.label)
    await gateAs(req, '/procurement/bills', mode)
    // As POST /bills: finance with 'accounting', every other role 'procurement'.
    if (mode !== 'read') await requireApWriterModule(req)
    const bill = await prisma.supplierBill.findFirst({
      where: { id: ownerId, supplier: await supplierScopeWhere(req, scopeMode(mode)) },
      select: { supplier: { select: { tenantId: true } } },
    })
    // A bill is always of a company's supplier (createBill refuses a company-less one).
    const tenantId = bill?.supplier.tenantId
    if (!tenantId) throw new NotFoundError('SupplierBill', ownerId)
    return { tenantId }
  },
}

const goodsReceipt: RecordFileProvider = {
  ownerType: RECORD_OWNER.goods_receipt,
  label: 'goods receipt',
  allowOffice: false,
  auditCategory: 'identity',
  fileStem: 'dock-photo',
  async resolve(req, ownerId, mode) {
    assertRole(req, mode === 'read' ? PROCUREMENT_TEAM : MANAGERS, this.label)
    const ids = idsOf(await scopeTenantWhere(req, scopeMode(mode)))
    const r = await prisma.goodsReceipt.findFirst({ where: { id: ownerId }, select: { tenantId: true, supplierId: true } })
    // Every new receipt carries its company; an old one falls back to its supplier's.
    const tenantId = r
      ? (r.tenantId ?? (await prisma.supplier.findUnique({ where: { id: r.supplierId }, select: { tenantId: true } }))?.tenantId ?? null)
      : null
    if (!tenantId || !ids.includes(tenantId)) throw new NotFoundError('GoodsReceipt', ownerId)
    return { tenantId }
  },
}

const prepBatch: RecordFileProvider = {
  ownerType: RECORD_OWNER.prep_batch,
  label: 'prep batch',
  allowOffice: false,
  auditCategory: 'identity',
  fileStem: 'prep-photo',
  async resolve(req, ownerId, mode) {
    assertRole(req, ALL_STAFF, this.label)
    const b = await prisma.prepBatch.findFirst({
      where: { id: ownerId, ...(await scopeTenantWhere(req, scopeMode(mode))) },
      select: { tenantId: true, staffId: true },
    })
    if (!b?.tenantId) throw new NotFoundError('PrepBatch', ownerId)
    // Anyone may log a prep; only the cook who logged it, or a manager, adds its photos.
    if (mode === 'write' && b.staffId !== req.staffUser!.id && !(MANAGERS as string[]).includes(req.staffUser!.role)) {
      throw new ForbiddenError('Only the person who logged this prep, or a manager, can add its photos')
    }
    return { tenantId: b.tenantId }
  },
}

const hrDocument: RecordFileProvider = {
  ownerType: RECORD_OWNER.hr_document,
  label: 'HR document',
  allowOffice: true,
  auditCategory: 'identity',
  fileStem: 'hr-document',
  async resolve(req, ownerId, mode) {
    assertRole(req, HR_ADMIN, this.label)
    await gateAs(req, '/hr/documents', mode)
    const d = await prisma.hrDocument.findFirst({
      where: { id: ownerId, ...(await scopeTenantWhere(req, scopeMode(mode))) },
      select: { tenantId: true },
    })
    if (!d) throw new NotFoundError('HrDocument', ownerId)
    return { tenantId: d.tenantId }
  },
}

const fixedAsset: RecordFileProvider = {
  ownerType: RECORD_OWNER.fixed_asset,
  label: 'fixed asset',
  allowOffice: true,
  auditCategory: 'accounting',
  fileStem: 'asset-document',
  async resolve(req, ownerId, mode) {
    assertRole(req, mode === 'read' ? FINANCIALS_VIEWERS : FA_WRITER_ROLES, this.label)
    await gateAs(req, '/accounting/fixed-assets', mode)
    const a = await prisma.fixedAsset.findFirst({
      where: { id: ownerId, ...(await scopeTenantWhere(req, scopeMode(mode))) },
      select: { tenantId: true },
    })
    if (!a) throw new NotFoundError('FixedAsset', ownerId)
    return { tenantId: a.tenantId }
  },
}

/** Registered once, at import (routes.ts imports this file). */
for (const p of [opexPayment, supplierBill, goodsReceipt, prepBatch, hrDocument, fixedAsset]) registerRecordFileProvider(p)
