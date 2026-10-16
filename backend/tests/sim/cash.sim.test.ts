// The simulated month — CASH (finance readiness plan §4a step 5): petty cash,
// cash vouchers, operating costs, capital spending and fixed assets, for both
// companies (A 'GS Foods' — withholding ON; B 'GS x Viva' — withholding OFF),
// everything through the real API on the shared harness (tests/sim/harness.ts).
//
//   1 Oct   finance funds the books (manual journal: bank + safe / Cr 3010);
//           a petty-cash box opens with a PKR 20,000 float from the Garibsons
//           cashier (H1: Dr 1011 / Cr 2210), limit PKR 25,000; a six-month
//           insurance prepayment (OpEx 'prepaid': Dr 1310 / Cr bank);
//   2 Oct   a PKR 30,000 top-up from the bank — above the limit: no PIN 403,
//           a wrong PIN 403, the manager's PIN 201 (Dr 1011 / Cr bank, H2);
//           PKR 5,000 from the safe (Dr 1011 / Cr 1010); a CapEx project
//           (fryer, laptop, chiller, shelving, a security deposit);
//   3 Oct   box spends, each with an uploaded receipt (the photo rule): an
//           expense (Dr 6040), stock (FIFO receipt, Dr 1210), a supplier bill
//           paid in cash (AP cleared), a CapEx line (Dr 1340); the fryer's 40%
//           advance (Dr 1340 / Cr bank − WHT); the security deposit (Dr 1360);
//   5 Oct   the laptop and chiller paid; rent (OpEx) with SRB input tax and
//           withholding s.155 in A, and the invoice uploaded as a record FILE;
//   6 Oct   the box counted PKR 300 short (Dr 8010 / Cr 1011); finance
//           prepares the capitalisations (202), the CEO approves them;
//   7 Oct   PKR 10,000 returned from the box to the bank;
//   8–12    cash vouchers: A (request) paid from the box — ONE entry Dr 6040 /
//           Cr 1011, nothing on 1357; documents after pay book nothing,
//           finance checks them; B (finance's expense voucher, discount)
//           paid from the bank — 'cashvoucher.pay', finance cannot check its
//           own documents (SELF_APPROVE), the CEO does; C (a toaster) refused
//           at pay (USE_CAPEX) until finance overrides with notEquipment + a
//           reason (flagged); its holder never confirms → the payer cannot
//           confirm for them, the CEO records "received" on their behalf;
//   10 Oct  the fryer's balance (Dr 2012 / Cr bank − WHT);
//   25 Oct  the deposit returned 80% / 20% forfeited (Dr bank, Dr 6010 / Cr 1360);
//   28 Oct  the chiller sold (finance requests, the CEO approves): loss → 8030;
//   1 Nov   the depreciation worker (runForTenant) charges October and
//           releases the prepayment's first month; a second run posts nothing;
//           H42: the tax view gives the fryer the 25% initial allowance and the
//           laptop none until finance ticks it — the books do not move.
// Month end (per company, as at 31 Oct): books balanced, one net figure per TB
// row; 1011 = Σ box floats (and the tie-out route says ok); 1357 = 0, never
// touched, not listed; 1310 = the prepayment's schedule; 1340 = the advances
// list; 1360 = 0 (the deposit came back); 2012 = 0; 2010 = 0; the fixed-asset
// register ties to 15xx / 159x; no entry of one company's documents lands in
// the other's books; B gets 404 on A's vouchers, boxes, assets, files, CapEx.
//
// Runtime ≈ 1 minute. Requires a disposable database ("test" in DATABASE_URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  startSim, ok, errCode, pdfFile, SIM_PIN,
  type Sim, type SimCompany, type SimUser,
} from './harness.js'

let sim: Sim

type CoKey = 'A' | 'B'
interface CoState {
  boxId: string
  receipts: string[]
  movements: string[]
  itemId: string
  plumberId: string
  landlordId: string
  insurerId: string
  vendorId: string
  billId: string
  projectId: string
  lines: { fryer: string; laptop: string; chiller: string; shelving: string; deposit: string }
  payments: { fryerAdvance: string; fryerBalance: string; laptop: string; chiller: string; deposit: string }
  assets: { fryer: string; laptop: string; chiller: string }
  rentPaymentId: string
  insurancePaymentId: string
  vouchers: { a: string; b: string; c: string }
  docIds: string[] // every A/B document id whose entries must stay in its own company
}
const st: Record<CoKey, CoState> = {
  A: { lines: {}, payments: {}, assets: {}, vouchers: {}, receipts: [], movements: [], docIds: [] } as unknown as CoState,
  B: { lines: {}, payments: {}, assets: {}, vouchers: {}, receipts: [], movements: [], docIds: [] } as unknown as CoState,
}
const both = (): SimCompany[] => [sim.A, sim.B]
const V = '/trustops/cash-vouchers'
const FA = '/accounting/fixed-assets'

// ─── Ledger helpers ─────────────────────────────────────────────────────────

type Line = [string, 'debit' | 'credit', number]
async function linesOfEntry(entryId: string | null | undefined): Promise<Line[]> {
  if (!entryId) return []
  const je = await sim.prisma.journalEntry.findUniqueOrThrow({ where: { id: entryId }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je.lines.map((l) => [l.account.code, l.type as 'debit' | 'credit', Number(l.amountCents)] as Line).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`))
}
async function linesOfRef(co: SimCompany, reference: string): Promise<Line[]> {
  const je = await sim.prisma.journalEntry.findFirst({ where: { tenantId: co.tenantId, reference }, select: { id: true } })
  return je ? linesOfEntry(je.id) : []
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') => lines.filter((l) => l[0] === code && l[1] === type).reduce((t, l) => t + l[2], 0)
const entryCount = (co: SimCompany) => sim.prisma.journalEntry.count({ where: { tenantId: co.tenantId } })
const floatOf = async (co: SimCompany) => (await sim.prisma.pettyCashBox.findUniqueOrThrow({ where: { id: st[co.key].boxId } })).floatCents
const wht = (co: SimCompany, base: number, bps: number) => (co.key === 'A' ? Math.round((base * bps) / 10_000) : 0)

// The supplier master is the 'procurement' module's (fnb_manager does not hold it by default; finance only
// reads the picker): the CEO adds the vendors here.
async function addSupplier(co: SimCompany, name: string): Promise<string> {
  return ok(await sim.as(sim.ceo, co).post('/procurement/suppliers', { name, filerStatus: 'filer', tenantId: co.tenantId }), 201).id as string
}

async function receipt(co: SimCompany, who: SimUser): Promise<string> {
  const f = pdfFile('receipt.pdf')
  const r = ok(await sim.as(who, co).post('/trustops/petty-cash/receipts', { boxId: st[co.key].boxId, photo: f.dataBase64, mime: f.mime }), 201)
  st[co.key].receipts.push(r.id)
  return r.id as string
}

beforeAll(async () => {
  sim = await startSim()
}, 180_000)

afterAll(async () => {
  await sim?.close()
})

// ─── 1 Oct: funding, the box, the prepayment ────────────────────────────────

describe('1 Oct — funding, the petty-cash box, a six-month prepayment', () => {
  it('finance funds the bank and the safe from owner\'s capital (manual journal)', async () => {
    sim.clock.at('2026-10-01', '09:00')
    for (const co of both()) {
      const acct = async (code: string) => (await sim.prisma.account.findFirstOrThrow({ where: { tenantId: co.tenantId, code } })).id
      ok(await sim.as(co.finance, co).post('/accounting/journal', {
        description: 'Opening funding for the simulated month',
        lines: [
          { accountId: await acct(co.banks.main.code), type: 'debit', amountCents: 100_000_000 },
          { accountId: await acct('1010'), type: 'debit', amountCents: 10_000_000 },
          { accountId: await acct('3010'), type: 'credit', amountCents: 110_000_000 },
        ],
      }), 201)
      expect(await sim.ledger.balanceOf(co, co.banks.main.code)).toBe(100_000_000)
    }
  })

  it('a box opens with a PKR 20,000 float from the Garibsons cashier (H1: Dr 1011 / Cr 2210)', async () => {
    sim.clock.at('2026-10-01', '10:00')
    for (const co of both()) {
      const box = ok(await sim.as(co.finance, co).post('/trustops/petty-cash/boxes', {
        name: `${co.name} front box`, conceptId: co.brands.srb.id, custodianId: co.cashier.id,
        floatCents: 2_000_000, topUpLimitCents: 2_500_000, openingSource: 'garibsons',
      }), 201)
      st[co.key].boxId = box.id
      expect(box).toMatchObject({ tenantId: co.tenantId, floatCents: 2_000_000, topUpLimitCents: 2_500_000 })
      const m = await sim.prisma.pettyCashMovement.findFirstOrThrow({ where: { boxId: box.id } })
      expect(await linesOfEntry(m.journalEntryId)).toEqual([['1011', 'debit', 2_000_000], ['2210', 'credit', 2_000_000]])
      st[co.key].movements.push(m.id)
    }
  })

  it('insurance paid six months ahead (OpEx prepaid H25: Dr 1310 / Cr bank, no withholding)', async () => {
    sim.clock.at('2026-10-01', '11:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      st[co.key].insurerId = await addSupplier(co, `${co.key} Adamjee Insurance`)
      const cat = ok(await fin.post('/opex/categories', { name: 'Insurance', expenseAccountCode: '6100' }), 201)
      const line = ok(await fin.post('/opex/lines', {
        categoryId: cat.id, name: 'Outlet fire & theft cover', amountCents: 12_000_000, cadence: 'annual',
        bankAccountId: co.banks.main.id, supplierId: st[co.key].insurerId, whtSection: 'none',
      }), 201)
      const p = ok(await fin.post('/opex/payments', {
        lineId: line.id, periodStart: '2026-10-01', periodEnd: '2027-03-31', expectedCents: 12_000_000,
        invoiceCents: 12_000_000, paidAt: '2026-10-01', paymentRef: `IBFT-INS-${co.key}`,
        treatment: 'prepaid', coversFrom: '2026-10', coversMonths: 6,
      }), 201)
      st[co.key].insurancePaymentId = p.id
      st[co.key].docIds.push(p.id)
      expect(p).toMatchObject({ treatment: 'prepaid', coversFrom: '2026-10', coversMonths: 6, whtCents: 0 })
      expect(await linesOfRef(co, `opex.payment:${p.id}`)).toEqual([[co.banks.main.code, 'credit', 12_000_000], ['1310', 'debit', 12_000_000]].sort() as Line[])
    }
  })
})

// ─── 2 Oct: top-ups, the CapEx project ──────────────────────────────────────

describe('2 Oct — top-ups (H1 / H2) and the CapEx project', () => {
  it('above the limit a top-up needs the manager PIN of the box\'s company', async () => {
    sim.clock.at('2026-10-02', '09:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      const body = { boxId: st[co.key].boxId, type: 'topup', amountCents: 3_000_000, reason: 'Weekly top-up from the bank', source: 'bank', bankAccountId: co.banks.main.id }
      const none = await fin.post('/trustops/petty-cash/movements', body)
      expect(none.statusCode).toBe(403)
      expect(errCode(none)).toBe('TOPUP_OVER_LIMIT')
      const other = co.key === 'A' ? SIM_PIN.B : SIM_PIN.A // the OTHER company's manager PIN
      const wrong = await fin.post('/trustops/petty-cash/movements', { ...body, managerOverridePin: other })
      expect(wrong.statusCode).toBe(403)
      expect(errCode(wrong)).toBe('INVALID_MANAGER_PIN')
      expect(await floatOf(co)).toBe(2_000_000)
      const r = ok(await fin.post('/trustops/petty-cash/movements', { ...body, managerOverridePin: SIM_PIN[co.key] }), 201)
      expect(r.newFloatCents).toBe(5_000_000)
      expect(r.movement).toMatchObject({ approvedById: co.manager.id })
      expect(await linesOfEntry(r.movement.journalEntryId)).toEqual([['1011', 'debit', 3_000_000], [co.banks.main.code, 'credit', 3_000_000]].sort() as Line[])
      st[co.key].movements.push(r.movement.id)
      // Within the limit, from the safe (Dr 1011 / Cr 1010) — no PIN.
      const safe = ok(await fin.post('/trustops/petty-cash/movements', { boxId: st[co.key].boxId, type: 'topup', amountCents: 500_000, reason: 'Change from the safe', source: 'safe' }), 201)
      expect(await linesOfEntry(safe.movement.journalEntryId)).toEqual([['1010', 'credit', 500_000], ['1011', 'debit', 500_000]])
      // A top-up must say where the cash came from.
      expect(errCode(await fin.post('/trustops/petty-cash/movements', { boxId: st[co.key].boxId, type: 'topup', amountCents: 100, reason: 'x' }))).toBe('TOPUP_SOURCE_REQUIRED')
      st[co.key].movements.push(safe.movement.id)
      expect(await floatOf(co)).toBe(5_500_000)
    }
  })

  it('a CapEx project with its lines, vendors from the supplier master', async () => {
    sim.clock.at('2026-10-02', '11:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      st[co.key].vendorId = await addSupplier(co, `${co.key} Kitchen Kraft`)
      st[co.key].landlordId = await addSupplier(co, `${co.key} Clifton Estates`)
      const p = ok(await fin.post('/finance/capex', {
        name: `${co.name} Clifton kitchen upgrade`, conceptId: co.brands.srb.id, locationId: co.locationId,
        projectType: 'refurb', budgetEnvelopeCents: 100_000_000,
      }), 201)
      st[co.key].projectId = p.id
      const line = async (body: Record<string, unknown>) => ok(await fin.post(`/finance/capex/${p.id}/lines`, body), 201).id as string
      st[co.key].lines = {
        fryer: await line({ scope: 'Equipment', item: 'Twin-basket fryer', unitCostCents: 30_000_000, supplierId: st[co.key].vendorId, whtSection: '153_1_a' }),
        laptop: await line({ scope: 'IT', item: 'Office laptop', unitCostCents: 18_000_000, supplierId: st[co.key].vendorId, whtSection: '153_1_a' }),
        chiller: await line({ scope: 'Equipment', item: 'Display chiller', unitCostCents: 12_000_000, supplierId: st[co.key].vendorId, whtSection: '153_1_a' }),
        shelving: await line({ scope: 'Equipment', item: 'Dry store shelving', unitCostCents: 800_000 }),
        deposit: await line({ scope: 'SoftCosts', item: 'Security deposit — dry store lease', unitCostCents: 5_000_000, supplierId: st[co.key].landlordId, treatment: 'deposit' }),
      }
    }
  })
})

// ─── 3 Oct: box spends, the advance, the deposit ────────────────────────────

describe('3 Oct — box spends (expense, stock, a supplier bill, CapEx) and CapEx payments', () => {
  it('an expense needs an uploaded receipt (a URL never counts); booked Dr 6040 / Cr 1011', async () => {
    sim.clock.at('2026-10-03', '10:00')
    for (const co of both()) {
      const cash = sim.as(co.cashier, co)
      const body = { boxId: st[co.key].boxId, type: 'spend', amountCents: 120_000, reason: 'Floor cleaner and mops', categoryKey: 'cleaning' }
      const noPhoto = await cash.post('/trustops/petty-cash/movements', { ...body, receiptUrl: 'https://example.com/receipt.jpg' })
      expect(noPhoto.statusCode).toBe(400)
      expect(errCode(noPhoto)).toBe('PHOTO_REQUIRED')
      const r = ok(await cash.post('/trustops/petty-cash/movements', { ...body, receiptIds: [await receipt(co, co.cashier)] }), 201)
      expect(await linesOfEntry(r.movement.journalEntryId)).toEqual([['1011', 'credit', 120_000], ['6040', 'debit', 120_000]])
      st[co.key].movements.push(r.movement.id)
    }
  })

  it('stock bought with box cash: a settled FIFO receipt, Dr 1210 / Cr 1011', async () => {
    sim.clock.at('2026-10-03', '10:30')
    for (const co of both()) {
      st[co.key].itemId = ok(await sim.as(co.manager, co).post('/inventory', { name: 'Tomatoes', unit: 'kg', category: 'produce' }), 201).id
      const r = ok(await sim.as(co.finance, co).post('/trustops/petty-cash/movements', {
        boxId: st[co.key].boxId, type: 'spend', amountCents: 200_000, reason: 'Market run',
        lines: [{ kind: 'stock', inventoryItemId: st[co.key].itemId, quantity: 4, unit: 'kg', amountCents: 200_000, description: 'Tomatoes' }],
        receiptIds: [await receipt(co, co.finance)],
      }), 201)
      expect(await linesOfEntry(r.movement.journalEntryId)).toEqual([['1011', 'credit', 200_000], ['1210', 'debit', 200_000]])
      const gr = await sim.prisma.goodsReceipt.findFirstOrThrow({ where: { settledById: r.movement.id } })
      expect(gr).toMatchObject({ tenantId: co.tenantId, settledAccountCode: '1011' })
      expect((await sim.prisma.inventoryItem.findUniqueOrThrow({ where: { id: st[co.key].itemId } })).currentStock).toBe(4)
      st[co.key].movements.push(r.movement.id)
    }
  })

  it('a supplier bill (finance books it: Dr 6050 / Cr 2010, WHT in A) paid in cash from the box clears AP', async () => {
    sim.clock.at('2026-10-03', '11:00')
    for (const co of both()) {
      st[co.key].plumberId = await addSupplier(co, `${co.key} Karachi Plumbing Works`)
      const bill = ok(await sim.as(co.finance, co).post('/procurement/bills', {
        supplierId: st[co.key].plumberId, billNumber: `PL-${co.key}-101`, billDate: '2026-10-03', whtSection: '153_1_b',
        lines: [{ expenseAccountCode: '6050', description: 'Plumbing repair — kitchen sink', quantity: 1, unitCostCents: 500_000 }],
      }), 201)
      st[co.key].billId = bill.id
      st[co.key].docIds.push(bill.id)
      const whtCents = Number(bill.whtCents)
      expect(whtCents).toBe(wht(co, 500_000, 1100))
      const due = 500_000 - whtCents
      const r = ok(await sim.as(co.cashier, co).post('/trustops/petty-cash/movements', {
        boxId: st[co.key].boxId, type: 'spend', amountCents: due, reason: 'Plumber paid in cash', supplierBillId: bill.id,
        receiptIds: [await receipt(co, co.cashier)],
      }), 201)
      st[co.key].movements.push(r.movement.id)
      const b = await sim.prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })
      expect(b.status).toBe('paid')
      expect(await sim.ledger.balanceOf(co, '2010')).toBe(0)
    }
  })

  it('a CapEx line paid from the box: Dr 1340 / Cr 1011 (its own capex.payment entry)', async () => {
    sim.clock.at('2026-10-03', '11:30')
    for (const co of both()) {
      const r = ok(await sim.as(co.finance, co).post('/trustops/petty-cash/movements', {
        boxId: st[co.key].boxId, type: 'spend', amountCents: 800_000, reason: 'Dry store shelving',
        lines: [{ kind: 'capex', capexLineId: st[co.key].lines.shelving, amountCents: 800_000, description: 'Dry store shelving' }],
        receiptIds: [await receipt(co, co.finance)],
      }), 201)
      const line = await sim.prisma.pettyCashSpendLine.findFirstOrThrow({ where: { movementId: r.movement.id, kind: 'capex' } })
      expect(await linesOfRef(co, `capex.payment:${line.capexPaymentId}`)).toEqual([['1011', 'credit', 800_000], ['1340', 'debit', 800_000]])
      st[co.key].movements.push(r.movement.id)
      st[co.key].docIds.push(line.capexPaymentId!)
      // 5,500 − 1,200 − 2,000 − the bill − 8,000
      const billDue = 500_000 - wht(co, 500_000, 1100)
      expect(await floatOf(co)).toBe(5_500_000 - 120_000 - 200_000 - billDue - 800_000)
    }
  })

  it('the fryer\'s 40% advance (Dr 1340 / Cr bank − WHT 2040) and the security deposit (Dr 1360, no WHT)', async () => {
    sim.clock.at('2026-10-03', '14:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      const adv = ok(await fin.post(`/finance/capex/lines/${st[co.key].lines.fryer}/payments`, {
        label: 'deposit', amountCents: 12_000_000, paidAt: '2026-10-03', paymentRef: `IBFT-FRY-${co.key}`, bankAccountId: co.banks.main.id,
      }), 201)
      st[co.key].payments.fryerAdvance = adv.id
      st[co.key].docIds.push(adv.id)
      const w = wht(co, 12_000_000, 100)
      expect(await linesOfRef(co, `capex.payment:${adv.id}`)).toEqual([
        ['1340', 'debit', 12_000_000], [co.banks.main.code, 'credit', 12_000_000 - w], ...(w ? [['2040', 'credit', w]] : []),
      ].sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)) as Line[])
      const dep = ok(await fin.post(`/finance/capex/lines/${st[co.key].lines.deposit}/payments`, {
        label: 'deposit', amountCents: 5_000_000, paidAt: '2026-10-03', paymentRef: `IBFT-DEP-${co.key}`, bankAccountId: co.banks.main.id,
      }), 201)
      st[co.key].payments.deposit = dep.id
      st[co.key].docIds.push(dep.id)
      expect(await linesOfRef(co, `capex.payment:${dep.id}`)).toEqual([[co.banks.main.code, 'credit', 5_000_000], ['1360', 'debit', 5_000_000]].sort() as Line[])
    }
  })
})

// ─── 5 Oct: laptop + chiller paid; rent with SRB input tax + WHT + a file ───

describe('5 Oct — equipment paid; rent with SRB input tax, withholding and a receipt FILE', () => {
  it('the laptop and the chiller are paid in full before delivery (advances on 1340)', async () => {
    sim.clock.at('2026-10-05', '10:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      for (const [k, cents] of [['laptop', 18_000_000], ['chiller', 12_000_000]] as const) {
        const p = ok(await fin.post(`/finance/capex/lines/${st[co.key].lines[k]}/payments`, {
          label: 'balance', amountCents: cents, paidAt: '2026-10-05', paymentRef: `IBFT-${k}-${co.key}`, bankAccountId: co.banks.main.id,
        }), 201)
        st[co.key].payments[k] = p.id
        st[co.key].docIds.push(p.id)
        const lines = await linesOfRef(co, `capex.payment:${p.id}`)
        expect(amt(lines, '1340', 'debit')).toBe(cents)
        expect(amt(lines, '2040', 'credit')).toBe(wht(co, cents, 100))
      }
      for (const k of ['fryer', 'laptop', 'chiller'] as const) {
        ok(await fin.patch(`/finance/capex/lines/${st[co.key].lines[k]}`, { status: 'delivered', actualDeliveryDate: '2026-10-05' }), 200)
      }
    }
  })

  it('rent: Dr 6010 (invoice − tax) + Dr 1322 SRB input / Cr 2040 WHT 15% (A only) / Cr bank; the invoice is a FILE', async () => {
    sim.clock.at('2026-10-05', '12:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      const cat = ok(await fin.post('/opex/categories', { name: 'Rent', expenseAccountCode: '6010' }), 201)
      const line = ok(await fin.post('/opex/lines', {
        categoryId: cat.id, conceptId: co.brands.srb.id, name: 'Clifton outlet rent', amountCents: 23_000_000, cadence: 'monthly',
        bankAccountId: co.banks.main.id, supplierId: st[co.key].landlordId, whtSection: '155', inputTaxAuthority: 'srb',
      }), 201)
      const p = ok(await fin.post('/opex/payments', {
        lineId: line.id, periodStart: '2026-10-01', periodEnd: '2026-10-31', expectedCents: 20_000_000,
        invoiceCents: 23_000_000, inputTaxCents: 3_000_000, inputTaxAuthority: 'srb', whtSection: '155',
        paidAt: '2026-10-05', paymentRef: `IBFT-RENT-OCT-${co.key}`,
      }), 201)
      st[co.key].rentPaymentId = p.id
      st[co.key].docIds.push(p.id)
      const w = wht(co, 20_000_000, 1500)
      expect(p).toMatchObject({ whtCents: w, actualCents: 23_000_000 - w })
      const lines = await linesOfRef(co, `opex.payment:${p.id}`)
      expect(amt(lines, '6010', 'debit')).toBe(20_000_000)
      expect(amt(lines, '1322', 'debit')).toBe(3_000_000)
      expect(amt(lines, '2040', 'credit')).toBe(w)
      expect(amt(lines, co.banks.main.code, 'credit')).toBe(23_000_000 - w)
      // The landlord's invoice is an uploaded file on the payment (no URL field).
      const files = ok(await fin.post(`/record-files/opex_payment/${p.id}`, { files: [pdfFile('rent-oct.pdf')] }), 201)
      expect(JSON.stringify(files)).toContain('rent-oct.pdf')
      const list = ok(await fin.get(`/record-files/opex_payment/${p.id}`), 200)
      expect(list.files).toHaveLength(1)
      expect((await fin.get(`/record-files/opex_payment/${p.id}/${list.files[0].id}`)).statusCode).toBe(200)
    }
  })
})

// ─── 6–7 Oct: the count, the capitalisations, cash back to the bank ─────────

describe('6–7 Oct — a count 300 short, capitalisation (CEO approves), cash returned to the bank', () => {
  it('a count PKR 300 short: Dr 8010 / Cr 1011, the float becomes the count', async () => {
    sim.clock.at('2026-10-06', '09:00')
    for (const co of both()) {
      const f = await floatOf(co)
      const r = ok(await sim.as(co.manager, co).post(`/trustops/petty-cash/boxes/${st[co.key].boxId}/reconcile`, { countedCents: f - 30_000, notes: 'Monday count' }), 200)
      expect(r.varianceCents).toBe(-30_000)
      expect(await linesOfEntry(r.movement.journalEntryId)).toEqual([['1011', 'credit', 30_000], ['8010', 'debit', 30_000]])
      expect(await floatOf(co)).toBe(f - 30_000)
      st[co.key].movements.push(r.movement.id)
    }
  })

  it('finance prepares each capitalisation (202 pending); the CEO approves it: Dr 15xx / Cr 1340 (/ Cr 2012 still owed)', async () => {
    sim.clock.at('2026-10-06', '11:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      const ceo = sim.as(sim.ceo, co)
      for (const [k, classKey] of [['fryer', 'kitchen_equipment'], ['laptop', 'it_equipment'], ['chiller', 'kitchen_equipment']] as const) {
        const lineId = st[co.key].lines[k]
        const prep = await fin.post(`/finance/capex/lines/${lineId}/capitalise`, { classKey, inServiceAt: '2026-10-05' })
        expect(prep.statusCode, prep.body).toBe(202)
        expect(errCode(await fin.post(`/finance/capex/lines/${lineId}/capitalise`, { classKey }))).toBe('CAPITALISATION_PENDING')
        // Finance cannot approve its own preparation.
        expect((await fin.post(`${FA}/requests/${prep.json().eventId}/approve`, {})).statusCode).toBe(403)
        const ap = ok(await ceo.post(`${FA}/requests/${prep.json().eventId}/approve`, {}), 200)
        expect(ap.status).toBe('posted')
        const asset = await sim.prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: lineId } })
        expect(asset).toMatchObject({ tenantId: co.tenantId, category: classKey })
        st[co.key].assets[k] = asset.id
        st[co.key].docIds.push(asset.id)
        const je = await linesOfEntry(ap.event.journalEntryId)
        const cost = k === 'fryer' ? 30_000_000 : k === 'laptop' ? 18_000_000 : 12_000_000
        const code = classKey === 'it_equipment' ? '1530' : '1510'
        expect(amt(je, code, 'debit')).toBe(cost)
        const advanced = k === 'fryer' ? 12_000_000 : cost
        expect(amt(je, '1340', 'credit')).toBe(advanced)
        expect(amt(je, '2012', 'credit')).toBe(cost - advanced)
      }
    }
  })

  it('PKR 10,000 returned from the box to the bank: Dr bank / Cr 1011', async () => {
    sim.clock.at('2026-10-07', '10:00')
    for (const co of both()) {
      const f = await floatOf(co)
      const r = ok(await sim.as(co.finance, co).post('/trustops/petty-cash/returns', {
        boxId: st[co.key].boxId, amountCents: 1_000_000, destination: 'bank', bankAccountId: co.banks.main.id, reason: 'Float above need — banked',
      }), 201)
      expect(r.newFloatCents).toBe(f - 1_000_000)
      expect(await linesOfEntry(r.movement.journalEntryId)).toEqual([['1011', 'credit', 1_000_000], [co.banks.main.code, 'debit', 1_000_000]].sort() as Line[])
      st[co.key].movements.push(r.movement.id)
    }
  })
})

// ─── 8–12 Oct: cash vouchers ────────────────────────────────────────────────

describe('8–12 Oct — cash vouchers: ONE entry at pay, documents book nothing, 1357 never moves', () => {
  it('voucher A (request): finance → CEO → paid from the box — Dr 6040 / Cr 1011, nothing on 1357', async () => {
    sim.clock.at('2026-10-08', '10:00')
    for (const co of both()) {
      const raiser = sim.as(co.cashier2, co)
      const v = ok(await raiser.post(V, { purpose: 'Floor cleaning chemicals for the week', categoryKey: 'cleaning', amountCents: 150_000 }), 201)
      st[co.key].vouchers.a = v.id
      st[co.key].docIds.push(v.id)
      expect(v.status).toBe('submitted')
      ok(await sim.as(co.finance, co).post(`${V}/${v.id}/finance-approve`, {}), 200)
      ok(await sim.as(sim.ceo, co).post(`${V}/${v.id}/approve`, {}), 200)
      // Only finance pays.
      expect(errCode(await sim.as(co.manager, co).post(`${V}/${v.id}/pay`, { boxId: st[co.key].boxId }))).toBe('PAY_FINANCE_ONLY')
      const f = await floatOf(co)
      const pay = ok(await sim.as(co.finance, co).post(`${V}/${v.id}/pay`, { source: 'box', boxId: st[co.key].boxId }), 200)
      expect(pay.newFloatCents).toBe(f - 150_000)
      expect(await linesOfEntry(pay.journalEntryId)).toEqual([['1011', 'credit', 150_000], ['6040', 'debit', 150_000]])
      expect(await sim.prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: 'disbursed', bookedAtPay: true })
      st[co.key].movements.push(pay.movement.id)
    }
  })

  it('voucher A: the holder confirms, uploads the bill after pay (books nothing), finance checks it → posted', async () => {
    sim.clock.at('2026-10-09', '10:00')
    for (const co of both()) {
      const id = st[co.key].vouchers.a
      const before = await entryCount(co)
      // Finance cannot check before the holder confirms receiving the cash.
      expect(errCode(await sim.as(co.finance, co).post(`${V}/${id}/verify-docs`, {}))).toBe('CASH_RECEIPT_NOT_CONFIRMED')
      ok(await sim.as(co.cashier2, co).post(`${V}/${id}/confirm-received`, {}), 200)
      expect(errCode(await sim.as(co.finance, co).post(`${V}/${id}/verify-docs`, {}))).toBe('DOCS_REQUIRED')
      ok(await sim.as(co.cashier2, co).post(`${V}/${id}/documents`, pdfFile('chemicals-bill.pdf')), 201)
      expect(await entryCount(co)).toBe(before)
      // Lines / change after a one-entry pay are refused.
      expect(errCode(await sim.as(co.finance, co).post(`${V}/${id}/verify-docs`, { changeCents: 1_000 }))).toBe('EXPENSE_BOOKED_AT_PAY')
      const ver = ok(await sim.as(co.finance, co).post(`${V}/${id}/verify-docs`, {}), 200)
      expect(JSON.stringify(ver)).toContain('posted')
      expect(await sim.prisma.cashVoucher.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'posted', settledCents: 150_000 })
      expect(await entryCount(co)).toBe(before)
    }
  })

  it('voucher B (finance\'s expense voucher, discount): straight to the CEO, paid from the bank — cashvoucher.pay Dr 6050 / Cr bank', async () => {
    sim.clock.at('2026-10-10', '10:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      // A discount is finance's only.
      expect(errCode(await sim.as(co.manager, co).post(V, { purpose: 'x', categoryKey: 'repairs', grossCents: 1_000, discountCents: 100 }))).toBe('DISCOUNT_FINANCE_ONLY')
      const v = ok(await fin.post(V, {
        kind: 'expense', payeeName: 'Ali Electric Works', purpose: 'Rewiring of the dry store lights',
        categoryKey: 'repairs', grossCents: 2_500_000, discountCents: 100_000,
      }), 201)
      st[co.key].vouchers.b = v.id
      st[co.key].docIds.push(v.id)
      expect(v).toMatchObject({ status: 'finance_approved', amountCents: 2_400_000 })
      ok(await sim.as(sim.ceo, co).post(`${V}/${v.id}/approve`, {}), 200)
      const bankBefore = await sim.ledger.balanceOf(co, co.banks.main.code)
      const pay = ok(await fin.post(`${V}/${v.id}/pay`, { source: 'bank', bankAccountId: co.banks.main.id }), 200)
      expect(await linesOfRef(co, `cashvoucher.pay:${v.id}`)).toEqual([['6050', 'debit', 2_400_000], [co.banks.main.code, 'credit', 2_400_000]].sort() as Line[])
      expect(pay.journalEntryId).toBeTruthy()
      expect(await sim.ledger.balanceOf(co, co.banks.main.code)).toBe(bankBefore - 2_400_000)
      // Documents after pay; finance raised it, so the CEO checks them.
      ok(await fin.post(`${V}/${v.id}/documents`, pdfFile('ali-electric-invoice.pdf')), 201)
      const self = await fin.post(`${V}/${v.id}/verify-docs`, {})
      expect(self.statusCode).toBe(409)
      expect(errCode(self)).toBe('SELF_APPROVE')
      const before = await entryCount(co)
      ok(await sim.as(sim.ceo, co).post(`${V}/${v.id}/verify-docs`, {}), 200)
      expect(await entryCount(co)).toBe(before)
      expect((await sim.prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('posted')
    }
  })

  it('voucher C (a toaster): USE_CAPEX at pay until finance says it is not equipment, with a reason (flagged)', async () => {
    sim.clock.at('2026-10-11', '10:00')
    for (const co of both()) {
      const v = ok(await sim.as(co.cashier, co).post(V, { purpose: 'Toaster for the front counter', categoryKey: 'misc', amountCents: 450_000 }), 201)
      st[co.key].vouchers.c = v.id
      st[co.key].docIds.push(v.id)
      ok(await sim.as(co.finance, co).post(`${V}/${v.id}/finance-approve`, {}), 200)
      ok(await sim.as(sim.ceo, co).post(`${V}/${v.id}/approve`, {}), 200)
      const f = await floatOf(co)
      const before = await entryCount(co)
      const fin = sim.as(co.finance, co)
      const refused = await fin.post(`${V}/${v.id}/pay`, { boxId: st[co.key].boxId })
      expect(refused.statusCode).toBe(422)
      expect(errCode(refused)).toBe('USE_CAPEX')
      expect(errCode(await fin.post(`${V}/${v.id}/pay`, { boxId: st[co.key].boxId, notEquipment: true, notEquipmentReason: 'hire' }))).toBe('OVERRIDE_REASON_REQUIRED')
      expect(await floatOf(co)).toBe(f)
      expect(await entryCount(co)).toBe(before)
      expect((await sim.prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('approved')
      const pay = ok(await fin.post(`${V}/${v.id}/pay`, {
        boxId: st[co.key].boxId, notEquipment: true, notEquipmentReason: 'Hired for the food festival weekend, returned to the vendor after',
      }), 200)
      expect(await linesOfEntry(pay.journalEntryId)).toEqual([['1011', 'credit', 450_000], ['6190', 'debit', 450_000]])
      st[co.key].movements.push(pay.movement.id)
      expect((await sim.ledger.openFlags(co, 'equipment_override')).some((x) => x.title.includes('Toaster') || JSON.stringify(x.metadata).includes('Toaster'))).toBe(true)
    }
  })

  it('voucher C: the holder never confirms — not the payer, not the holder; the CEO records "received" on their behalf', async () => {
    sim.clock.at('2026-10-12', '10:00')
    for (const co of both()) {
      const id = st[co.key].vouchers.c
      const reason = { reason: 'Cashier on leave for two weeks, receipt seen by finance' }
      const payer = await sim.as(co.finance, co).post(`${V}/${id}/confirm-received-on-behalf`, reason)
      expect(payer.statusCode).toBe(409)
      expect(errCode(payer)).toBe('PAYER_CANNOT_CONFIRM')
      expect(errCode(await sim.as(co.cashier, co).post(`${V}/${id}/confirm-received-on-behalf`, reason))).toBe('NOT_FINANCE')
      expect((await sim.as(sim.ceo, co).post(`${V}/${id}/confirm-received-on-behalf`, { reason: 'short' })).statusCode).toBe(400)
      ok(await sim.as(sim.ceo, co).post(`${V}/${id}/confirm-received-on-behalf`, reason), 200)
      const row = await sim.prisma.cashVoucher.findUniqueOrThrow({ where: { id } })
      expect(row.cashReceivedById).toBe(sim.ceo.id)
      const before = await entryCount(co)
      ok(await sim.as(co.finance, co).post(`${V}/${id}/documents`, pdfFile('toaster-hire.pdf')), 201)
      ok(await sim.as(co.finance, co).post(`${V}/${id}/verify-docs`, {}), 200)
      expect(await entryCount(co)).toBe(before)
      // ONE entry at pay: nothing ever touched 1357.
      const lines1357 = await sim.prisma.journalLine.count({ where: { account: { tenantId: co.tenantId, code: '1357' } } })
      expect(lines1357).toBe(0)
    }
  })
})

// ─── 10 Oct → 28 Oct: balance, deposit return, a sale ───────────────────────

describe('later in October — the fryer\'s balance, the deposit returned 80/20, the chiller sold', () => {
  it('the fryer\'s balance clears 2012 (Dr 2012 / Cr bank − WHT)', async () => {
    sim.clock.at('2026-10-13', '10:00')
    for (const co of both()) {
      const p = ok(await sim.as(co.finance, co).post(`/finance/capex/lines/${st[co.key].lines.fryer}/payments`, {
        label: 'balance', amountCents: 18_000_000, paidAt: '2026-10-13', paymentRef: `IBFT-FRY2-${co.key}`, bankAccountId: co.banks.main.id,
      }), 201)
      st[co.key].payments.fryerBalance = p.id
      st[co.key].docIds.push(p.id)
      const lines = await linesOfRef(co, `capex.payment:${p.id}`)
      const w = wht(co, 18_000_000, 100)
      expect(amt(lines, '2012', 'debit')).toBe(18_000_000)
      expect(amt(lines, '2040', 'credit')).toBe(w)
      expect(amt(lines, co.banks.main.code, 'credit')).toBe(18_000_000 - w)
      expect(await sim.ledger.balanceOf(co, '2012')).toBe(0)
    }
  })

  it('the security deposit comes back 80%, 20% kept for damage (Dr bank 80% + Dr 6010 20% / Cr 1360)', async () => {
    sim.clock.at('2026-10-25', '10:00')
    for (const co of both()) {
      const url = `/finance/capex/payments/${st[co.key].payments.deposit}/deposit-return`
      const body = { returnedCents: 4_000_000, forfeitedCents: 1_000_000, reason: 'Wall damage at hand-back', receivedAt: '2026-10-25', method: 'bank_transfer', bankAccountId: co.banks.main.id }
      expect(errCode(await sim.as(co.finance, co).post(url, body))).toBe('PAYMENT_REFERENCE_REQUIRED')
      ok(await sim.as(co.finance, co).post(url, { ...body, reference: `IBFT-DEPRET-${co.key}` }), 201)
      expect(await linesOfRef(co, `capex.deposit_return:${st[co.key].payments.deposit}`)).toEqual([
        [co.banks.main.code, 'debit', 4_000_000], ['1360', 'credit', 5_000_000], ['6010', 'debit', 1_000_000],
      ].sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)) as Line[])
      const e1360 = await sim.prisma.journalLine.findMany({ where: { account: { tenantId: co.tenantId, code: '1360' } }, include: { journalEntry: { select: { reference: true } } } })
      expect(await sim.ledger.balanceOf(co, '1360'), JSON.stringify(e1360.map((l) => [l.journalEntry.reference, l.type, Number(l.amountCents)]))).toBe(0)
    }
  })

  it('the chiller is sold (finance requests, the CEO approves): Dr bank proceeds + Dr 8030 loss / Cr 1510', async () => {
    sim.clock.at('2026-10-28', '10:00')
    for (const co of both()) {
      const id = st[co.key].assets.chiller
      const r = await sim.as(co.finance, co).post(`${FA}/${id}/dispose`, {
        disposedAt: '2026-10-28', kind: 'sale', proceedsCents: 9_000_000, method: 'bank_transfer', reference: `IBFT-CHILLER-${co.key}`,
        bankAccountId: co.banks.main.id, reason: 'Replaced by the walk-in, sold to a caterer',
      })
      expect(r.statusCode, r.body).toBe(202)
      const evId = r.json().event?.id
      expect(evId).toBeTruthy()
      const ap = ok(await sim.as(sim.ceo, co).post(`${FA}/requests/${evId}/approve`, {}), 200)
      const je = await linesOfEntry(ap.event.journalEntryId)
      expect(amt(je, co.banks.main.code, 'debit')).toBe(9_000_000)
      expect(amt(je, '1510', 'credit')).toBe(12_000_000)
      expect(amt(je, '8030', 'debit')).toBe(3_000_000)
      expect(await sim.prisma.fixedAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'disposed', disposalProceedsCents: 9_000_000 })
    }
  })
})

// ─── 1 Nov: depreciation + prepaid release; H42 ─────────────────────────────

describe('1 Nov — the depreciation worker charges October and releases the prepayment; H42 tax view', () => {
  it('runForTenant: depreciation of the fryer + laptop (not the sold chiller), one month of insurance released; twice posts once', async () => {
    sim.clock.at('2026-11-01', '03:20')
    const { runForTenant } = await import('../../src/workers/depreciation.js')
    for (const co of both()) {
      await runForTenant(co.tenantId, sim.clock.now())
      const dep6150 = await sim.ledger.balanceOf(co, '6150', '2026-10-31')
      expect(dep6150).toBeGreaterThan(0)
      expect(dep6150).toBe(-(await sim.ledger.balanceOf(co, '1591', '2026-10-31')) - (await sim.ledger.balanceOf(co, '1593', '2026-10-31')))
      // Full-month convention: October is charged for the fryer (60 months) and the laptop (36); the chiller,
      // disposed in October, is never charged for its disposal month.
      const charges = async (k: 'fryer' | 'laptop' | 'chiller') => (await sim.prisma.fixedAssetDepreciation.findMany({
        where: { assetId: st[co.key].assets[k], reversedAt: null }, select: { period: true, amountCents: true },
      })).map((d) => [d.period, Number(d.amountCents)])
      expect(await charges('fryer')).toEqual([['2026-10', 500_000]])
      expect(await charges('laptop')).toEqual([['2026-10', 500_000]])
      expect(await charges('chiller')).toEqual([])
      expect(dep6150).toBe(1_000_000)
      expect(await sim.ledger.balanceOf(co, '1310', '2026-10-31')).toBe(10_000_000)
      expect(await sim.ledger.balanceOf(co, '6100', '2026-10-31')).toBe(2_000_000)
      const rel = await sim.prisma.prepaidRelease.findMany({ where: { tenantId: co.tenantId, sourceId: st[co.key].insurancePaymentId } })
      expect(rel.map((r) => [r.period, Number(r.amountCents)])).toEqual([['2026-10', 2_000_000]])
      const n = await entryCount(co)
      await runForTenant(co.tenantId, sim.clock.now())
      expect(await entryCount(co)).toBe(n)
    }
  })

  it('H42: the fryer (kitchen) gets the 25% initial allowance, the laptop (IT) none until finance ticks it — tax view only', async () => {
    sim.clock.at('2026-11-01', '10:00')
    for (const co of both()) {
      const fin = sim.as(co.finance, co)
      const rowOf = async (assetId: string) => ((ok(await fin.get(`${FA}/reports/tax`), 200)).rows as Array<Record<string, number | string>>).find((r) => r.assetId === assetId)
      expect(await rowOf(st[co.key].assets.fryer)).toMatchObject({ initialAllowanceBp: 2500, initialAllowanceCents: 7_500_000 })
      expect(await rowOf(st[co.key].assets.laptop)).toMatchObject({ initialAllowanceBp: 0, initialAllowanceCents: 0 })
      const before = await entryCount(co)
      const b1530 = await sim.ledger.balanceOf(co, '1530')
      // The manager cannot tick it; finance can.
      expect((await sim.as(co.manager, co).put(`${FA}/${st[co.key].assets.laptop}/initial-allowance`, { eligible: true })).statusCode).toBe(403)
      const r = ok(await fin.put(`${FA}/${st[co.key].assets.laptop}/initial-allowance`, { eligible: true, reason: 'CA confirmed eligible' }), 200)
      expect(r).toMatchObject({ initialAllowanceEligible: true, changed: true })
      expect(await rowOf(st[co.key].assets.laptop)).toMatchObject({ initialAllowanceBp: 2500, initialAllowanceCents: 4_500_000 })
      expect(await entryCount(co)).toBe(before)
      expect(await sim.ledger.balanceOf(co, '1530')).toBe(b1530)
    }
  })
})

// ─── Month end ──────────────────────────────────────────────────────────────

describe('month end (as at 31 Oct) — the cash and asset accounts tie out', () => {
  const ASOF = '2026-10-31'

  it('books balanced; TB one net figure per account, no zero rows, debits = credits', async () => {
    for (const co of both()) {
      await sim.ledger.assertBalanced(co)
      const tb = await sim.ledger.trialBalance(co, ASOF)
      expect(tb.debitCents).toBe(tb.creditCents)
      for (const r of tb.rows) {
        expect(Number(r.debitCents) > 0 && Number(r.creditCents) > 0, `${r.code} on both sides`).toBe(false)
        expect(Number(r.debitCents) + Number(r.creditCents), `${r.code} listed at zero`).toBeGreaterThan(0)
      }
    }
  })

  it('1011 = Σ box floats (and the petty-cash tie-out route says ok); every movement is on the books', async () => {
    for (const co of both()) {
      const boxes = await sim.prisma.pettyCashBox.findMany({ where: { tenantId: co.tenantId } })
      const floats = boxes.reduce((s, b) => s + b.floatCents, 0)
      expect(await sim.ledger.balanceOf(co, '1011', ASOF)).toBe(floats)
      const billDue = 500_000 - wht(co, 500_000, 1100)
      // 20,000 + 30,000 + 5,000 − 1,200 − 2,000 − bill − 8,000 − 300 − 10,000 − 1,500 (A) − 4,500 (C)
      expect(floats).toBe(5_500_000 - 120_000 - 200_000 - billDue - 800_000 - 30_000 - 1_000_000 - 150_000 - 450_000)
      const tie = ok(await sim.as(co.finance, co).get('/trustops/petty-cash/tie-out'), 200)
      const row = tie.companies.find((c: { tenantId: string }) => c.tenantId === co.tenantId)
      expect(row, JSON.stringify(tie)).toMatchObject({ ok: true, unbookedMovements: 0 })
      expect(await sim.ledger.balanceOf(co, '2210', ASOF)).toBe(-2_000_000) // owed back to Garibsons (H1)
    }
  })

  it('1357 = 0, never posted to, not listed in the TB; 1355 untouched', async () => {
    for (const co of both()) {
      expect(await sim.ledger.balanceOf(co, '1357', ASOF)).toBe(0)
      expect(await sim.prisma.journalLine.count({ where: { account: { tenantId: co.tenantId, code: { in: ['1357', '1355'] } } } })).toBe(0)
      const tb = await sim.ledger.trialBalance(co, ASOF)
      expect(tb.rows.map((r) => r.code)).not.toContain('1357')
    }
  })

  it('1310 = the prepayment\'s schedule (5 of 6 months left); 2010 / 2012 / 1360 cleared', async () => {
    const { releaseSchedule } = await import('../../src/modules/accounting/prepaidReleases.js')
    for (const co of both()) {
      const sched = releaseSchedule(12_000_000, '2026-10', 6)
      const left = sched.filter((s) => s.period > '2026-10').reduce((t, s) => t + s.amountCents, 0)
      expect(await sim.ledger.balanceOf(co, '1310', ASOF)).toBe(left)
      expect(await sim.ledger.balanceOf(co, '2010', ASOF)).toBe(0)
      expect(await sim.ledger.balanceOf(co, '2012', ASOF)).toBe(0)
      expect(await sim.ledger.balanceOf(co, '1360', ASOF)).toBe(0)
    }
  })

  it('1340 = the advances list (the shelving bought from the box, not yet capitalised)', async () => {
    for (const co of both()) {
      const r = ok(await sim.as(co.finance, co).get(`${FA}/reports/advances?asOf=${ASOF}`), 200)
      const mine = r.byCompany.find((c: { tenantId: string }) => c.tenantId === co.tenantId)
      expect(mine).toMatchObject({ heldCents: 800_000, glCents: 800_000, diffCents: 0 })
      expect(r.rows.filter((x: { tenantId: string; heldCents: number }) => x.tenantId === co.tenantId && x.heldCents !== 0).map((x: { lineId: string; heldCents: number }) => [x.lineId, x.heldCents]))
        .toEqual([[st[co.key].lines.shelving, 800_000]])
    }
  })

  it('the fixed-asset register ties to 15xx and 159x (the tie-out route and the engine)', async () => {
    const { fixedAssetTieOut } = await import('../../src/modules/fixedAssets/reports.js')
    for (const co of both()) {
      const [t] = await fixedAssetTieOut(sim.prisma, [co.tenantId], new Date('2026-10-31T23:59:59.999+05:00'))
      expect(t, JSON.stringify(t)).toMatchObject({ ok: true })
      const kitchen = t!.byClass.find((c) => c.classKey === 'kitchen_equipment')!
      expect(kitchen.glCostCents).toBe(30_000_000) // fryer; the chiller left with its sale
      expect(t!.byClass.find((c) => c.classKey === 'it_equipment')!.glCostCents).toBe(18_000_000)
      const route = ok(await sim.as(co.finance, co).get(`${FA}/reports/tie-out?asOf=${ASOF}`), 200)
      const bad = (route.rows as Array<{ tenantId: string; diffCents: number }>).filter((x) => x.tenantId === co.tenantId && x.diffCents !== 0)
      expect(bad, JSON.stringify(route.rows)).toEqual([])
    }
  })

  it('no entry of one company\'s documents lands in the other company\'s books', async () => {
    for (const [co, other] of [[sim.A, sim.B], [sim.B, sim.A]] as const) {
      const ids = [...st[co.key].docIds, ...st[co.key].movements]
      const foreign = await sim.prisma.journalEntry.findMany({ where: { tenantId: other.tenantId }, select: { reference: true } })
      const leaked = foreign.filter((e) => ids.some((id) => e.reference?.includes(id)))
      expect(leaked).toEqual([])
      for (const id of st[co.key].movements) {
        const m = await sim.prisma.pettyCashMovement.findUniqueOrThrow({ where: { id }, select: { journalEntryId: true } })
        if (m.journalEntryId) expect((await sim.prisma.journalEntry.findUniqueOrThrow({ where: { id: m.journalEntryId } })).tenantId).toBe(co.tenantId)
      }
    }
  })

  it('company B gets 404 on A\'s vouchers, box, assets, files and CapEx payments', async () => {
    const finB = sim.as(sim.B.finance, sim.B)
    const a = st.A
    expect((await finB.get(`${V}/${a.vouchers.a}`)).statusCode).toBe(404)
    expect((await finB.post(`${V}/${a.vouchers.c}/verify-docs`, {})).statusCode).toBe(404)
    expect((await finB.post(`${V}/${a.vouchers.b}/documents`, pdfFile('x.pdf'))).statusCode).toBe(404)
    expect((await finB.post('/trustops/petty-cash/movements', { boxId: a.boxId, type: 'topup', amountCents: 100, reason: 'x', source: 'safe' })).statusCode).toBe(404)
    expect((await finB.post(`/trustops/petty-cash/boxes/${a.boxId}/reconcile`, { countedCents: 0 })).statusCode).toBe(404)
    expect((await finB.post('/trustops/petty-cash/returns', { boxId: a.boxId, amountCents: 100, destination: 'safe', reason: 'x' })).statusCode).toBe(404)
    expect((await finB.get(`${FA}/${a.assets.fryer}`)).statusCode).toBe(404)
    expect((await finB.put(`${FA}/${a.assets.laptop}/initial-allowance`, { eligible: false })).statusCode).toBe(404)
    expect((await finB.post(`${FA}/${a.assets.fryer}/dispose`, { disposedAt: '2026-11-01', proceedsCents: 0 })).statusCode).toBe(404)
    expect((await finB.get(`/record-files/opex_payment/${a.rentPaymentId}`)).statusCode).toBe(404)
    expect((await finB.patch(`/opex/payments/${a.rentPaymentId}`, { paymentRef: 'x' })).statusCode).toBe(404)
    expect((await finB.post(`/finance/capex/payments/${a.payments.deposit}/deposit-return`, { returnedCents: 0, receivedAt: '2026-11-01' })).statusCode).toBe(404)
    expect((await finB.post(`/finance/capex/lines/${a.lines.shelving}/payments`, { amountCents: 100 })).statusCode).toBe(404)
    // B's lists never show A's rows.
    const list = ok(await finB.get(V), 200)
    expect(JSON.stringify(list)).not.toContain(a.vouchers.a)
    const boxes = ok(await finB.get('/trustops/petty-cash/boxes'), 200)
    expect(JSON.stringify(boxes)).not.toContain(a.boxId)
  })
})
