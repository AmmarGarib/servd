// The simulated month — TAX and PAYROLL (finance readiness plan §4a item 6,
// and the tax / payroll accounts of "Ledger results to check"). Its own world
// on the shared harness (tests/sim/harness.ts — its header is the API).
//
// October 2026 (31 days), company A ('GS Foods', withholding ON) and company B
// ('GS x Viva'). Logins added here (seeded like the harness's): an HR login per
// company and a management login in A ('Ops Director', the second person who
// approves payroll). Everything else goes through the real API.
//
//   30 Sep   HR settings (EOBI on a fixed PKR 40,000 wage, 1% / 5%; SESSI 6%),
//            leave types, five employees in A — Ayesha (bank, full month),
//            Bilal (cash, joins 22 Oct), Danish (bank, absent all month),
//            Ammar (the CEO's own HR record, cash) and Farah (bank, permanent
//            since 2023, the leaver); tip pooling ON; Simmer (A) and Stackd (B)
//            invoice under the same prefix 'GSF'.
//   1 Oct    Farah's loan (HR → CEO → management, paid from the main bank) and
//            her resignation (last working day 20 Oct).
//   2 Oct    a till in each company: SRB and FBR bills, a Keenu card with a
//            PKR 200 tip (output tax, tax invoices, 2095).
//   3–8 Oct  purchasing for the tax return: chicken received at the dock and
//            billed with FBR tax (federal input on food stock — H8 / H34), a
//            pest-control bill with SRB tax (input 1322), withholding taken at
//            the bill (2040, H47); a client invoice from Simmer with SRB tax.
//   20 Oct   the client withholds sales tax (1335, H13).
//   21 Oct   Farah's final-month attendance (absent, half day); her full &
//            final (salary for 18.5 of 31 days, leave, gratuity, the loan
//            recovered), HR → CEO → management, booked; company B gets 404.
//   31 Oct   the month's attendance: Ayesha absent / half day / late / off day
//            and two days of unpaid leave; Bilal absent once after joining
//            (and once before — not counted); Danish absent every day.
//   1 Nov    HR calculates October (gross ÷ 31 × paid days); HR cannot approve;
//            management approves and locks → the accrual.
//   2 Nov    a tip pool for Flipd's October tips, posted and paid by the CEO
//            from the main bank (two banks: none named → 422).
//   5 Nov    finance pays payroll — cash slips from the safe, bank slips from
//            the main bank (none named → 422); the CEO, whose pay is on it, is
//            refused (OWN_PAY_IN_RUN); company B gets 404. Finance pays Farah's
//            full & final from the second bank.
//   10 Nov   EOBI, SESSI and salary-tax challans; a salary-tax TOP-UP for
//            Farah's tax (no CPR → 422, the same CPR → 409, its own → 201).
//   12 Nov   the sales tax return: FBR paid with part of its own input set off;
//            SRB paid with its input, the client-withheld tax and federal input
//            on raw materials set off (above the pool → 422; against FBR → 422),
//            then a second SRB payment for the same month (CPR rules); the
//            vendor withholding (2040) paid over.
// Month end: TB balanced; 2020 = 0; 1350 = 0; 2030 / 2032 = 0; 1322 / 1335 = 0;
// 1320 = federal input still unused; 2040 / 2042 / 2043 / 2044 = accrued − paid
// = /accounting/statutory; 2095 = tips collected − paid (A 0, B the unpaid tip);
// tax invoices numbered per company; B 404 on A's runs, settlements, challans.
//
// Requires a disposable database ("test" in DATABASE_URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { startSim, ok, errCode, pdfFile, pkt, pktDay, type Sim, type SimCompany, type SimUser, type SimBrand, type SimItem } from './harness.js'

let sim: Sim
const RS = (r: number) => r * 100
const PERIOD = { periodFrom: '2026-10-01', periodTo: '2026-10-31' }

// ─── Extra logins (seeded like the harness's own) ───────────────────────────

const people: { hrA?: SimUser; hrB?: SimUser; mgmtA?: SimUser; buyerA?: SimUser } = {}
async function mkLogin(name: string, role: UserRole, co: SimCompany): Promise<SimUser> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@sim.gsfoods.test`
  const u = await sim.prisma.user.create({
    data: {
      name, email, password: await bcrypt.hash('Sim-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: co.tenantId,
      tenantMemberships: { create: [{ tenant: { connect: { id: co.tenantId } }, role: 'manager' }] },
    },
  })
  return { id: u.id, name, email, role, tenantId: co.tenantId }
}

// ─── Small helpers ──────────────────────────────────────────────────────────

let seq = 0
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase()
const cardRef = () => `KN${RUN}${String(500000 + ++seq)}`
const key = (s: string) => `simtp-${s}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
/** A credit balance (liability / income) as a positive number. */
const credit = async (co: SimCompany, code: string, asOf?: string) => 0 - (await sim.ledger.balanceOf(co, code, asOf)) || 0
const line = (item: SimItem, quantity = 1) => ({ menuItemId: item.id, name: item.name, quantity, unitPriceCents: item.priceCents, modifiers: [] })

interface Rung { id: string; totalCents: number; taxCents: number }
const sales: Record<'A' | 'B', { srbTax: number; fbrTax: number; tips: number; orders: Array<{ id: string; brand: 'srb' | 'fbr' }> }> = {
  A: { srbTax: 0, fbrTax: 0, tips: 0, orders: [] },
  B: { srbTax: 0, fbrTax: 0, tips: 0, orders: [] },
}

async function tillDay(co: SimCompany, day: string, hhmm: string) {
  sim.clock.at(day, hhmm)
  const c = co.cashier
  const till = ok(await sim.as(c, co).post('/pos/shifts/open', { openingFloatCents: 500_000 }), 201).id as string
  const ring = async (brand: SimBrand, items: Array<[SimItem, number]>, tender?: 'card'): Promise<Rung> =>
    ok(await sim.as(c, co).post('/pos/orders', { conceptId: brand.id, shiftId: till, items: items.map(([i, q]) => line(i, q)), idempotencyKey: key('ring'), ...(tender && { paymentMethod: tender }) }), 201)
  const pay = async (o: Rung, brand: 'srb' | 'fbr', payment: Record<string, unknown>) => {
    ok(await sim.as(c, co).post('/pos/payments', { orderId: o.id, shiftId: till, idempotencyKey: key('pay'), payments: [payment] }), 201)
    sales[co.key].orders.push({ id: o.id, brand })
  }
  const { srb, fbr } = co.brands
  const s1 = await ring(srb, [[srb.items.main, 2], [srb.items.drink, 2]])
  await pay(s1, 'srb', { method: 'cash', amountCents: s1.totalCents, tenderedCents: s1.totalCents })
  const s2 = await ring(srb, [[srb.items.side, 1], [srb.items.dessert, 1]])
  await pay(s2, 'srb', { method: 'cash', amountCents: s2.totalCents, tenderedCents: s2.totalCents })
  const f1 = await ring(fbr, [[fbr.items.main, 1], [fbr.items.side, 1]])
  await pay(f1, 'fbr', { method: 'cash', amountCents: f1.totalCents, tenderedCents: f1.totalCents })
  // Keenu card with a PKR 200 tip
  const f2 = await ring(fbr, [[fbr.items.main, 2]], 'card')
  await pay(f2, 'fbr', { method: 'card', amountCents: f2.totalCents + 20_000, gateway: 'keenu', gatewayRef: cardRef(), tipCents: 20_000 })
  sales[co.key].tips += 20_000
  const z = ok(await sim.as(co.manager, co).get(`/pos/shifts/${till}/zreport`), 200)
  const expected = (z.expectedCashCents ?? z.expectedCents ?? z.drawer?.expectedCents ?? z.cash?.expectedCents) as number
  expect(typeof expected, JSON.stringify(z).slice(0, 400)).toBe('number')
  sim.clock.at(day, hhmm.replace(/^(\d\d)/, (h) => String(Number(h) + 6).padStart(2, '0')))
  ok(await sim.as(c, co).post(`/pos/shifts/${till}/close`, { closingFloatCents: expected }), 200)
  await sim.settle()
  // The output tax the bills carry, from the stored order figures.
  for (const o of sales[co.key].orders) {
    const row = await sim.prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { taxCents: true } })
    if (o.brand === 'srb') sales[co.key].srbTax += row.taxCents
    else sales[co.key].fbrTax += row.taxCents
  }
}

// ─── HR helpers ─────────────────────────────────────────────────────────────

const emps: Record<string, string> = {}
const leaveTypes: Record<string, string> = {}
const hr = (co: SimCompany = sim.A) => sim.as(co.key === 'A' ? people.hrA! : people.hrB!, co)

async function record(section: string, data: Record<string, unknown>, co: SimCompany = sim.A): Promise<{ id: string; status: string }> {
  return ok(await hr(co).post(`/hr/records/${section}`, { data }), 201)
}
/** Two-step HR records (HOD/HR, HR/management): raised by HR, decided by two other people. */
async function decide(section: string, id: string, who: SimUser, extra: Record<string, unknown> = {}) {
  return ok(await sim.as(who, sim.A).post(`/hr/records/${section}/${id}/decide`, { decision: 'approved', ...extra }), 200)
}
const att = (employee: string, date: string, status: string) => record('attendance', { employee, date, status })

// ─── Expectations built as it goes ──────────────────────────────────────────

const st: {
  loanId?: string
  fnfId?: string
  fnf?: Record<string, number>
  runId?: string
  slips?: Map<string, { grossCents: number; netCents: number; eobiEmployeeCents: number; eobiEmployerCents: number; lines: Array<{ kind: string; code: string; label: string; amountCents: number }>; inputs: Record<string, unknown> }>
  poolId?: string
  stockTaxCents: number
  srbInputCents: number
  withheldBySrbClientCents: number
  payments: string[]
  fbrInputSetOff: number
  crossSetOff: number
} = { stockTaxCents: 54_000, srbInputCents: 8_000, withheldBySrbClientCents: 6_400, payments: [], fbrInputSetOff: 0, crossSetOff: 0 }

beforeAll(async () => {
  sim = await startSim()
  people.hrA = await mkLogin('Sana HR A', 'hr', sim.A)
  people.hrB = await mkLogin('Omar HR B', 'hr', sim.B)
  people.mgmtA = await mkLogin('Ops Director A', 'management', sim.A)
  people.buyerA = await mkLogin('Kamran Buyer A', 'procurement', sim.A)
}, 120_000)

afterAll(async () => {
  await sim?.close()
})

// ─── 30 September: the set-up ───────────────────────────────────────────────

describe('set-up (30 Sep)', () => {
  it('HR settings, leave types, five employees; the CEO\'s own HR record is linked to the CEO login', async () => {
    sim.clock.at('2026-09-30', '12:00')
    const { A, B } = sim
    for (const co of [A, B]) {
      const cur = ok(await hr(co).get('/hr/settings'), 200)
      const put = ok(await hr(co).put('/hr/settings', {
        ...cur,
        eobi: { enabled: true, employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) },
        sessi: { employerPct: 6, wageCeilingCents: null },
      }), 200)
      expect(put.eobi.enabled).toBe(true)
    }
    leaveTypes['unpaid'] = (await record('leave_type', { name: 'Unpaid leave', entitlementDays: 0, pay: 'unpaid' })).id
    leaveTypes['annual'] = (await record('leave_type', { name: 'Annual leave', entitlementDays: 14, pay: 'paid' })).id

    const mk = async (k: string, data: Record<string, unknown>) => {
      emps[k] = (ok(await hr().post('/hr/employees', { data: { employmentType: 'permanent', status: 'active', ...data } }), 201) as { id: string }).id
    }
    await mk('ayesha', { fullName: 'Ayesha Khan', joiningDate: '2025-06-01', grossSalaryCents: RS(62000), monthlyTaxCents: RS(1500), paymentMethod: 'bank', bankName: 'HBL', iban: 'PK36HABB0000001123456702' })
    await mk('bilal', { fullName: 'Bilal Ahmed', joiningDate: '2026-10-22', grossSalaryCents: RS(31000), monthlyTaxCents: 0, paymentMethod: 'cash', employmentType: 'probation' })
    await mk('danish', { fullName: 'Danish Ali', joiningDate: '2024-01-15', grossSalaryCents: RS(46500), monthlyTaxCents: RS(800), paymentMethod: 'bank', bankName: 'HBL', iban: 'PK36HABB0000001123456703' })
    await mk('ammar', { fullName: 'Ammar (CEO)', joiningDate: '2020-01-01', grossSalaryCents: RS(310000), monthlyTaxCents: RS(40000), paymentMethod: 'cash' })
    await mk('farah', { fullName: 'Farah Siddiqui', joiningDate: '2023-03-01', grossSalaryCents: RS(93000), monthlyTaxCents: RS(2000), paymentMethod: 'bank', bankName: 'Meezan', iban: 'PK36MEZN0000001123456704' })
    ok(await hr().post(`/hr/employees/${emps['ammar']}/link-user`, { userId: sim.ceo.id }), 200)
    // B has staff of its own (never on A's payroll).
    emps['b-staff'] = (ok(await hr(B).post('/hr/employees', { data: { fullName: 'Hina (B)', joiningDate: '2025-01-01', grossSalaryCents: RS(40000), paymentMethod: 'bank' } }), 201) as { id: string }).id

    // The CEO: tip pooling on in A; Simmer (A) and Stackd (B) invoice under the same prefix.
    ok(await sim.as(sim.ceo, A).patch('/setup/operations-config', { tipPoolEnabled: true }), 200)
    for (const [co, b] of [[A, A.brands.srb], [B, B.brands.srb]] as const) ok(await sim.as(sim.ceo, co).patch(`/concepts/${b.id}`, { invoicePrefix: 'GSF' }), 200)
  })
})

// ─── 1 October: a loan and a resignation ────────────────────────────────────

describe('Farah\'s loan and resignation (1 Oct)', () => {
  it('the loan is approved by two other people and paid out of the bank management names (two banks)', async () => {
    sim.clock.at('2026-10-01', '10:00')
    const { A } = sim
    const loan = await record('loan', { employee: emps['farah'], type: 'loan', amount: RS(30000), date: '2026-10-01', installments: 6, firstDeduction: '2026-11-01', reason: 'Family wedding' })
    expect(loan.status).toBe('submitted')
    // HR raised it — HR cannot approve its own request.
    const own = await hr().post(`/hr/records/loan/${loan.id}/decide`, { decision: 'approved' })
    expect(own.statusCode, own.body).toBe(403)
    await decide('loan', loan.id, sim.ceo)
    const done = await decide('loan', loan.id, people.mgmtA!, { paidFrom: 'bank', bankAccountId: A.banks.main.id })
    expect(done.status).toBe('approved')
    st.loanId = loan.id
    const [e] = await sim.ledger.entriesBySource(A, `hr.loan.disbursement:${loan.id}`)
    expect(e, 'the loan is paid out').toBeTruthy()
    expect(e!.lines.map((l) => [l.type, l.code, l.cents]).sort()).toEqual([['credit', A.banks.main.code, RS(30000)], ['debit', '1350', RS(30000)]])
  })

  it('her resignation (last working day 20 Oct) is approved', async () => {
    const r = await record('resignation', { employee: emps['farah'], resignationDate: '2026-10-01', lastWorkingDay: '2026-10-20', reason: 'Moving to Lahore' })
    await decide('resignation', r.id, people.mgmtA!) // HOD step: no reporting manager → an HR approver
    const done = await decide('resignation', r.id, sim.ceo)
    expect(done.status).toBe('approved')
    const e = await sim.prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps['farah'] } })
    expect(e.status).toBe('resigned')
    expect(e.lastWorkingDay?.toISOString().slice(0, 10)).toBe('2026-10-20')
  })
})

// ─── 2 October: sales (output tax, tips, tax invoices) ──────────────────────

describe('the tills (2 Oct)', () => {
  it('A and B each ring SRB and FBR bills and a tipped Keenu card; the tills close and post', async () => {
    await tillDay(sim.A, '2026-10-02', '10:00')
    await tillDay(sim.B, '2026-10-02', '16:30')
    for (const co of [sim.A, sim.B]) {
      const s = sales[co.key]
      expect(s.srbTax).toBeGreaterThan(0)
      expect(s.fbrTax).toBeGreaterThan(0)
      expect(await credit(co, '2032'), `${co.key}: 2032 = the SRB bills' tax`).toBe(s.srbTax)
      expect(await credit(co, '2030'), `${co.key}: 2030 = the FBR bills' tax`).toBe(s.fbrTax)
      expect(await credit(co, '2095'), `${co.key}: 2095 = the tip`).toBe(s.tips)
    }
  })

  it('tax invoices are numbered per company: A and B both issue GSF-2026-00001 / 00002 for their SRB brand', async () => {
    for (const co of [sim.A, sim.B]) {
      const inv = await sim.prisma.taxInvoice.findMany({ where: { conceptId: co.brands.srb.id }, orderBy: { invoiceNumber: 'asc' }, select: { invoiceNumber: true, tenantId: true, fbrTaxCents: true } })
      expect(inv.map((i) => i.invoiceNumber)).toEqual(['GSF-2026-00001', 'GSF-2026-00002'])
      expect(inv.every((i) => i.tenantId === co.tenantId)).toBe(true)
      const all = await sim.prisma.taxInvoice.findMany({ where: { tenantId: co.tenantId, type: 'invoice' }, select: { fbrTaxCents: true, conceptId: true } })
      const sum = (b: SimBrand) => all.filter((i) => i.conceptId === b.id).reduce((t, i) => t + i.fbrTaxCents, 0)
      expect(sum(co.brands.srb), `${co.key}: SRB invoices = 2032 from sales`).toBe(sales[co.key].srbTax)
      expect(sum(co.brands.fbr), `${co.key}: FBR invoices = 2030`).toBe(sales[co.key].fbrTax)
    }
    // The register: finance sees its own company's only; another company's brand is 404.
    const regA = ok(await sim.as(sim.A.finance, sim.A).get('/invoices?type=invoice'), 200)
    const rowsA = (Array.isArray(regA) ? regA : regA.invoices ?? regA.rows) as Array<{ tenantId: string; invoiceNumber: string }>
    expect(rowsA.length).toBe(4)
    expect(rowsA.every((r) => r.tenantId === sim.A.tenantId)).toBe(true)
    expect((await sim.as(sim.A.finance, sim.A).get(`/invoices?conceptId=${sim.B.brands.srb.id}`)).statusCode).toBe(404)
  })
})

// ─── 3–20 October: input tax, withholding, a client invoice ─────────────────

describe('purchasing and a client invoice for the return (3–20 Oct)', () => {
  it('chicken received at the dock and billed with FBR tax; a pest-control bill with SRB tax; WHT at the bill', async () => {
    const { A } = sim
    sim.clock.at('2026-10-03', '09:00')
    // The buyer (role procurement): the F&B manager's default modules hold no 'procurement'.
    const mgr = sim.as(people.buyerA!, A)
    const meat = ok(await mgr.post('/procurement/suppliers', { name: 'Karachi Meat Co', filerStatus: 'filer', defaultTaxAuthority: 'fbr', paymentTermsDays: 30 }), 201)
    const pest = ok(await mgr.post('/procurement/suppliers', { name: 'Clean Sweep Pest Control', filerStatus: 'filer', defaultTaxAuthority: 'srb', defaultWhtSection: '153_1_b', paymentTermsDays: 15 }), 201)
    const chicken = ok(await mgr.post('/inventory', { name: 'Chicken breast', unit: 'kg', category: 'protein', unitCostCents: 90_000 }), 201)
    const po = ok(await mgr.post('/procurement/purchase-orders', { supplierId: meat.id, lines: [{ inventoryItemId: chicken.id, quantityOrdered: 100, unitCostCents: 3_000 }] }), 201)
    let s = ok(await mgr.post(`/procurement/purchase-orders/${po.id}/submit`, {}), 200)
    if (s.status === 'pending_approval') s = ok(await sim.as(sim.ceo, A).post(`/procurement/purchase-orders/${po.id}/approve`, {}), 200)
    const poRow = await sim.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } })
    const got = ok(await sim.as(sim.ceo, A).post(`/procurement/purchase-orders/${po.id}/receive`, {
      locationId: A.locationId, photos: [pdfFile('dock.pdf')], lines: [{ poLineId: poRow.lines[0]!.id, quantityReceived: 100 }],
    }), 201)
    const receiptLine = (got.receipt.lines as Array<{ id: string }>)[0]!

    sim.clock.at('2026-10-05', '11:00')
    const fin = sim.as(A.finance, A)
    const bill = ok(await fin.post('/procurement/bills', {
      supplierId: meat.id, poId: po.id, billNumber: 'KMC-1001', billDate: '2026-10-05', taxCents: st.stockTaxCents, taxAuthority: 'fbr',
      lines: [{ inventoryItemId: chicken.id, receiptLineId: receiptLine.id, description: 'Chicken breast 100 kg', quantity: 100, unitCostCents: 3_000 }],
    }), 201)
    expect(Number(bill.whtCents), 'WHT is taken at the bill (H47)').toBeGreaterThan(0)
    sim.clock.at('2026-10-06', '11:00')
    const pb = ok(await fin.post('/procurement/bills', {
      supplierId: pest.id, billNumber: 'CS-77', billDate: '2026-10-06', taxCents: st.srbInputCents, taxAuthority: 'srb',
      lines: [{ expenseAccountCode: '6042', description: 'Monthly fumigation — Clifton', quantity: 1, unitCostCents: RS(500) }],
    }), 201)
    expect(Number(pb.whtCents)).toBeGreaterThan(0)
    expect(await sim.ledger.balanceOf(A, '1320'), '1320 = the FBR input on the chicken').toBe(st.stockTaxCents)
    expect(await sim.ledger.balanceOf(A, '1322'), '1322 = the SRB input on the service').toBe(st.srbInputCents)
    expect(await credit(A, '2040'), '2040 = WHT on both bills').toBe(Number(bill.whtCents) + Number(pb.whtCents))
  })

  it('Simmer invoices a corporate client with SRB tax; the client withholds sales tax (1335)', async () => {
    const { A } = sim
    sim.clock.at('2026-10-08', '12:00')
    const fin = sim.as(A.finance, A)
    const inv = ok(await fin.post('/accounting/receivables', {
      customerName: 'Pak Bank Ltd', issueDate: '2026-10-08', dueDate: '2026-11-07', description: 'Staff lunch boxes, October',
      amountCents: RS(2000), taxCents: RS(320), conceptId: A.brands.srb.id,
    }), 201)
    sim.clock.at('2026-10-20', '12:00')
    const w = ok(await fin.post(`/accounting/receivables/${inv.id}/withholding`, { date: '2026-10-20', kind: 'sales_tax', amountCents: st.withheldBySrbClientCents, certificateNo: 'SRB-WH-PB-1' }), 201)
    expect(w).toMatchObject({ method: 'st_withheld', taxAuthority: 'srb' })
    expect(await sim.ledger.balanceOf(A, '1335')).toBe(st.withheldBySrbClientCents)
    expect(await credit(A, '2032')).toBe(sales.A.srbTax + RS(320))
  })
})

// ─── 21 October: Farah's full & final ───────────────────────────────────────

describe('Farah\'s full & final (21 Oct)', () => {
  const FNF_KEYS = ['salaryPayable', 'otPayable', 'leaveEncashment', 'gratuity', 'loanRecovery', 'incomeTax', 'eobiEmployee', 'eobiEmployer', 'sessiEmployer']

  it('her final month is docked for the absence and the half day; gratuity and the loan are in it', async () => {
    sim.clock.at('2026-10-21', '10:00')
    await att(emps['farah']!, '2026-10-06', 'absent')
    await att(emps['farah']!, '2026-10-09', 'half_day')
    await att(emps['farah']!, '2026-10-24', 'absent') // after her last day: not docked
    const rec = await record('final_settlement', { employee: emps['farah'], lastWorkingDay: '2026-10-20' })
    st.fnfId = rec.id
    const c = ok(await hr().post('/hr/final-settlement/calculate', { employeeId: emps['farah'], lastWorkingDay: '2026-10-20', recordId: rec.id }), 200)
    expect(c.months).toHaveLength(1)
    expect(c.months[0].basis).toMatchObject({ daysInMonth: 31, employedDays: 20, absentDays: 1.5, unpaidLeaveDays: 0, paidDays: 18.5 })
    expect(c.salaryPayable, 'Rs 93,000 ÷ 31 × 18.5').toBe(RS(3000) * 18.5)
    expect(c.loanRecovery, 'the whole loan is recovered').toBe(RS(30000))
    expect(c.gratuityDetail.eligible, JSON.stringify(c.gratuityDetail)).toBe(true)
    expect(c.gratuity).toBeGreaterThan(0)
    expect(c.leaveEncashment).toBeGreaterThan(0)
    expect(c.incomeTax).toBe(RS(2000))
    expect(c.eobiEmployee).toBeGreaterThan(0)
    st.fnf = Object.fromEntries(FNF_KEYS.map((k) => [k, c[k] as number]))
    // Company B's HR never reaches A's leaver.
    expect((await hr(sim.B).post('/hr/final-settlement/calculate', { employeeId: emps['farah'], lastWorkingDay: '2026-10-20' })).statusCode).toBe(404)
  })

  it('approved by the CEO (HR step) and management; the accrual balances and recovers the loan', async () => {
    const { A } = sim
    ok(await hr().patch(`/hr/records/final_settlement/${st.fnfId}`, { data: st.fnf }), 200)
    await decide('final_settlement', st.fnfId!, sim.ceo)
    const done = await decide('final_settlement', st.fnfId!, people.mgmtA!)
    expect(done.status).toBe('approved')
    const f = st.fnf!
    const net = f['salaryPayable']! + f['otPayable']! + f['leaveEncashment']! + f['gratuity']! - f['loanRecovery']! - f['incomeTax']! - f['eobiEmployee']!
    expect(done.amountCents, 'the net F&F').toBe(net)
    const [e] = await sim.ledger.entriesBySource(A, `hr.final_settlement.accrual:${st.fnfId}`)
    expect(e).toBeTruthy()
    const sum = (code: string, type: 'debit' | 'credit') => e!.lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.cents, 0)
    expect(sum('6036', 'debit'), 'gratuity → 6036').toBe(f['gratuity'])
    expect(sum('1350', 'credit'), 'the loan recovered').toBe(RS(30000))
    expect(sum('2042', 'credit')).toBe(f['incomeTax'])
    expect(sum('2043', 'credit')).toBe(f['eobiEmployee']! + f['eobiEmployer']!)
    expect(sum('2044', 'credit')).toBe(f['sessiEmployer'])
    expect(sum('2020', 'credit')).toBe(net)
    expect(e!.entryDate.toISOString().slice(0, 7), 'booked in October').toBe('2026-10')
    expect(await sim.ledger.balanceOf(A, '1350'), 'no loan left on 1350').toBe(0)
  })
})

// ─── 31 October – 1 November: attendance and the October payroll ───────────

describe('the October payroll (31 Oct – 1 Nov)', () => {
  it('HR keys the month\'s attendance and two days of unpaid leave (HOD → HR)', async () => {
    sim.clock.at('2026-10-31', '18:00')
    await att(emps['ayesha']!, '2026-10-07', 'absent')
    await att(emps['ayesha']!, '2026-10-08', 'half_day')
    await att(emps['ayesha']!, '2026-10-10', 'late')
    await att(emps['ayesha']!, '2026-10-11', 'off_day')
    const lv = await record('leave', { employee: emps['ayesha'], leaveType: leaveTypes['unpaid'], from: '2026-10-14', to: '2026-10-15', reason: 'Personal' })
    await decide('leave', lv.id, people.mgmtA!)
    expect((await decide('leave', lv.id, sim.ceo)).status).toBe('approved')
    await att(emps['bilal']!, '2026-10-05', 'absent') // before he joined: not counted
    await att(emps['bilal']!, '2026-10-25', 'absent')
    for (let d = 1; d <= 31; d++) await att(emps['danish']!, `2026-10-${String(d).padStart(2, '0')}`, 'absent')
  })

  it('pay = gross ÷ 31 × paid days; the absent-all-month person takes no tax, EOBI or SESSI; the leaver is not on it', async () => {
    sim.clock.at('2026-11-01', '10:00')
    const run = ok(await hr().post('/hr/payroll/runs', { period: '2026-10' }), 201)
    st.runId = run.id
    const r = ok(await hr().get(`/hr/payroll/runs/${run.id}`), 200)
    st.slips = new Map((r.payslips as Array<{ employeeId: string }>).map((s) => [s.employeeId, s as never]))
    expect(new Set(st.slips.keys()), 'Farah is paid by her full & final, not the payroll').toEqual(new Set([emps['ayesha'], emps['bilal'], emps['danish'], emps['ammar']]))
    const slip = (k: string) => st.slips!.get(emps[k]!)!
    const basis = (k: string) => slip(k).inputs['payBasis']

    // Ayesha: 31 − 1 absent − ½ half day − 2 unpaid = 27.5 × Rs 2,000 (late and off day are paid).
    expect(basis('ayesha')).toMatchObject({ daysInMonth: 31, employedDays: 31, absentDays: 1.5, unpaidLeaveDays: 2, paidDays: 27.5, dailyRateCents: RS(2000) })
    expect(slip('ayesha').grossCents).toBe(RS(55000))
    // Bilal joined 22 Oct: 10 days employed, 1 absent → 9 × Rs 1,000.
    expect(basis('bilal')).toMatchObject({ daysInMonth: 31, employedDays: 10, absentDays: 1, paidDays: 9 })
    expect(slip('bilal').grossCents).toBe(RS(9000))
    // Danish: absent every day → nothing, and no tax / EOBI / SESSI.
    expect(basis('danish')).toMatchObject({ employedDays: 31, absentDays: 31, paidDays: 0 })
    expect(slip('danish')).toMatchObject({ grossCents: 0, netCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0 })
    expect(slip('danish').lines.find((l) => l.code === 'tax')).toMatchObject({ amountCents: 0 })
    expect(slip('danish').lines.some((l) => l.code === 'sessi_employer' && l.amountCents > 0)).toBe(false)
    // Ammar: a full month.
    expect(slip('ammar').grossCents).toBe(RS(310000))
    const by = (k: string) => Object.fromEntries(slip(k).lines.map((l) => [l.code, l.amountCents]))
    expect(by('ayesha'), JSON.stringify(slip('ayesha').lines)).toMatchObject({ tax: RS(1500), eobi_employee: RS(400), eobi_employer: RS(2000), sessi_employer: Math.round(RS(55000) * 0.06) })
    expect(slip('ayesha').netCents).toBe(RS(55000 - 1500 - 400))
  })

  it('HR cannot approve its own payroll; management (the second person) approves and locks → the accrual', async () => {
    const { A } = sim
    expect((await hr().post(`/hr/payroll/runs/${st.runId}/approve`, {})).statusCode).toBe(403)
    const mg = sim.as(people.mgmtA!, A)
    expect(ok(await mg.post(`/hr/payroll/runs/${st.runId}/approve`, {}), 200).status).toBe('approved')
    expect(ok(await mg.post(`/hr/payroll/runs/${st.runId}/lock`, {}), 200).status).toBe('locked')
    const [e] = await sim.ledger.entriesBySource(A, `hr.payroll.accrual:${st.runId}`)
    expect(e, 'locking posts the accrual').toBeTruthy()
    expect(e!.entryDate.toISOString().slice(0, 7)).toBe('2026-10')
    const slips = [...st.slips!.values()]
    const lineSum = (code: string) => slips.reduce((t, s) => t + s.lines.filter((l) => l.code === code).reduce((a, l) => a + l.amountCents, 0), 0)
    const sum = (code: string) => e!.lines.filter((l) => l.code === code).reduce((t, l) => t + (l.type === 'credit' ? l.cents : -l.cents), 0)
    expect(sum('2020'), '2020 = Σ net').toBe(slips.reduce((t, s) => t + s.netCents, 0))
    expect(sum('2042'), '2042 = Σ tax').toBe(lineSum('tax'))
    expect(sum('2042')).toBe(RS(1500 + 40000))
    expect(sum('2043'), '2043 = Σ EOBI both shares').toBe(slips.reduce((t, s) => t + s.eobiEmployeeCents + s.eobiEmployerCents, 0))
    expect(sum('2044'), '2044 = Σ SESSI').toBe(lineSum('sessi_employer'))
  })
})

// ─── 2 November: the tip pool ───────────────────────────────────────────────

describe('the tip pool (2 Nov)', () => {
  it('Flipd\'s October tips are pooled, posted and paid from the main bank (two banks: none named → 422)', async () => {
    const { A } = sim
    sim.clock.at('2026-11-02', '11:00')
    const fin = sim.as(A.finance, A)
    const pool = ok(await fin.post('/tip-pools', {
      conceptId: A.brands.fbr.id, name: 'Flipd — October', periodStart: pkt('2026-10-01', '00:00').toISOString(), periodEnd: pkt('2026-11-01', '00:00').toISOString(),
    }), 201)
    expect(pool.totalTipsCents).toBe(sales.A.tips)
    st.poolId = pool.id
    for (const [u, h] of [[A.cashier, 8], [A.cashier2, 6]] as const) {
      ok(await fin.post(`/tip-pools/${pool.id}/members`, { userId: u.id, hoursWorked: h, roleWeight: 1, notes: 'On the floor all month' }), 201)
    }
    const ceo = sim.as(sim.ceo, A)
    const posted = ok(await ceo.post(`/tip-pools/${pool.id}/post`, {}), 200)
    expect((posted.members as Array<{ shareCents: number }>).reduce((t, m) => t + m.shareCents, 0)).toBe(sales.A.tips)
    const none = await ceo.post(`/tip-pools/${pool.id}/pay`, {})
    expect(none.statusCode, none.body).toBe(422)
    expect(errCode(none)).toBe('BANK_ACCOUNT_REQUIRED')
    ok(await ceo.post(`/tip-pools/${pool.id}/pay`, { method: 'bank_transfer', bankAccountId: A.banks.main.id }), 200)
    const [e] = await sim.ledger.entriesBySource(A, `tippool.payout:${pool.id}`)
    expect(e!.lines.map((l) => [l.type, l.code, l.cents]).sort()).toEqual([['credit', A.banks.main.code, sales.A.tips], ['debit', '2095', sales.A.tips]])
  })
})

// ─── 5 November: wages paid ─────────────────────────────────────────────────

describe('wages paid (5 Nov)', () => {
  it('the CEO (own pay on it) is refused; B is 404; none named with two banks is 422; finance pays cash + bank', async () => {
    const { A, B } = sim
    sim.clock.at('2026-11-05', '11:00')
    const own = await sim.as(sim.ceo, A).post(`/hr/payroll/runs/${st.runId}/paid`, { bankAccountId: A.banks.main.id })
    expect(own.statusCode, own.body).toBe(403)
    expect(errCode(own)).toBe('OWN_PAY_IN_RUN')
    expect((await sim.as(B.finance, B).post(`/hr/payroll/runs/${st.runId}/paid`, { bankAccountId: B.banks.main.id })).statusCode).toBe(404)
    const fin = sim.as(A.finance, A)
    const none = await fin.post(`/hr/payroll/runs/${st.runId}/paid`, {})
    expect(none.statusCode, none.body).toBe(422)
    expect(errCode(none)).toBe('BANK_ACCOUNT_REQUIRED')
    const paid = ok(await fin.post(`/hr/payroll/runs/${st.runId}/paid`, { bankAccountId: A.banks.main.id }), 200)
    const slip = (k: string) => st.slips!.get(emps[k]!)!
    const cash = slip('bilal').netCents + slip('ammar').netCents
    const bank = slip('ayesha').netCents + slip('danish').netCents
    expect(paid.totals.payment).toMatchObject({ cash: { code: '1010', cents: cash, staff: 2 }, bank: { code: A.banks.main.code, cents: bank, staff: 2 } })
    const [e] = await sim.ledger.entriesBySource(A, `hr.payroll.payment:${st.runId}`)
    expect(e!.lines.map((l) => [l.type, l.code, l.cents]).sort()).toEqual([['credit', '1010', cash], ['credit', A.banks.main.code, bank], ['debit', '2020', cash + bank]].sort())
    expect(pktDay(e!.entryDate), 'dated the day it was paid').toBe('2026-11-05')
  })

  it('finance pays Farah\'s full & final from the second bank; B is 404; twice is 409', async () => {
    const { A, B } = sim
    expect((await sim.as(B.finance, B).post(`/hr/final-settlement/${st.fnfId}/paid`, { bankAccountId: B.banks.main.id })).statusCode).toBe(404)
    const toPay = ok(await sim.as(A.finance, A).get('/hr/final-settlement/to-pay'), 200) as Array<{ id: string }>
    expect(toPay.map((r) => r.id)).toEqual([st.fnfId])
    const fin = sim.as(A.finance, A)
    const paid = ok(await fin.post(`/hr/final-settlement/${st.fnfId}/paid`, { bankAccountId: A.banks.second.id }), 200)
    const net = (await sim.prisma.hrRecord.findUniqueOrThrow({ where: { id: st.fnfId! } })).amountCents!
    expect(paid.data._paidCents).toBe(net)
    const [e] = await sim.ledger.entriesBySource(A, `hr.final_settlement.payment:${st.fnfId}`)
    expect(e!.lines.map((l) => [l.type, l.code, l.cents]).sort()).toEqual([['credit', A.banks.second.code, net], ['debit', '2020', net]])
    expect((await fin.post(`/hr/final-settlement/${st.fnfId}/paid`, { bankAccountId: A.banks.second.id })).statusCode).toBe(409)
    expect(await credit(A, '2020'), '2020 wages payable is zero once everyone is paid').toBe(0)
  })
})

// ─── 10 November: statutory challans ────────────────────────────────────────

describe('EOBI, SESSI and salary-tax challans (10 Nov)', () => {
  it('each scheme\'s challan, then a salary-tax TOP-UP for the full & final (CPR rules)', async () => {
    const { A } = sim
    sim.clock.at('2026-11-10', '11:00')
    const fin = sim.as(A.finance, A)
    const s0 = ok(await fin.get('/accounting/statutory?from=2026-10&to=2026-10'), 200)
    const oct = s0.months[0]
    const fnfTax = st.fnf!['incomeTax']!
    expect(oct.salary_tax.accruedCents, 'payroll tax + the F&F tax').toBe(RS(41500) + fnfTax)
    expect(oct.eobi.accruedCents).toBe(await credit(A, '2043'))
    expect(oct.sessi.accruedCents).toBe(await credit(A, '2044'))
    const pay = (authority: string, paidCents: number, cprNumber?: string) => fin.post('/accounting/sales-tax-return/payments', {
      authority, ...PERIOD, paidCents, paidAt: '2026-11-10', method: 'bank_transfer', bankAccountId: A.banks.main.id, ...(cprNumber && { cprNumber }),
    })
    st.payments.push(ok(await pay('eobi', oct.eobi.accruedCents, 'PR02-OCT-01'), 201).id)
    st.payments.push(ok(await pay('sessi', oct.sessi.accruedCents, 'SESSI-OCT-01'), 201).id)
    // The payroll's salary tax first (no CPR needed on the first payment of the month)…
    st.payments.push(ok(await pay('salary_tax', RS(41500)), 201).id)
    // …then Farah's: a top-up needs its own CPR.
    const noCpr = await pay('salary_tax', fnfTax)
    expect(noCpr.statusCode, noCpr.body).toBe(422)
    expect(errCode(noCpr)).toBe('CPR_REQUIRED_FOR_TOP_UP')
    st.payments.push(ok(await pay('salary_tax', fnfTax, 'CPR-149-OCT-02'), 201).id)
    const again = await pay('salary_tax', 1_00, 'CPR-149-OCT-02')
    expect(again.statusCode, again.body).toBe(409)
    expect(errCode(again)).toBe('TAX_PAYMENT_EXISTS')

    const s1 = ok(await fin.get('/accounting/statutory?from=2026-10&to=2026-10'), 200)
    for (const e of await sim.prisma.journalEntry.findMany({ where: { tenantId: A.tenantId, lines: { some: { account: { code: { in: ['2042'] } } } } }, include: { lines: { include: { account: true } } } })) console.log('DBG2042', e.reference, e.entryDate.toISOString(), e.lines.map((l) => `${l.type} ${l.account.code} ${l.amountCents}`).join(' | '))
    for (const [k, code] of [['salary_tax', '2042'], ['eobi', '2043'], ['sessi', '2044']] as const) {
      const cell = s1.months[0][k]
      expect(cell.owedCents, `${k}: owed after the challans`).toBe(0)
      expect(cell.cleared).toBe(true)
      expect(await credit(A, code), `${code} = accrued − paid = statutory owed`).toBe(cell.accruedCents - cell.paidCents)
      expect(s1.totals[k].owedCents).toBe(await credit(A, code))
    }
    expect(s1.months[0].salary_tax.payments).toHaveLength(2)
  })
})

// ─── 12 November: the sales tax return ──────────────────────────────────────

describe('the October sales tax return (12 Nov)', () => {
  it('the return shows each authority\'s output, input, the client-withheld tax and the federal input claimable against SRB', async () => {
    const { A } = sim
    sim.clock.at('2026-11-12', '10:00')
    const r = ok(await sim.as(A.finance, A).get('/accounting/sales-tax-return?dateFrom=2026-10-01&dateTo=2026-10-31'), 200)
    const fbr = r.byAuthority.find((a: { key: string }) => a.key === 'fbr')
    const srb = r.byAuthority.find((a: { key: string }) => a.key === 'srb')
    expect(fbr.output.totalCents).toBe(sales.A.fbrTax)
    expect(fbr.input.totalCents).toBe(st.stockTaxCents)
    expect(srb.output.totalCents).toBe(sales.A.srbTax + RS(320))
    expect(srb.input.totalCents).toBe(st.srbInputCents)
    expect(srb.withheldByCustomersCents).toBe(st.withheldBySrbClientCents)
    expect(srb.federalInputClaimableCents, 'federal input on the chicken (H8 / H34)').toBeGreaterThan(0)
  })

  it('FBR: part of its own input set off, the rest paid; cross set-off against FBR is refused', async () => {
    const { A } = sim
    const fin = sim.as(A.finance, A)
    const cross = await fin.post('/accounting/sales-tax-return/payments', { authority: 'fbr', ...PERIOD, paidCents: 100, crossSetOffCents: 100, paidAt: '2026-11-12', bankAccountId: A.banks.main.id })
    expect(cross.statusCode).toBe(422)
    expect(errCode(cross)).toBe('NO_CROSS_SET_OFF')
    st.fbrInputSetOff = Math.floor(sales.A.fbrTax / 2)
    st.payments.push(ok(await fin.post('/accounting/sales-tax-return/payments', {
      authority: 'fbr', ...PERIOD, inputSetOffCents: st.fbrInputSetOff, paidCents: sales.A.fbrTax - st.fbrInputSetOff, paidAt: '2026-11-12', bankAccountId: A.banks.main.id, cprNumber: 'FBR-STR-OCT-1',
    }), 201).id)
    expect(await credit(A, '2030'), '2030 cleared by the FBR payment').toBe(0)
  })

  it('SRB: its input, the client-withheld tax and the federal input set off (above the pool → 422), then a top-up', async () => {
    const { A } = sim
    const fin = sim.as(A.finance, A)
    const pool = st.stockTaxCents - st.fbrInputSetOff // eligible federal input, what 1320 still holds once FBR is paid
    const srbOut = sales.A.srbTax + RS(320)
    const TOPUP = RS(100)
    const first = (crossSetOffCents: number) => fin.post('/accounting/sales-tax-return/payments', {
      authority: 'srb', ...PERIOD, inputSetOffCents: st.srbInputCents, customerWithheldSetOffCents: st.withheldBySrbClientCents, crossSetOffCents,
      paidCents: srbOut - st.srbInputCents - st.withheldBySrbClientCents - crossSetOffCents - TOPUP,
      paidAt: '2026-11-12', bankAccountId: A.banks.main.id, cprNumber: 'SRB-OCT-1',
    })
    const over = await first(pool + 1)
    expect(over.statusCode, over.body).toBe(422)
    expect(errCode(over)).toBe('CROSS_SETOFF_TOO_LARGE')
    st.crossSetOff = pool
    st.payments.push(ok(await first(pool), 201).id)
    // The second payment for the same month (the "missed" PKR 100): CPR rules.
    const topUp = (cprNumber?: string) => fin.post('/accounting/sales-tax-return/payments', {
      authority: 'srb', ...PERIOD, paidCents: TOPUP, paidAt: '2026-11-12', bankAccountId: A.banks.main.id, ...(cprNumber && { cprNumber }),
    })
    expect(errCode(await topUp())).toBe('CPR_REQUIRED_FOR_TOP_UP')
    expect(errCode(await topUp('SRB-OCT-1'))).toBe('TAX_PAYMENT_EXISTS')
    st.payments.push(ok(await topUp('SRB-OCT-2'), 201).id)

    expect(await credit(A, '2032'), '2032 cleared by the two SRB payments').toBe(0)
    expect(await sim.ledger.balanceOf(A, '1322'), 'SRB input used').toBe(0)
    expect(await sim.ledger.balanceOf(A, '1335'), 'client-withheld tax used').toBe(0)
    expect(await sim.ledger.balanceOf(A, '1320'), '1320 = federal input − FBR set-off − cross set-off').toBe(st.stockTaxCents - st.fbrInputSetOff - st.crossSetOff)

    const r = ok(await fin.get('/accounting/sales-tax-return?dateFrom=2026-10-01&dateTo=2026-10-31'), 200)
    const srb = r.byAuthority.find((a: { key: string }) => a.key === 'srb')
    expect(srb.crossSetOffForPeriodCents).toBe(st.crossSetOff)
    expect(srb.customerWithheldSetOffForPeriodCents).toBe(st.withheldBySrbClientCents)
    expect(srb.inputSetOffForPeriodCents).toBe(st.srbInputCents)
    expect(srb.paidForPeriodCents).toBe(srbOut - st.srbInputCents - st.withheldBySrbClientCents - st.crossSetOff)
  })

  it('the vendor withholding (2040) is paid over; 2040 = withheld − paid', async () => {
    const { A } = sim
    const fin = sim.as(A.finance, A)
    const withheld = await credit(A, '2040')
    st.payments.push(ok(await fin.post('/accounting/sales-tax-return/payments', {
      authority: 'wht', ...PERIOD, paidCents: withheld, paidAt: '2026-11-12', bankAccountId: A.banks.main.id, cprNumber: 'WHT-153-OCT',
    }), 201).id)
    const r = ok(await fin.get('/accounting/sales-tax-return?dateFrom=2026-10-01&dateTo=2026-10-31'), 200)
    const w = r.withholding.find((x: { key: string }) => x.key === 'wht')
    expect(w.account.totalCents).toBe(withheld)
    expect(w.paidForPeriodCents).toBe(withheld)
    expect(await credit(A, '2040')).toBe(w.account.totalCents - w.paidForPeriodCents)
  })
})

// ─── Month end ──────────────────────────────────────────────────────────────

describe('month-end checks', () => {
  it('both companies\' books balance; A\'s payroll, tax and tip accounts are where they should be', async () => {
    const { A, B } = sim
    await sim.ledger.assertBalanced(A)
    await sim.ledger.assertBalanced(B)
    expect(await credit(A, '2020'), '2020 wages payable').toBe(0)
    expect(await sim.ledger.balanceOf(A, '1350'), '1350 staff loans').toBe(0)
    for (const code of ['2030', '2032', '2040', '2042', '2043', '2044']) expect(await credit(A, code), code).toBe(0)
    expect(await credit(A, '2095'), 'A: 2095 = tips collected − paid').toBe(sales.A.tips - sales.A.tips)
    expect(await credit(B, '2095'), 'B: 2095 = its tip, not pooled yet').toBe(sales.B.tips)
    expect(await credit(B, '2032'), 'B never paid A\'s tax').toBe(sales.B.srbTax)
    // The trial balance lists one net figure per account and no zero rows.
    const tb = await sim.ledger.trialBalance(A)
    expect(tb.debitCents).toBe(tb.creditCents)
    expect(tb.rows.filter((r) => r.debitCents === 0 && r.creditCents === 0)).toEqual([])
    expect(tb.rows.filter((r) => r.debitCents !== 0 && r.creditCents !== 0)).toEqual([])
    expect(tb.rows.map((r) => r.code)).not.toContain('2020')
    expect((await sim.ledger.openFlags(A, 'posting_failed'))).toEqual([])
  })

  it('company B gets 404 on A\'s payroll run, settlement, loan and challans; B\'s list shows none of A\'s', async () => {
    const { A, B } = sim
    const finB = sim.as(B.finance, B)
    expect((await finB.get(`/hr/payroll/runs/${st.runId}`)).statusCode).toBe(404)
    expect((await hr(B).get(`/hr/payroll/runs/${st.runId}`)).statusCode).toBe(404)
    expect((await hr(B).get(`/hr/payroll/runs/${st.runId}/export.csv?kind=register`)).statusCode).toBe(404)
    expect((await hr(B).get(`/hr/records/final_settlement/${st.fnfId}`)).statusCode).toBe(404)
    expect((await hr(B).get(`/hr/records/loan/${st.loanId}`)).statusCode).toBe(404)
    expect((await finB.post('/hr/final-settlement/post-unposted', {})).json().posted).toEqual([])
    for (const id of st.payments) {
      const v = await finB.post(`/accounting/sales-tax-return/payments/${id}/void`, { reason: 'cross-company void try' })
      expect(v.statusCode, v.body).toBe(404)
    }
    const listB = ok(await finB.get('/accounting/sales-tax-return/payments?statutory=1'), 200)
    expect(listB.payments).toEqual([])
    // A tax payment from B naming A's bank is refused (cross-company attach).
    const attach = await finB.post('/accounting/sales-tax-return/payments', { authority: 'srb', ...PERIOD, paidCents: 100, paidAt: '2026-11-12', bankAccountId: A.banks.main.id })
    expect(attach.statusCode, attach.body).toBe(422)
    const statB = ok(await finB.get('/accounting/statutory?from=2026-10&to=2026-10'), 200)
    expect(statB.tenantId).toBe(B.tenantId)
    expect(statB.totals.salary_tax.accruedCents).toBe(0)
    expect((await finB.post(`/tip-pools/${st.poolId}/pay`, { method: 'cash' })).statusCode).toBe(404)
    // B's register has none of A's invoices.
    const regB = ok(await finB.get('/invoices'), 200)
    const rowsB = (Array.isArray(regB) ? regB : regB.invoices ?? regB.rows) as Array<{ tenantId: string }>
    expect(rowsB.length).toBeGreaterThan(0)
    expect(rowsB.every((r) => r.tenantId === B.tenantId)).toBe(true)
  })
})
