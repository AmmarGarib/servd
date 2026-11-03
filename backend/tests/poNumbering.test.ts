// PO numbers are servd's (owner, 2026-11-03: "remove reference from PO. it should auto generate"): PO-00001, PO-00002…
// per company (the supplier's); a typed reference is ignored; two companies count separately.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { createPo } from '../src/modules/procurement/service.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let A: Company; let B: Company; let ua: Who
const setup = async (c: Company, tag: string) => {
  const supplier = await prisma.supplier.create({ data: { name: `PO num ${tag} ${Date.now()}`, tenantId: c.tenantId } })
  const item = await prisma.inventoryItem.create({ data: { name: `PO num item ${tag} ${Date.now()}`, unit: 'kg', tenantId: c.tenantId } })
  return { supplierId: supplier.id, itemId: item.id }
}
beforeAll(async () => {
  A = await mkCompany(`ponum-a-${Date.now()}`)
  B = await mkCompany(`ponum-b-${Date.now()}`)
  ua = await mkUser('ponumA', 'admin', A.tenantId)
}, 60_000)

describe('PO numbers', () => {
  it('count up per company and ignore a typed reference', async () => {
    const a = await setup(A, 'a'); const b = await setup(B, 'b')
    const line = (itemId: string) => [{ inventoryItemId: itemId, quantityOrdered: 1, unitCostCents: 100 }]
    const p1 = await createPo({ supplierId: a.supplierId, lines: line(a.itemId), createdBy: ua.id, reference: 'MY-OWN' })
    const p2 = await createPo({ supplierId: a.supplierId, lines: line(a.itemId), createdBy: ua.id })
    const q1 = await createPo({ supplierId: b.supplierId, lines: line(b.itemId), createdBy: ua.id })
    expect([p1.reference, p2.reference, q1.reference]).toEqual(['PO-00001', 'PO-00002', 'PO-00001'])
  })
})
