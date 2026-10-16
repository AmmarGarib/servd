// The simulated month — PURCHASING and STOCK (finance readiness plan §4a item
// 4, and the purchasing / stock accounts of "Ledger results to check"). Its
// own world on the shared harness (tests/sim/harness.ts — its header is the
// API); sales are in sales.sim.test.ts.
//
// Two companies, the same month in each (A 'GS Foods' — withholding ON with
// the confirmed rates; B 'GS x Viva' — withholding off). People: the manager
// raises POs, a second manager ("Store manager", seeded here like the
// harness's logins) takes deliveries at the dock (whoever raised a PO cannot
// receive it), FINANCE (Hasnain) records every bill, credit note and payment
// (owner, 2026-10-16), the CEO approves.
//
//   30 Sep   suppliers: Karachi Meats (filer, SRB), Unknown Traders (filer
//            status not known — H33), Old Mill (opening balance PKR 2,500
//            brought forward at 30 Sep → 3010, H49); the stock items (food,
//            drinks, packaging); PO0 (flour, under the approval threshold —
//            auto-approved) received at once and NEVER billed;
//   2 Oct    PO1 (above the threshold → the CEO approves), phoned in; the dock
//            refuses it without a photo and refuses the manager who raised it;
//            the store manager receives it with a dock photo FILE (record file
//            of the receipt);
//   3 Oct    0.5 kg chicken wasted (cost waits on 1290);
//   5 Oct    finance bills PO1 from the receipt at a HIGHER chicken price
//            (on-hand share re-prices the lot, the wasted share → 5060), plus a
//            non-stock cartage line on 6146 and SRB input tax (1322); A
//            withholds 1% (filer, 153(1)(a)) at the bill (H47);
//   6 Oct    credit note: 10 cans returned to the supplier (stock out of 1220,
//            tax back off 1322), applied to the bill;
//   7 Oct    PO2 to Unknown Traders, billed BEFORE delivery (FBR tax → 1320; A
//            withholds the NON-filer 2%, H33); cancelling PO2 is refused
//            (PO_BILLED_AHEAD); 9 Oct only 12 of 20 kg arrive — 8 kg stay billed
//            ahead at month end;
//   10 Oct   finance pays bill 1 by bank: two banks and none named → 422
//            BANK_ACCOUNT_REQUIRED, then the main bank;
//   12 Oct   a petty-cash box pays part of bill 2;
//   13 Oct   an extra payment to Unknown Traders: unapplied, applied to bill 2,
//            unapplied again, voided;
//   15 Oct   spot count: 10 boxes short (cost waits on 1290);
//   16 Oct   mint syrup moved food → drinks (its lots move 1210 → 1220);
//   30 Oct   another 0.25 kg chicken wasted — left pending for the CEO;
//   31 Oct   the CEO approves the first waste and the count, ONE LINE AT A TIME
//            (1290 → 5040 / 5050; finance cannot); finance asks to write off
//            PO0's flour (received 30 Sep, never billed, > 30 days) and the CEO
//            approves (Dr 2015 / Cr 5060).
// Month end (per company): every entry balanced, TB balances; 2010 = AP ageing
// as at the 31st (?asOf); 2015 = the open GRNI list − what is billed ahead;
// 1210 / 1220 / 1230 = the FIFO lot values per class; 1290 = the pending stock
// differences; 1320 / 1322 = input tax by authority; 2040 = the withholding
// kept (A only); 3010 = the opening balance. Company separation: B gets 404 on
// A's AP and stock records.
//
// Runtime ≈ 30 s. Requires a disposable database ("test" in DATABASE_URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { startSim, ok, errCode, type Sim, type SimCompany, type SimUser } from './harness.js'

let sim: Sim

// A 1×1 PNG — the dock-door photo (record files take images + PDF).
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const dockPhoto = (n = 1) => ({ fileName: `dock-${n}.png`, mime: 'image/png', dataBase64: PNG_1PX })

type CoKey = 'A' | 'B'
const T = (co: SimCompany, a: string, b: string) => (co.key === 'A' ? a : b)

interface Items { chicken: string; cola: string; boxes: string; mint: string; flour: string }
interface CoState {
  store: SimUser
  buyer: SimUser
  items: Items
  meats: string; unknown: string; mill: string
  po0: { id: string; lineId: string; receiptLineId?: string }
  po1: { id: string; lines: Record<keyof Items, string> }
  receipt1: { id: string; lines: Record<string, string> } // itemId → receipt line id
  bill1: { id: string; lines: Array<{ id: string; inventoryItemId: string | null; description: string }> }
  cn1: { id: string }
  po2: { id: string; lineId: string }
  bill2: { id: string }
  pay1: string
  extraPay: string
  box: string
  waste1: string; waste2: string; count1: string
}
const st: Record<CoKey, Partial<CoState>> = { A: {}, B: {} }
const S = (co: SimCompany) => st[co.key] as CoState

const OPENING = 250_000 // PKR 2,500 owed to Old Mill at 30 Sep

/** A login of the company (seeded the way the harness seeds its logins). */
async function mkLogin(co: SimCompany, name: string, role: 'manager' | 'procurement'): Promise<SimUser> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@sim.gsfoods.test`
  const u = await sim.prisma.user.create({
    data: {
      name, email, password: 'x', role, isActive: true, accountStatus: 'active', tenantId: co.tenantId,
      tenantMemberships: { create: [{ tenant: { connect: { id: co.tenantId } }, role: 'manager' }] },
    },
  })
  return { id: u.id, name, email, role, tenantId: co.tenantId }
}

const neg = (n: number) => (n === 0 ? 0 : -n)

const dueOf = (b: { totalCents: number; whtCents: number; paidCents: number; creditedCents: number }) =>
  Number(b.totalCents) - Number(b.whtCents) - Number(b.paidCents) - Number(b.creditedCents)

async function entry(co: SimCompany, ref: string) {
  const rows = await sim.ledger.entriesBySource(co, ref)
  expect(rows.length, `one entry ${ref}`).toBe(1)
  const net = new Map<string, number>()
  for (const l of rows[0]!.lines) net.set(l.code, (net.get(l.code) ?? 0) + (l.type === 'debit' ? l.cents : -l.cents))
  return net
}

const notFound = (label: string, r: LightMyRequestResponse) => expect(r.statusCode, `${label}: ${r.body.slice(0, 300)}`).toBe(404)

beforeAll(async () => {
  sim = await startSim()
}, 180_000)

afterAll(async () => {
  await sim?.close()
})

describe('the simulated month — purchasing and stock', () => {
  it('30 Sep: items, suppliers (one of unknown filer status, one with an opening balance → 3010), PO0 received and never billed', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-09-30', T(co, '11:00', '12:00'))
      const s = st[co.key]
      s.store = await mkLogin(co, `Store Manager ${co.key}`, 'manager')
      s.buyer = await mkLogin(co, `Buyer ${co.key}`, 'procurement')
      const mgr = sim.as(s.buyer, co)
      const item = async (name: string, unit: string, category: string) =>
        ok(await mgr.post('/inventory', { name, unit, category, parLevel: 0 }), 201).id as string
      s.items = {
        chicken: await item('Chicken breast', 'kg', 'protein'),
        cola: await item('Cola can', 'can', 'beverage'),
        boxes: await item('Takeaway box', 'pcs', 'packaging'),
        mint: await item('Mint syrup', 'bottle', 'sauce'),
        flour: await item('Flour', 'kg', 'dry_goods'),
      }
      const sup = async (body: Record<string, unknown>) => ok(await mgr.post('/procurement/suppliers', { paymentTermsDays: 15, ...body }), 201).id as string
      s.meats = await sup({ name: 'Karachi Meats', filerStatus: 'filer', defaultTaxAuthority: 'srb' })
      s.unknown = await sup({ name: 'Unknown Traders', filerStatus: 'unknown', defaultTaxAuthority: 'fbr' })
      // the opening balance is a manager's: the buyer setting one is refused
      const buyerTry = await mgr.post('/procurement/suppliers', { name: 'Old Mill', openingBalanceCents: OPENING, openingBalanceDate: '2026-09-30' })
      expect(buyerTry.statusCode, buyerTry.body).toBe(403)
      s.mill = ok(await sim.as(s.store, co).post('/procurement/suppliers', { name: 'Old Mill', filerStatus: 'filer', paymentTermsDays: 15, openingBalanceCents: OPENING, openingBalanceDate: '2026-09-30' }), 201).id

      // PO0: 20 kg flour @ PKR 150 — under the approval threshold, auto-approved on submit
      const po0 = ok(await mgr.post('/procurement/purchase-orders', { supplierId: s.meats, lines: [{ inventoryItemId: s.items.flour, quantityOrdered: 20, unitCostCents: 15_000 }] }), 201)
      expect(ok(await mgr.post(`/procurement/purchase-orders/${po0.id}/submit`, {}), 200).status).toBe('approved')
      ok(await mgr.post(`/procurement/purchase-orders/${po0.id}/mark-sent`, { channel: 'phone' }), 200)
      const r0 = ok(await sim.as(s.store, co).post(`/procurement/purchase-orders/${po0.id}/receive`, {
        photos: [dockPhoto()], lines: [{ poLineId: po0.lines[0].id, quantityReceived: 20 }],
      }), 201)
      s.po0 = { id: po0.id, lineId: po0.lines[0].id, receiptLineId: r0.receipt.lines[0].id }
    }
    for (const co of [sim.A, sim.B]) {
      expect(await sim.ledger.balanceOf(co, '3010', '2026-09-30'), 'Dr 3010 owner\'s capital (H49)').toBe(OPENING)
      expect(await sim.ledger.balanceOf(co, '2010', '2026-09-30'), 'Cr 2010 the opening balance').toBe(-OPENING)
      expect(await sim.ledger.balanceOf(co, '1210', '2026-09-30'), 'PO0 flour on 1210').toBe(300_000)
      expect(await sim.ledger.balanceOf(co, '2015', '2026-09-30'), 'PO0 flour on 2015 GRNI').toBe(-300_000)
    }
  })

  it('2 Oct: PO1 above the threshold — CEO approves; dock refuses no photo and the raiser; the store manager receives with a photo file', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-02', T(co, '10:00', '11:00'))
      const s = S(co)
      const mgr = sim.as(s.buyer, co)
      // finance raises and receives nothing (owner: kept apart from paying)
      const finPo = await sim.as(co.finance, co).post('/procurement/purchase-orders', { supplierId: s.meats, lines: [{ inventoryItemId: s.items.chicken, quantityOrdered: 1, unitCostCents: 80_000 }] })
      expect(finPo.statusCode, finPo.body).toBe(403)
      const po1 = ok(await mgr.post('/procurement/purchase-orders', {
        supplierId: s.meats, reference: `PO1-${co.key}`,
        lines: [
          { inventoryItemId: s.items.chicken, quantityOrdered: 50, unitCostCents: 80_000 },
          { inventoryItemId: s.items.cola, quantityOrdered: 100, unitCostCents: 6_000 },
          { inventoryItemId: s.items.boxes, quantityOrdered: 200, unitCostCents: 2_500 },
          { inventoryItemId: s.items.mint, quantityOrdered: 10, unitCostCents: 30_000 },
        ],
      }), 201)
      expect(Number(po1.totalCents)).toBe(5_400_000)
      expect(ok(await mgr.post(`/procurement/purchase-orders/${po1.id}/submit`, {}), 200).status).toBe('pending_approval')
      // the manager cannot approve; the CEO does
      expect((await mgr.post(`/procurement/purchase-orders/${po1.id}/approve`, {})).statusCode).toBe(403)
      ok(await sim.as(sim.ceo, co).post(`/procurement/purchase-orders/${po1.id}/approve`, {}), 200)
      ok(await mgr.post(`/procurement/purchase-orders/${po1.id}/mark-sent`, { channel: 'phone', note: 'Phoned to Karachi Meats' }), 200)
      const lineOf = (itemId: string) => (po1.lines as Array<{ id: string; inventoryItemId: string }>).find((l) => l.inventoryItemId === itemId)!.id
      s.po1 = { id: po1.id, lines: { chicken: lineOf(s.items.chicken), cola: lineOf(s.items.cola), boxes: lineOf(s.items.boxes), mint: lineOf(s.items.mint), flour: '' } }
    }
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-02', T(co, '16:00', '17:00'))
      const s = S(co)
      const mgr = sim.as(s.buyer, co)
      const po1 = { id: s.po1.id }
      const lines = (['chicken', 'cola', 'boxes', 'mint'] as const).map((k) => ({ poLineId: s.po1.lines[k], quantityReceived: { chicken: 50, cola: 100, boxes: 200, mint: 10 }[k] }))
      const noPhoto = await sim.as(s.store, co).post(`/procurement/purchase-orders/${po1.id}/receive`, { lines })
      expect(noPhoto.statusCode, noPhoto.body).toBe(400)
      expect(errCode(noPhoto)).toBe('PHOTO_REQUIRED')
      const own = await mgr.post(`/procurement/purchase-orders/${po1.id}/receive`, { photos: [dockPhoto()], lines })
      expect(own.statusCode, `the raiser receives: ${own.body}`).toBe(403)
      const r = ok(await sim.as(s.store, co).post(`/procurement/purchase-orders/${po1.id}/receive`, { photos: [dockPhoto(1), dockPhoto(2)], notes: 'All in, cold chain fine', lines }), 201)
      expect(r.status).toBe('received')
      expect(r.files.length).toBe(2)
      s.receipt1 = { id: r.receipt.id, lines: Object.fromEntries((r.receipt.lines as Array<{ id: string; inventoryItemId: string }>).map((l) => [l.inventoryItemId, l.id])) }
      // the photos are record files of the receipt (the dock's managers open them; finance cannot — P-2 below)
      const files = ok(await sim.as(s.store, co).get(`/record-files/goods_receipt/${r.receipt.id}`), 200)
      const list = (Array.isArray(files) ? files : files.files) as Array<{ id: string; mime: string }>
      expect(list.length).toBe(2)
      const one = await sim.as(s.store, co).get(`/record-files/goods_receipt/${r.receipt.id}/${list[0]!.id}`)
      expect(one.statusCode).toBe(200)
      expect(one.headers['content-type']).toContain('image/png')
      // Dr 12x0 per class / Cr 2015
      const e = await entry(co, `procurement.receipt:${r.receipt.id}`)
      expect(e.get('1210')).toBe(50 * 80_000 + 10 * 30_000)
      expect(e.get('1220')).toBe(100 * 6_000)
      expect(e.get('1230')).toBe(200 * 2_500)
      expect(e.get('2015')).toBe(-5_400_000)
    }
  })

  it('3 Oct: 0.5 kg chicken wasted — stock leaves at once, its cost waits on 1290', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-03', T(co, '21:00', '22:00'))
      const w = ok(await sim.as(S(co).store, co).post(`/inventory/${S(co).items.chicken}/waste`, { quantity: 0.5, unit: 'kg', reason: 'spoilage', notes: 'Left out of the chiller' }), 201)
      S(co).waste1 = (w.log?.id ?? w.id) as string
      const e = await entry(co, `inventory.waste:${S(co).waste1}`)
      expect(e.get('1290'), 'Dr 1290 suspense').toBe(40_000)
      expect(e.get('1210')).toBe(-40_000)
    }
  })

  it('5 Oct: finance bills PO1 from the receipt — higher chicken price, a non-stock 6146 line, SRB input tax; A withholds 1% (filer)', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-05', T(co, '11:00', '12:00'))
      const s = S(co)
      const fin = sim.as(co.finance, co)
      // a stock line with no receipt or PO line is refused ("receive it at the dock first")
      const noReceipt = await fin.post('/procurement/bills', {
        supplierId: s.meats, billNumber: `KM-X-${co.key}`, billDate: '2026-10-05',
        lines: [{ inventoryItemId: s.items.chicken, description: 'Chicken', quantity: 1, unitCostCents: 85_000 }],
      })
      expect(errCode(noReceipt), noReceipt.body).toBe('STOCK_LINE_NEEDS_RECEIPT')
      const rl = s.receipt1.lines
      const bill = ok(await fin.post('/procurement/bills', {
        supplierId: s.meats, poId: s.po1.id, billNumber: `KM-1001-${co.key}`, billDate: '2026-10-05',
        taxCents: 870_000, taxAuthority: 'srb',
        lines: [
          { receiptLineId: rl[s.items.chicken], description: 'Chicken breast', quantity: 50, unitCostCents: 85_000 },
          { receiptLineId: rl[s.items.cola], description: 'Cola can', quantity: 100, unitCostCents: 6_000 },
          { receiptLineId: rl[s.items.boxes], description: 'Takeaway box', quantity: 200, unitCostCents: 2_500 },
          { receiptLineId: rl[s.items.mint], description: 'Mint syrup', quantity: 10, unitCostCents: 30_000 },
          { expenseAccountCode: '6146', description: 'Cartage from the market', quantity: 1, unitCostCents: 150_000 },
        ],
      }), 201)
      s.bill1 = { id: bill.id, lines: bill.lines }
      const wht = co.key === 'A' ? 58_000 : 0 // 1% of the PKR 58,000 subtotal (filer, 153(1)(a)); B: withholding off
      expect(Number(bill.subtotalCents)).toBe(5_800_000)
      expect(Number(bill.whtCents)).toBe(wht)
      expect(bill.taxAuthority).toBe('srb')
      const e = await entry(co, `supplier.bill:${bill.id}`)
      expect(e.get('2015'), 'Dr 2015 at the receipt cost').toBe(5_400_000)
      expect(e.get('1210'), 'the dearer chicken still on hand (49.5 kg × PKR 50)').toBe(247_500)
      expect(e.get('5060'), 'the dearer chicken already wasted (0.5 kg × PKR 50)').toBe(2_500)
      expect(e.get('6146'), 'the non-stock line').toBe(150_000)
      expect(e.get('1322'), 'SRB input tax').toBe(870_000)
      expect(e.get('1320') ?? 0).toBe(0)
      expect(e.get('2040') ?? 0, 'withholding at the bill (H47)').toBe(neg(wht))
      expect(e.get('2010')).toBe(-(5_800_000 + 870_000 - wht))
      const chicken = await sim.prisma.stockLot.findMany({ where: { inventoryItemId: s.items.chicken } })
      expect(chicken.map((l) => l.unitCostCents), 'the lot is re-priced at the price paid').toEqual([85_000])
    }
  })

  it('6 Oct: credit note — 10 cans returned to the supplier, stock and SRB tax back, applied to the bill', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-06', T(co, '11:00', '12:00'))
      const s = S(co)
      const colaLine = s.bill1.lines.find((l) => l.inventoryItemId === s.items.cola)!
      const cn = ok(await sim.as(co.finance, co).post(`/procurement/bills/${s.bill1.id}/credit-notes`, {
        number: `KM-CN-1-${co.key}`, date: '2026-10-06', reason: 'return', returnStock: true, taxCents: 9_000,
        lines: [{ billLineId: colaLine.id, qty: 10 }], notes: 'Dented cans sent back',
      }), 201)
      s.cn1 = { id: cn.id }
      expect(Number(cn.totalCents)).toBe(69_000)
      expect(cn.appliedCents).toBe(69_000 - Number(cn.whtCents))
      expect(Number(cn.whtCents)).toBe(co.key === 'A' ? 600 : 0)
      const e = await entry(co, `supplier.credit_note:${cn.id}`)
      expect(e.get('1220'), 'the cans leave drinks stock').toBe(-60_000)
      expect(e.get('1322'), 'SRB input tax back').toBe(-9_000)
      expect(e.get('2010')).toBe(69_000 - Number(cn.whtCents))
      expect(e.get('2040') ?? 0).toBe(Number(cn.whtCents))
      const cola = await sim.prisma.inventoryItem.findUniqueOrThrow({ where: { id: s.items.cola } })
      expect(cola.currentStock).toBe(90)
    }
  })

  it('7–9 Oct: PO2 billed before delivery (unknown filer → NON-filer rate in A, FBR tax); cancel refused; 12 of 20 kg arrive', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-07', T(co, '10:00', '11:00'))
      const s = S(co)
      const mgr = sim.as(s.buyer, co)
      const po2 = ok(await mgr.post('/procurement/purchase-orders', { supplierId: s.unknown, lines: [{ inventoryItemId: s.items.chicken, quantityOrdered: 20, unitCostCents: 80_000 }] }), 201)
      expect(ok(await mgr.post(`/procurement/purchase-orders/${po2.id}/submit`, {}), 200).status).toBe('approved')
      ok(await mgr.post(`/procurement/purchase-orders/${po2.id}/mark-sent`, { channel: 'whatsapp' }), 200)
      s.po2 = { id: po2.id, lineId: po2.lines[0].id }
      const bill = ok(await sim.as(co.finance, co).post('/procurement/bills', {
        supplierId: s.unknown, poId: po2.id, billNumber: `UT-77-${co.key}`, billDate: '2026-10-07', taxCents: 295_200, taxAuthority: 'fbr',
        lines: [{ poLineId: s.po2.lineId, description: 'Chicken breast (advance bill)', quantity: 20, unitCostCents: 82_000 }],
      }), 201)
      s.bill2 = { id: bill.id }
      const wht = co.key === 'A' ? 32_800 : 0 // H33: status unknown → the NON-filer 2% of PKR 16,400
      expect(Number(bill.whtCents)).toBe(wht)
      expect(bill.whtRateBps).toBe(co.key === 'A' ? 200 : 0)
      const e = await entry(co, `supplier.bill:${bill.id}`)
      expect(e.get('2015'), 'billed ahead: Dr 2015 at the billed price').toBe(1_640_000)
      expect(e.get('1320'), 'FBR input tax').toBe(295_200)
      expect(e.get('2040') ?? 0).toBe(neg(wht))
      expect(e.get('2010')).toBe(-(1_640_000 + 295_200 - wht))
      const pending = await sim.prisma.grniMatch.findMany({ where: { billId: bill.id } })
      expect(pending.map((m) => m.status)).toEqual(['pending'])
      // the PO-cancel guard
      const cancel = await mgr.post(`/procurement/purchase-orders/${po2.id}/cancel`, { reason: 'Supplier cannot deliver' })
      expect(cancel.statusCode, cancel.body).toBe(409)
      expect(errCode(cancel)).toBe('PO_BILLED_AHEAD')
      // the other side of the guard: a cancelled PO cannot be billed ahead
      const po3 = ok(await mgr.post('/procurement/purchase-orders', { supplierId: s.unknown, lines: [{ inventoryItemId: s.items.cola, quantityOrdered: 10, unitCostCents: 6_000 }] }), 201)
      ok(await mgr.post(`/procurement/purchase-orders/${po3.id}/submit`, {}), 200)
      ok(await mgr.post(`/procurement/purchase-orders/${po3.id}/cancel`, { reason: 'Ordered by mistake' }), 200)
      const ahead = await sim.as(co.finance, co).post('/procurement/bills', {
        supplierId: s.unknown, poId: po3.id, billNumber: `UT-78-${co.key}`, billDate: '2026-10-07',
        lines: [{ poLineId: po3.lines[0].id, description: 'Cola', quantity: 10, unitCostCents: 6_000 }],
      })
      expect(errCode(ahead), ahead.body).toBe('PO_CANCELLED')
    }
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-09', T(co, '09:00', '10:00'))
      const s = S(co)
      const r = ok(await sim.as(s.store, co).post(`/procurement/purchase-orders/${s.po2.id}/receive`, {
        photos: [dockPhoto()], lines: [{ poLineId: s.po2.lineId, quantityReceived: 12, discrepancyReason: 'short_shipment', notes: '8 kg to follow' }],
      }), 201)
      expect(r.status).toBe('partial')
      const e = await entry(co, `procurement.receipt:${r.receipt.id}`)
      expect(e.get('1210'), 'the 12 kg open a lot at the BILLED price').toBe(12 * 82_000)
      expect(e.get('2015')).toBe(-12 * 82_000)
      const lots = await sim.prisma.stockLot.findMany({ where: { receiptLineId: r.receipt.lines[0].id } })
      expect(lots.map((l) => [l.qtyIn, l.unitCostCents])).toEqual([[12, 82_000]])
    }
  })

  it('10 Oct: finance pays bill 1 by bank — two banks and none named → 422 BANK_ACCOUNT_REQUIRED, then the main bank', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-10', T(co, '11:00', '12:00'))
      const s = S(co)
      const fin = sim.as(co.finance, co)
      const b = ok(await fin.get(`/procurement/bills/${s.bill1.id}`), 200)
      const due = dueOf(b)
      expect(due).toBe(5_800_000 + 870_000 - (co.key === 'A' ? 58_000 : 0) - (69_000 - (co.key === 'A' ? 600 : 0)))
      const body = { supplierId: s.meats, paymentDate: '2026-10-10', method: 'bank_transfer', reference: `IBFT-${co.key}-1001`, amountCents: due, applications: [{ billId: s.bill1.id, amountAppliedCents: due }] }
      const none = await fin.post('/procurement/payments', body)
      expect(none.statusCode, none.body).toBe(422)
      expect(errCode(none)).toBe('BANK_ACCOUNT_REQUIRED')
      // another company's bank is refused too
      const other = co.key === 'A' ? sim.B : sim.A
      const foreign = await fin.post('/procurement/payments', { ...body, bankAccountId: other.banks.main.id })
      expect([404, 422], foreign.body).toContain(foreign.statusCode)
      console.log('[sim] foreign bank:', foreign.statusCode, errCode(foreign))
      const p = ok(await fin.post('/procurement/payments', { ...body, bankAccountId: co.banks.main.id }), 201)
      s.pay1 = p.id
      const e = await entry(co, `supplier.payment:${p.id}`)
      expect(e.get('2010')).toBe(due)
      expect(e.get(co.banks.main.code)).toBe(-due)
      expect(ok(await fin.get(`/procurement/bills/${s.bill1.id}`), 200).status).toBe('paid')
    }
  })

  it('12 Oct: a petty-cash box pays PKR 400 of bill 2 (cash supplier payment)', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-12', T(co, '10:00', '11:00'))
      const s = S(co)
      const fin = sim.as(co.finance, co)
      const box = ok(await fin.post('/trustops/petty-cash/boxes', { name: `Kitchen box ${co.key}`, custodianId: co.finance.id, floatCents: 100_000, openingSource: 'garibsons' }), 201)
      s.box = box.id
      const m = ok(await fin.post('/trustops/petty-cash/movements', { boxId: box.id, type: 'spend', amountCents: 40_000, reason: 'Part payment to Unknown Traders', supplierBillId: s.bill2.id }), 201)
      expect(m.newFloatCents).toBe(60_000)
      const b = ok(await fin.get(`/procurement/bills/${s.bill2.id}`), 200)
      expect(Number(b.paidCents)).toBe(40_000)
      expect(b.status).toBe('partially_paid')
      expect(await sim.ledger.balanceOf(co, '1011'), '1011 = the box float').toBe(60_000)
    }
  })

  it('13 Oct: an extra payment to Unknown Traders — unapplied, applied, unapplied, voided', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-13', T(co, '10:00', '11:00'))
      const s = S(co)
      const fin = sim.as(co.finance, co)
      const p = ok(await fin.post('/procurement/payments', { supplierId: s.unknown, paymentDate: '2026-10-13', method: 'bank_transfer', bankAccountId: co.banks.second.id, reference: `IBFT-${co.key}-2002`, amountCents: 300_000 }), 201)
      s.extraPay = p.id
      expect(Number(p.appliedCents)).toBe(0)
      ok(await fin.post(`/procurement/payments/${p.id}/allocate`, { applications: [{ billId: s.bill2.id, amountAppliedCents: 200_000 }] }), 200)
      expect(Number(ok(await fin.get(`/procurement/bills/${s.bill2.id}`), 200).paidCents)).toBe(240_000)
      // a payment applied to a bill cannot be voided
      const early = await fin.post(`/procurement/payments/${p.id}/void`, { reason: 'Paid twice by mistake' })
      expect(early.statusCode, early.body).toBeGreaterThanOrEqual(400)
      console.log('[sim] void while applied:', early.statusCode, errCode(early))
      ok(await fin.post(`/procurement/payments/${p.id}/unapply`, { billId: s.bill2.id }), 200)
      expect(Number(ok(await fin.get(`/procurement/bills/${s.bill2.id}`), 200).paidCents)).toBe(40_000)
      const v = ok(await fin.post(`/procurement/payments/${p.id}/void`, { reason: 'Paid twice by mistake' }), 200)
      expect(v.voidedAt).toBeTruthy()
      // the payment and its reversal net to nothing on 2010 and the second bank
      const pay = await entry(co, `supplier.payment:${p.id}`)
      expect(pay.get('2010')).toBe(300_000)
      const rev = await sim.ledger.entriesBySource(co, `supplier.payment.void:${p.id}`)
      expect(rev.length, 'the void reversal').toBe(1)
    }
  })

  it('15–16 Oct: a short count (10 boxes, cost waits on 1290); mint syrup moved food → drinks', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-15', T(co, '22:00', '22:30'))
      const s = S(co)
      const noReason = await sim.as(S(co).store, co).post('/crosschecks/physical-counts', { kind: 'spot', lines: [{ inventoryItemId: s.items.boxes, physicalQty: 190 }] })
      expect(noReason.statusCode, `a count difference without a reason: ${noReason.body}`).toBeGreaterThanOrEqual(400)
      const c = ok(await sim.as(S(co).store, co).post('/crosschecks/physical-counts', { kind: 'spot', lines: [{ inventoryItemId: s.items.boxes, physicalQty: 190, reason: 'Short — a sleeve went missing' }] }), 201)
      s.count1 = c.id
      const e = await entry(co, `inventory.count:${c.id}`)
      expect(e.get('1290')).toBe(25_000)
      expect(e.get('1230')).toBe(-25_000)
    }
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-16', T(co, '10:00', '10:30'))
      const s = S(co)
      ok(await sim.as(S(co).store, co).patch(`/inventory/${s.items.mint}`, { category: 'beverage' }), 200)
      const moved = await sim.ledger.entriesBySource(co, `inventory.item_reclass:${s.items.mint}:`)
      expect(moved.length).toBe(1)
      const net = new Map<string, number>()
      for (const l of moved[0]!.lines) net.set(l.code, (net.get(l.code) ?? 0) + (l.type === 'debit' ? l.cents : -l.cents))
      expect(net.get('1220')).toBe(300_000)
      expect(net.get('1210')).toBe(-300_000)
      const lots = await sim.prisma.stockLot.findMany({ where: { inventoryItemId: s.items.mint } })
      expect(lots.every((l) => l.costClass === 'beverage')).toBe(true)
    }
  })

  it('30–31 Oct: the CEO approves stock differences line by line (finance cannot); one waste left pending; PO0\'s stale GRNI written off by the CEO', async () => {
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-30', T(co, '21:00', '21:30'))
      const w = ok(await sim.as(S(co).store, co).post(`/inventory/${S(co).items.chicken}/waste`, { quantity: 0.25, unit: 'kg', reason: 'expired' }), 201)
      S(co).waste2 = (w.log?.id ?? w.id) as string
    }
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-31', T(co, '10:00', '11:00'))
      const s = S(co)
      const fin = sim.as(co.finance, co)
      const list = ok(await fin.get('/accounting/stock-differences?status=pending'), 200)
      const rows = list.rows as Array<{ lineId: string; reference: string; valueCents: number; kind: string }>
      expect(rows.length, JSON.stringify(rows)).toBe(3)
      const lineFor = (ref: string) => rows.find((r) => r.reference === ref)!.lineId
      const wLine = lineFor(`inventory.waste:${s.waste1}`)
      const cLine = lineFor(`inventory.count:${s.count1}`)
      expect((await fin.post('/accounting/stock-differences/approve', { lineIds: [wLine] })).statusCode, 'finance cannot approve').toBe(403)
      const ceo = sim.as(sim.ceo, co)
      const a1 = ok(await ceo.post('/accounting/stock-differences/approve', { lineIds: [wLine] }), 200)
      expect(a1.cleared.map((c: { account: string }) => c.account)).toEqual(['5040'])
      const a2 = ok(await ceo.post('/accounting/stock-differences/approve', { lineIds: [cLine] }), 200)
      expect(a2.cleared.map((c: { account: string }) => c.account)).toEqual(['5050'])
      const again = await ceo.post('/accounting/stock-differences/approve', { lineIds: [cLine] })
      expect(errCode(again), again.body).toBe('ALREADY_CLEARED')
      expect(await sim.ledger.balanceOf(co, '5040')).toBe(40_000)
      expect(await sim.ledger.balanceOf(co, '5050')).toBe(25_000)
    }
    for (const co of [sim.A, sim.B]) {
      sim.clock.at('2026-10-31', T(co, '18:00', '19:00'))
      const s = S(co)
      const fin = sim.as(co.finance, co)
      const ceo = sim.as(sim.ceo, co)
      // GRNI: PO0's flour, received 30 Sep, never billed — stale (> 30 days)
      const grni = ok(await fin.get('/procurement/grni?olderThanDays=30'), 200)
      const stale = (grni.lines as Array<{ receiptLineId: string; stale: boolean; openValueCents: number }>)
      expect(stale.map((l) => l.receiptLineId)).toEqual([s.po0.receiptLineId])
      expect(stale[0]!.stale).toBe(true)
      ok(await fin.post(`/procurement/grni/${s.po0.receiptLineId}/write-off-request`, { reason: 'Supplier confirms the flour was free samples — no bill will come' }), 200)
      expect((await fin.post(`/procurement/grni/${s.po0.receiptLineId}/write-off/approve`, {})).statusCode, 'finance cannot approve its own request').toBe(403)
      const wo = ok(await ceo.post(`/procurement/grni/${s.po0.receiptLineId}/write-off/approve`, {}), 200)
      expect(wo.valueCents).toBe(300_000)
      const e = await entry(co, `procurement.grni_writeoff:${s.po0.receiptLineId}`)
      expect(e.get('2015')).toBe(300_000)
      expect(e.get('5060')).toBe(-300_000)
    }
  })
})

// ─── Month end ──────────────────────────────────────────────────────────────

describe('month end — the purchasing and stock accounts tie to their sub-ledgers', () => {
  const LAST = '2026-10-31'
  for (const key of ['A', 'B'] as const) {
    it(`${key}: every entry balanced, the trial balance balances (one net figure per account, no zero rows)`, async () => {
      const co = sim[key]
      await sim.ledger.assertBalanced(co)
      const tb = await sim.ledger.trialBalance(co, LAST)
      expect(tb.debitCents).toBe(tb.creditCents)
      for (const r of tb.rows) {
        expect(r.debitCents === 0 || r.creditCents === 0, `${r.code}: one side only`).toBe(true)
        expect(r.debitCents + r.creditCents, `${r.code}: no zero rows`).toBeGreaterThan(0)
      }
      expect(await sim.ledger.openFlags(co, 'posting_failed')).toEqual([])
    })

    it(`${key}: 2010 = AP ageing as at the 31st; 3010 = the opening balance`, async () => {
      const co = sim[key]
      const s = S(co)
      const ag = ok(await sim.as(co.finance, co).get(`/procurement/ap-aging?asOf=${LAST}`), 200)
      const ap2010 = neg(await sim.ledger.balanceOf(co, '2010', LAST))
      expect(ag.total.total, `ageing ${JSON.stringify(ag.total)} vs 2010 ${ap2010}`).toBe(ap2010)
      // by hand: bill 2 still due + Old Mill's opening (bill 1 paid in full, the extra payment voided)
      const wht2 = key === 'A' ? 32_800 : 0
      expect(ap2010).toBe(1_640_000 + 295_200 - wht2 - 40_000 + OPENING)
      expect(ag.total.openingCents).toBe(OPENING)
      expect(ag.total.creditsCents, 'no unapplied credit left (the extra payment was voided)').toBe(0)
      expect(ag.bySupplier.every((r: { tenantId: string }) => r.tenantId === co.tenantId)).toBe(true)
      expect(await sim.ledger.balanceOf(co, '3010', LAST)).toBe(OPENING)
      void s
    })

    it(`${key}: 2015 = the open GRNI list − what is billed ahead of delivery`, async () => {
      const co = sim[key]
      const g = ok(await sim.as(co.finance, co).get('/procurement/grni'), 200)
      const grni = neg(await sim.ledger.balanceOf(co, '2015', LAST))
      expect(grni, `2015 vs ${JSON.stringify(g.totals)}`).toBe(g.totals.openValueCents - g.totals.pendingBilledCents)
      // by hand: nothing received is unbilled (PO0 written off), 8 kg billed ahead at PKR 820
      expect(g.totals.openValueCents).toBe(0)
      expect(g.totals.pendingBilledCents).toBe(8 * 82_000)
      expect(g.pendingBillMatches.map((m: { qty: number }) => m.qty)).toEqual([8])
    })

    it(`${key}: 1210 / 1220 / 1230 = the FIFO lot values per class; 1290 = the pending stock differences`, async () => {
      const co = sim[key]
      const { lotValuation } = await import('../../src/lib/stockLedger.js')
      const lots = await lotValuation(sim.prisma as never, co.tenantId)
      const raw = await sim.prisma.stockLot.groupBy({ by: ['costClass'], where: { tenantId: co.tenantId }, _sum: { remainingValueCents: true } })
      const rawOf = (c: string) => Number(raw.find((r) => r.costClass === c)?._sum.remainingValueCents ?? 0)
      for (const [cls, code] of [['food', '1210'], ['beverage', '1220'], ['packaging', '1230']] as const) {
        const bal = await sim.ledger.balanceOf(co, code, LAST)
        expect(bal, `${code} = ${cls} lots`).toBe(lots[cls])
        expect(bal, `${code} = Σ remaining lot value`).toBe(rawOf(cls))
      }
      // by hand: chicken 49.25 kg @ 850 + 12 kg @ 820 (food, flour written off GRNI only — still on the shelf @ 150 × 20)
      expect(await sim.ledger.balanceOf(co, '1210', LAST)).toBe(Math.round(49.25 * 85_000) + 12 * 82_000 + 20 * 15_000)
      expect(await sim.ledger.balanceOf(co, '1220', LAST)).toBe(90 * 6_000 + 10 * 30_000)
      expect(await sim.ledger.balanceOf(co, '1230', LAST)).toBe(190 * 2_500)
      const pend = ok(await sim.as(co.finance, co).get('/accounting/stock-differences?status=pending'), 200)
      const pending = (pend.rows as Array<{ valueCents: number }>).reduce((t, r) => t + r.valueCents, 0)
      expect(await sim.ledger.balanceOf(co, '1290', LAST), '1290 = pending differences').toBe(pending)
      expect(pending, 'the 0.25 kg waste of the 30th').toBe(Math.round(0.25 * 85_000))
      expect(pend.totals.netCents).toBe(pending)
    })

    it(`${key}: input tax by authority (1322 SRB, 1320 FBR) and 2040 withholding = the bills and credit notes`, async () => {
      const co = sim[key]
      const docs = await sim.prisma.supplierBill.findMany({ where: { supplier: { tenantId: co.tenantId }, status: { not: 'void' } } })
      const sign = (d: { kind: string }) => (d.kind === 'credit_note' ? -1 : 1)
      // a credit note's tax comes off its original bill's authority
      const authOf = (d: { taxAuthority: string | null; originalBillId: string | null }) =>
        d.originalBillId ? docs.find((x) => x.id === d.originalBillId)?.taxAuthority ?? null : d.taxAuthority
      const taxBy = (auth: string) => docs.filter((d) => authOf(d) === auth).reduce((t, d) => t + sign(d) * Number(d.taxCents), 0)
      const wht = docs.reduce((t, d) => t + sign(d) * Number(d.whtCents), 0)
      expect(await sim.ledger.balanceOf(co, '1322', LAST), '1322 SRB input').toBe(taxBy('srb'))
      expect(await sim.ledger.balanceOf(co, '1320', LAST), '1320 FBR input').toBe(taxBy('fbr'))
      expect(taxBy('srb')).toBe(870_000 - 9_000)
      expect(taxBy('fbr')).toBe(295_200)
      expect(neg(await sim.ledger.balanceOf(co, '2040', LAST)), '2040 withholding kept').toBe(wht)
      expect(wht).toBe(key === 'A' ? 58_000 - 600 + 32_800 : 0)
      // 5060: the wasted share of the dearer chicken − the flour written off GRNI
      expect(await sim.ledger.balanceOf(co, '5060', LAST)).toBe(2_500 - 300_000)
    })
  }
})

// ─── Company separation ─────────────────────────────────────────────────────

describe('company separation — B never reaches A\'s purchasing', () => {
  it('B gets 404 on A\'s suppliers, POs, receipts, bills, credit notes, payments, GRNI lines and stock', async () => {
    const { A, B } = sim
    const a = S(A)
    const b = S(B)
    const finB = sim.as(B.finance, B)
    notFound('bill', await finB.get(`/procurement/bills/${a.bill1.id}`))
    notFound('bill match', await finB.get(`/procurement/bills/${a.bill1.id}/match`))
    notFound('void bill', await finB.post(`/procurement/bills/${a.bill2.id}/void`, { reason: 'cross-company try' }))
    notFound('credit note on A\'s bill', await finB.post(`/procurement/bills/${a.bill2.id}/credit-notes`, { number: 'X', date: '2026-10-31', reason: 'price', lines: [{ billLineId: a.bill1.lines[0]!.id, unitCostCents: 100 }] }))
    notFound('apply A\'s credit note', await finB.post(`/procurement/credit-notes/${a.cn1.id}/apply`, { applications: [{ billId: b.bill2.id, amountCents: 100 }] }))
    notFound('void A\'s payment', await finB.post(`/procurement/payments/${a.pay1}/void`, { reason: 'cross-company try' }))
    notFound('allocate A\'s payment', await finB.post(`/procurement/payments/${a.extraPay}/allocate`, { applications: [{ billId: b.bill2.id, amountAppliedCents: 100 }] }))
    notFound('pay A\'s supplier', await finB.post('/procurement/payments', { supplierId: a.unknown, paymentDate: '2026-10-31', method: 'bank_transfer', bankAccountId: B.banks.main.id, amountCents: 100 }))
    notFound('pay B\'s supplier against A\'s bill', await finB.post('/procurement/payments', { supplierId: b.unknown, paymentDate: '2026-10-31', method: 'bank_transfer', bankAccountId: B.banks.main.id, amountCents: 100, applications: [{ billId: a.bill2.id, amountAppliedCents: 100 }] }))
    notFound('bill A\'s supplier', await finB.post('/procurement/bills', { supplierId: a.meats, billNumber: 'X-1', billDate: '2026-10-31', lines: [{ expenseAccountCode: '6146', description: 'Cartage', quantity: 1, unitCostCents: 100 }] }))
    notFound('A\'s receipt files', await sim.as(b.store, B).get(`/record-files/goods_receipt/${a.receipt1.id}`))
    notFound('A\'s GRNI write-off', await finB.post(`/procurement/grni/${a.po0.receiptLineId}/write-off-request`, { reason: 'cross-company try' }))
    notFound('receive A\'s PO', await sim.as(b.store, B).post(`/procurement/purchase-orders/${a.po2.id}/receive`, { photos: [dockPhoto()], lines: [{ poLineId: a.po2.lineId, quantityReceived: 1 }] }))
    notFound('cancel A\'s PO', await sim.as(b.buyer, B).post(`/procurement/purchase-orders/${a.po2.id}/cancel`, { reason: 'cross-company try' }))
    notFound('A\'s supplier statement', await finB.get(`/procurement/suppliers/${a.meats}/statement`))
    notFound('A\'s item', await sim.as(b.store, B).get(`/inventory/${a.items.chicken}`))
    notFound('waste A\'s item', await sim.as(b.store, B).post(`/inventory/${a.items.chicken}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage' }))
    notFound('count A\'s item', await sim.as(b.store, B).post('/crosschecks/physical-counts', { kind: 'spot', lines: [{ inventoryItemId: a.items.boxes, physicalQty: 1, reason: 'cross-company try' }] }))
    // lists: B's ageing, GRNI, bills and payments carry only B
    const ag = ok(await finB.get('/procurement/ap-aging?asOf=2026-10-31'), 200)
    expect(ag.bySupplier.every((r: { tenantId: string }) => r.tenantId === B.tenantId)).toBe(true)
    const bills = ok(await finB.get('/procurement/bills?kind=all'), 200) as Array<{ supplier: { tenantId: string } }>
    expect(bills.length).toBeGreaterThan(0)
    expect(bills.every((x) => x.supplier.tenantId === B.tenantId)).toBe(true)
    const pays = ok(await finB.get('/procurement/payments'), 200) as Array<{ supplier: { tenantId: string } }>
    expect(pays.every((x) => x.supplier.tenantId === B.tenantId)).toBe(true)
    const grni = ok(await finB.get('/procurement/grni'), 200)
    expect(grni.pendingBillMatches.every((m: { tenantId: string }) => m.tenantId === B.tenantId)).toBe(true)
    const diffs = ok(await finB.get('/accounting/stock-differences?status=pending'), 200)
    expect(diffs.rows.every((r: { tenantId: string }) => r.tenantId === B.tenantId)).toBe(true)
    // nothing of A on B's books
    await sim.ledger.assertBalanced(B)
    const ids = [a.bill1.id, a.bill2.id, a.cn1.id, a.pay1, a.extraPay, a.receipt1.id, a.po0.receiptLineId!]
    const crossed = await sim.prisma.journalEntry.count({ where: { tenantId: B.tenantId, OR: ids.map((id) => ({ reference: { contains: id } })) } })
    expect(crossed).toBe(0)
  })
})

// ─── Known defects (open) ───────────────────────────────────────────────────

describe('known defects found by the simulation (open)', () => {
  // DEFECT P-1 (open): the F&B manager owns the Operations workspace, whose "Stock & buying"
  // section holds the 'procurement' module (lib/workspaces.ts: "Operations is the F&B manager's
  // (D2): menu, stock, till, kitchen, buying, floor"), yet DEFAULT_MODULE_ACCESS.fnb_manager
  // (lib/moduleAccess.ts) does not include 'procurement' — so the workspace owner gets 403
  // "Your account does not have access to this module (procurement)" on every supplier / PO
  // call (the sim had to use a 'procurement' buyer and a 'manager' at the dock). Fix: add
  // 'procurement' to fnb_manager's defaults and to MODULE_GRANTS (saved rows, once) — a
  // permissions change, left for the owner to confirm.
  it.fails('P-1: the F&B manager (Operations owner) can raise a purchase order', async () => {
    const co = sim.A
    const r = await sim.as(co.manager, co).post('/procurement/purchase-orders', {
      supplierId: S(co).meats, lines: [{ inventoryItemId: S(co).items.flour, quantityOrdered: 1, unitCostCents: 15_000 }],
    })
    expect(r.statusCode, r.body).toBe(201)
  })

  // DEFECT P-2 (open): finance records the bill against the dock receipt ("bill from receipt",
  // GET /procurement/grni/unbilled-lines is finance's) but cannot open the receipt's dock photos:
  // GET /record-files/goods_receipt/:id answers 403 "Your role cannot open the files of this goods
  // receipt" to finance (modules/recordFiles/providers.ts goods_receipt reads PROCUREMENT_TEAM only),
  // while supplier_bill files are open to finance. Owner, 2026-10-16: record files are "only staff
  // of that company can open them, View + Download". Expected: finance (AP_READERS, with
  // 'accounting') may view the receipt's photos — an access change, left for the owner to confirm.
  it.fails('P-2: finance can view the dock photos of the receipt it bills', async () => {
    const co = sim.A
    const r = await sim.as(co.finance, co).get(`/record-files/goods_receipt/${S(co).receipt1.id}`)
    expect(r.statusCode, r.body).toBe(200)
  })
})
