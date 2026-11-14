// The servd supplier list (owner, 2026-11-14: "we need to make suppliers belong to servd. just like the ingredient
// master list"). `SupplierMaster` (platform data, NO tenantId — deliberate) is WHO the supplier is; each company's
// `Supplier` row is that company's ACCOUNT with them (bills, payments, opening balance, payment terms, buyer). Money
// never lives on the master, and nothing in the books moves between companies.
//
//   findOrCreateMasterTx            a master by name as servd compares it (trimmed, spaces collapsed, lower case)
//   ensureCompanySupplierForMasterTx THE way a company's account for a master is found or opened (never a second
//                                   live one: partial unique suppliers_tenant_master_live_key)
//   supplierForCompanyTx            "this supplier, in THAT company": the row itself when it is the company's, else
//                                   the company's account for the same servd supplier (opened when missing)
//   syncAccountsFromMasterTx        the definition fields mirrored onto every company's account
//
// System suppliers ('Cash purchases') and company-less legacy rows have no master.

import { Prisma } from '@prisma/client'
import { AppError, NotFoundError } from './errors.js'

type Tx = Prisma.TransactionClient

/** WHO the supplier is — servd-wide, mirrored onto every company's account. Everything else is the company's own. */
export const SUPPLIER_MASTER_FIELDS = [
  'name', 'category', 'phone', 'email', 'whatsappPhone', 'address', 'taxId',
  'filerStatus', 'whtExemptCertNo', 'whtExemptUntil', 'defaultTaxAuthority', 'defaultWhtSection',
] as const
export type SupplierMasterField = (typeof SUPPLIER_MASTER_FIELDS)[number]

export const cleanSupplierName = (name: string): string => name.replace(/\s+/g, ' ').trim()
export const normalizeSupplierName = (name: string): string => cleanSupplierName(name).toLowerCase()

type MasterRow = Prisma.SupplierMasterGetPayload<object>

/** The definition fields of a master, as account columns. */
export function accountFieldsFromMaster(m: MasterRow) {
  return {
    name: m.name, category: m.category, phone: m.phone, email: m.email, whatsappPhone: m.whatsappPhone, address: m.address,
    taxId: m.taxId, filerStatus: m.filerStatus, whtExemptCertNo: m.whtExemptCertNo, whtExemptUntil: m.whtExemptUntil,
    defaultTaxAuthority: m.defaultTaxAuthority, defaultWhtSection: m.defaultWhtSection,
  }
}

/** Follow a merged master to the one it was merged into. */
async function liveMasterTx(tx: Tx, id: string): Promise<MasterRow> {
  let m = await tx.supplierMaster.findUnique({ where: { id } })
  for (let hop = 0; m?.mergedIntoId && hop < 5; hop++) m = await tx.supplierMaster.findUnique({ where: { id: m.mergedIntoId } })
  if (!m) throw new NotFoundError('Supplier', id)
  return m
}

/** The master of that name, made when servd has none. Serialised per name so two requests never make two. */
export async function findOrCreateMasterTx(tx: Tx, input: Partial<Record<SupplierMasterField, unknown>> & { name: string; createdByUserId?: string | null }): Promise<MasterRow> {
  const name = cleanSupplierName(input.name)
  if (!name) throw new AppError('SUPPLIER_NAME_REQUIRED', 'Give the supplier a name', 422)
  const normalizedName = normalizeSupplierName(name)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'supplier.master:' + normalizedName}))`
  const found = await tx.supplierMaster.findFirst({ where: { normalizedName, mergedIntoId: null }, orderBy: { createdAt: 'asc' } })
  if (found) return found
  const { name: _n, createdByUserId, ...rest } = input
  return tx.supplierMaster.create({ data: { ...(rest as object), name, normalizedName, createdByUserId: createdByUserId ?? null } })
}

/** The company's live account for a servd supplier — found, else opened with the master's details (no balance). */
export async function ensureCompanySupplierForMasterTx(tx: Tx, masterId: string, tenantId: string): Promise<{ id: string; created: boolean }> {
  const master = await liveMasterTx(tx, masterId)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'supplier.account:' + tenantId + ':' + master.id}))`
  const found = await tx.supplier.findFirst({ where: { tenantId, masterSupplierId: master.id, deletedAt: null }, select: { id: true } })
  if (found) return { id: found.id, created: false }
  const made = await tx.supplier.create({ data: { ...accountFieldsFromMaster(master), tenantId, masterSupplierId: master.id }, select: { id: true } })
  return { id: made.id, created: true }
}

/**
 * "This supplier, in that company." The row itself when it is already the company's (or a system / unlinked row —
 * the caller's own company rules then apply); another company's account resolves to THIS company's account for the
 * same servd supplier, opened when missing. Never moves or touches the other company's account.
 */
export async function supplierForCompanyTx(tx: Tx, supplierId: string, tenantId: string): Promise<{ id: string; created: boolean }> {
  const s = await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true, tenantId: true, masterSupplierId: true, deletedAt: true } })
  if (!s || s.deletedAt) throw new NotFoundError('Supplier', supplierId)
  if (s.tenantId === tenantId || !s.masterSupplierId) return { id: s.id, created: false }
  return ensureCompanySupplierForMasterTx(tx, s.masterSupplierId, tenantId)
}

/** Mirror the master's definition fields onto every company's account (live or not — history reads the same name). */
export async function syncAccountsFromMasterTx(tx: Tx, masterId: string): Promise<number> {
  const master = await tx.supplierMaster.findUnique({ where: { id: masterId } })
  if (!master) return 0
  const r = await tx.supplier.updateMany({ where: { masterSupplierId: masterId }, data: accountFieldsFromMaster(master) })
  return r.count
}
