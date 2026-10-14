// The approvals inbox (owner decision D3, 2026-10-11).
//
//   - Two companies: company B's approver never sees company A's items, and
//     the counts are per company (the "All companies" view adds them up).
//   - Every role sees only the types it can approve (the module's own
//     approve-route roles; HR steps per record).
//   - The inbox only READS: an item's buttons call the module's EXISTING
//     route, whose own guard still applies (wrong role 403, other company 404).
//   - Module access still applies through the module's own queue route.
//   - The plugin works registered under /api/v1 (registerApprovalsPlugin).
//   - Finance wave B types (fixed-asset requests, inter-company transfers, bad
//     debts, Raast voids, GRNI write-offs, cash requests for the HOD, stock
//     differences): per company, CEO-only buttons through the module routes,
//     on_account_client PARKED (lists nothing).
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined) }
})
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return { ...real, sendEmail: vi.fn(async () => undefined) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { siteLayoutRoutes } = await import('../src/modules/siteLayouts/routes.js')
const { procurementRoutes } = await import('../src/modules/procurement/routes.js')
const { recipeRoutes } = await import('../src/modules/recipes/routes.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { tipPoolRoutes } = await import('../src/modules/tipPools/routes.js')
const { stockTransferRoutes } = await import('../src/modules/stockTransfers/routes.js')
const { trustopsRoutes } = await import('../src/modules/trustops/routes.js')
const { fixedAssetRoutes } = await import('../src/modules/fixedAssets/routes.js')
const { receivableRoutes } = await import('../src/modules/receivables/routes.js')
const { reconciliationRoutes } = await import('../src/modules/reconciliation/routes.js')
const { grniRoutes } = await import('../src/modules/procurement/grniRoutes.js')
const { intercompanyRoutes } = await import('../src/modules/intercompany/routes.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { registerApprovalsPlugin, APPROVAL_PROVIDERS, collectApprovals } = await import('../src/modules/approvals/index.js')
const { ALL_ROLES } = await import('../src/lib/roles.js')

const stamp = Date.now()
const P = `apx${stamp}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}
/** The ids of the fixtures per company, per type. */
const ids: Record<'A' | 'B', Record<string, string>> = { A: {}, B: {} }
/** The A → B inter-company transfer waiting for the CEO (it belongs to both companies). */
let icTransferId = ''

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@apx.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
  return U[key]!
}
function auth(key: string, extra: Record<string, string> = {}) {
  const u = U[key]!
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}`, ...extra }
}
const inbox = (key: string, extra: Record<string, string> = {}, q = '') =>
  app.inject({ method: 'GET', url: `/api/v1/approvals${q}`, headers: auth(key, extra) })
const counts = (key: string, extra: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/api/v1/approvals/counts', headers: auth(key, extra) })

type Inbox = {
  total: number
  types: Array<{ type: string; count: number; error?: true }>
  items: Array<{ type: string; id: string; tenantId: string | null; companyName?: string | null; actions: Array<{ kind: string; method: string; path: string; body: Record<string, unknown>; input?: { field: string; required: boolean }; disabledReason?: string }> }>
}
const countOf = (b: Inbox, type: string) => b.types.find((t) => t.type === type)?.count

/** One of everything waiting, in company `co`. */
async function seedCompany(co: 'A' | 'B', hod: string, owner: string) {
  const tenantId = T[co]
  const concept = await prisma.concept.create({ data: { name: `${P} brand ${co}`, slug: `${P}-brand-${co.toLowerCase()}`, type: 'restaurant', tenantId } })

  // New login, invited and pending.
  const pending = await prisma.user.create({
    data: { name: `${P} pending ${co}`, email: `${P}.pending.${co}@apx.pk`, phone: `0300${String(stamp).slice(-6)}${co === 'A' ? 1 : 2}`, password: 'x', role: 'cashier', tenantId, isActive: true, accountStatus: 'pending' },
  })
  ids[co]['staff_login'] = pending.id

  // A website change submitted for approval (the brand's home page).
  const layout = await prisma.siteLayout.create({
    data: { slug: `brand:${concept.slug}`, title: `${co} home`, tenantId, blocks: [], draftBlocks: [], draftStatus: 'pending', submittedAt: new Date() },
  })
  ids[co]['storefront_publish'] = layout.id

  // A purchase order over the threshold.
  const supplier = await prisma.supplier.create({ data: { name: `${P} supplier ${co}`, tenantId } })
  const po = await prisma.purchaseOrder.create({ data: { supplierId: supplier.id, status: 'pending_approval', totalCents: 500_000_00, createdBy: U[hod]!.id } })
  ids[co]['purchase_order'] = po.id

  // Recipes waiting on sign-off: one a manager submitted, one the owner did.
  const r1 = await prisma.recipe.create({ data: { status: 'pending_approval', pendingMenuItem: { conceptId: concept.id, name: `${P} plate ${co}` }, submittedById: U[hod]!.id, submittedAt: new Date() } })
  const r2 = await prisma.recipe.create({ data: { status: 'pending_approval', pendingMenuItem: { conceptId: concept.id, name: `${P} own ${co}` }, submittedById: U[owner]!.id, submittedAt: new Date() } })
  ids[co]['recipe'] = r1.id
  ids[co]['recipe_own'] = r2.id

  // An attendance correction waiting on the reporting manager (HOD step).
  const boss = await prisma.hrEmployee.create({ data: { tenantId, employeeCode: `${P}-${co}-1`, fullName: `Boss ${co}`, userId: U[hod]!.id } })
  const cook = await prisma.hrEmployee.create({ data: { tenantId, employeeCode: `${P}-${co}-2`, fullName: `Cook ${co}`, managerId: boss.id } })
  const rec = await prisma.hrRecord.create({
    data: { tenantId, section: 'attendance_correction', formVersion: 1, employeeId: cook.id, startDate: new Date('2026-10-01'), status: 'submitted', currentStep: 0, data: { type: 'missed_punch' } },
  })
  ids[co]['hr_request'] = rec.id

  // A payroll run waiting on approval.
  const run = await prisma.hrPayrollRun.create({ data: { tenantId, period: '2026-09', settings: {}, totals: { employees: 2, grossCents: 9_000_00, netCents: 8_000_00 } } })
  ids[co]['payroll_run'] = run.id

  // A posted tip pool waiting to be paid out.
  const pool = await prisma.tipPool.create({ data: { tenantId, conceptId: concept.id, name: `${P} week ${co}`, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-08'), status: 'posted', totalTipsCents: 12_000_00 } })
  ids[co]['tip_pool'] = pool.id

  // A stock transfer requested between two of the company's kitchens.
  const l1 = await prisma.location.create({ data: { slug: `${P}-${co.toLowerCase()}-1`, name: `${co} Kitchen 1`, tenantId } })
  const l2 = await prisma.location.create({ data: { slug: `${P}-${co.toLowerCase()}-2`, name: `${co} Kitchen 2`, tenantId } })
  const item = await prisma.inventoryItem.create({ data: { name: `${P} flour ${co}`, unit: 'kg', tenantId } })
  const tr = await prisma.stockTransfer.create({ data: { inventoryItemId: item.id, fromLocationId: l1.id, toLocationId: l2.id, quantity: 5, unit: 'kg', requestedById: U[hod]!.id, status: 'requested' } })
  ids[co]['stock_transfer'] = tr.id

  // A cash voucher the HOD signed, waiting for the director.
  const cashBox = await prisma.pettyCashBox.create({ data: { tenantId, name: `${P} box ${co}`, custodianId: U[hod]!.id, floatCents: 100_000_00 } })
  const voucher = await prisma.cashVoucher.create({
    data: {
      tenantId, seq: 1, number: 'CV-00001', voucherDate: new Date(), payeeName: `${P} payee ${co}`, purpose: 'Site visit',
      amountCents: 5_000_00, boxId: cashBox.id, status: 'hod_signed', preparedById: U[hod]!.id, hodSignedById: U[hod]!.id, hodSignedAt: new Date(),
    },
  })
  ids[co]['cash_voucher'] = voucher.id

  // ── Finance wave B ──
  const asker = co === 'A' ? U['finance']!.id : U['adminB']!.id
  // A disposal request on a fixed asset, waiting for the CEO.
  const asset = await prisma.fixedAsset.create({
    data: { tenantId, name: `${P} oven ${co}`, category: 'kitchen_equipment', assetTag: `FA-${co}-1`, acquiredAt: new Date('2026-01-10'), costCents: 400_000_00, usefulLifeMonths: 60 },
  })
  const faEvent = await prisma.fixedAssetEvent.create({
    data: { tenantId, assetId: asset.id, kind: 'disposal', status: 'pending', effectiveDate: new Date(), payload: { disposalKind: 'scrap' }, amountCents: 0, reason: 'Burnt out', requestedById: asker },
  })
  ids[co]['fixed_asset_request'] = faEvent.id
  // A bad-debt write-off asked of the CEO.
  const inv = await prisma.receivableInvoice.create({
    data: { tenantId, conceptId: concept.id, number: `AR-${co}-0001`, customerName: `${P} client ${co}`, issueDate: new Date('2026-08-01'), dueDate: new Date('2026-08-31'), description: 'Catering', amountCents: 50_000_00 },
  })
  const wo = await prisma.receivableWriteOff.create({
    data: { tenantId, invoiceId: inv.id, amountCents: 50_000_00, reason: 'Client closed down, nothing to recover', requestedById: asker, status: 'requested' },
  })
  ids[co]['bad_debt'] = wo.id
  // A Raast receipt finance asked the CEO to void (its sale was never booked).
  const bank = await prisma.bankAccount.create({ data: { tenantId, name: `${P} Raast ${co}`, accountCode: '1020' } })
  const ord = await prisma.order.create({
    data: { conceptId: concept.id, source: 'pos', status: 'cancelled', totalCents: 2_000_00, placedAt: new Date(), externalId: `${P}-raast-${co}` },
  })
  const raast = await prisma.raastReceipt.create({
    data: {
      tenantId, orderId: ord.id, conceptId: concept.id, bankAccountId: bank.id, ledgerCode: '1020', amountCents: 2_000_00, dueCents: 2_000_00,
      bankRef: `${co}123456789`, bankRefRaw: `${co}123456789`, status: 'provisional', confirmedVia: 'cashier', confirmedAt: new Date(), cashierVerified: true,
      idempotencyKey: `${P}-raast-${co}`, createdById: asker,
      voidRequestedAt: new Date(), voidRequestedById: asker, voidRequestReason: 'Cancelled before the money arrived',
    },
  })
  ids[co]['raast_void'] = raast.id
  // A delivery the supplier will never bill — write-off asked of the CEO.
  const receipt = await prisma.goodsReceipt.create({ data: { tenantId, supplierId: supplier.id, receivedById: U[hod]!.id, receivedAt: new Date('2026-09-01') } })
  const grLine = await prisma.goodsReceiptLine.create({
    data: { receiptId: receipt.id, description: `${P} sample crates ${co}`, receivedQty: 4, writeOffRequestedAt: new Date(), writeOffRequestedById: asker, writeOffReason: 'Free samples' },
  })
  ids[co]['grni_writeoff'] = grLine.id
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Approvals Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Approvals Co B', slug: `${P}-b` } })).id
  for (const role of ALL_ROLES) await mkUser(role, role, [T.A])
  await mkUser('adminB', 'admin', [T.B])
  await mkUser('ownerB', 'owner', [T.B])
  await mkUser('hodA', 'boh_management', [T.A])
  await mkUser('hodB', 'boh_management', [T.B])
  await mkUser('ceoBoth', 'admin', [T.A, T.B])
  await mkUser('ownerNoPayroll', 'owner', [T.A], { moduleDeny: ['payroll'] })
  for (const t of [T.A, T.B]) await ensureChartOfAccounts(t)
  await seedCompany('A', 'hodA', 'owner')
  await seedCompany('B', 'hodB', 'ownerB')
  icTransferId = (await prisma.intercompanyTransfer.create({
    data: { tenantId: T.A, counterpartyTenantId: T.B, kind: 'charge', status: 'submitted', amountCents: 75_000_00, entryDate: new Date(), memo: 'Shared kitchen staff, September', preparedById: U['finance']!.id },
  })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' })
    await api.register(siteLayoutRoutes, { prefix: '/site-layouts' })
    await api.register(procurementRoutes, { prefix: '/procurement' })
    await api.register(recipeRoutes, { prefix: '/recipes' })
    await api.register(hrRoutes, { prefix: '/hr' })
    await api.register(tipPoolRoutes, { prefix: '/tip-pools' })
    await api.register(stockTransferRoutes, { prefix: '/stock-transfers' })
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await api.register(fixedAssetRoutes, { prefix: '/accounting/fixed-assets' })
    await api.register(receivableRoutes, { prefix: '/accounting/receivables' })
    await api.register(intercompanyRoutes, { prefix: '/accounting/intercompany' })
    await api.register(reconciliationRoutes, { prefix: '/reconciliation' })
    await api.register(grniRoutes, { prefix: '/procurement/grni' })
    // No /accounting/stock-differences here: the type answers 404 → not listed.
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

describe('two companies', () => {
  it("company A's CEO sees one of every type, all company A's; company B's CEO sees only B's", async () => {
    const a = await inbox('admin')
    expect(a.statusCode).toBe(200)
    const body = a.json() as Inbox
    // The CEO approves every type except HR steps that are not theirs.
    expect(body.types.map((t) => t.type).sort()).toEqual([
      'bad_debt', 'cash_voucher', 'fixed_asset_request', 'grni_writeoff', 'hr_request', 'intercompany_transfer', 'payroll_run',
      'purchase_order', 'raast_void', 'recipe', 'staff_login', 'stock_transfer', 'storefront_publish', 'tip_pool',
    ])
    for (const t of ['staff_login', 'storefront_publish', 'purchase_order', 'payroll_run', 'tip_pool', 'stock_transfer', 'cash_voucher',
      'fixed_asset_request', 'bad_debt', 'raast_void', 'grni_writeoff']) {
      expect(countOf(body, t), t).toBe(1)
      expect(body.items.find((i) => i.type === t)?.id, t).toBe(ids.A[t])
    }
    // Both recipes: the CEO may sign off even the owner's own.
    expect(countOf(body, 'recipe')).toBe(2)
    // The HOD step is the reporting manager's — never listed as a CEO override.
    expect(countOf(body, 'hr_request')).toBe(0)
    expect(body.items.every((i) => i.tenantId === T.A)).toBe(true)
    expect(body.items.every((i) => i.companyName === 'Approvals Co A')).toBe(true)
    expect(body.total).toBe(body.types.reduce((n, t) => n + t.count, 0))
    // The A → B transfer is listed in A's view under A (a party).
    expect(body.items.filter((i) => i.type === 'intercompany_transfer').map((i) => i.id)).toEqual([icTransferId])

    const b = (await inbox('adminB')).json() as Inbox
    const bIds = new Set(b.items.map((i) => i.id))
    for (const id of Object.values(ids.A)) expect(bIds.has(id)).toBe(false)
    expect(b.items.every((i) => i.tenantId === T.B)).toBe(true)
    expect(countOf(b, 'purchase_order')).toBe(1)
  })

  it('counts are per company in view; "All companies" adds both up', async () => {
    const one = (await counts('ceoBoth')).json() as Inbox
    expect(countOf(one, 'purchase_order')).toBe(1)
    expect(countOf(one, 'staff_login')).toBe(1)
    expect(countOf(one, 'cash_voucher')).toBe(1)
    const both = (await counts('ceoBoth', { 'x-servd-portfolio': '1' })).json() as Inbox
    expect(countOf(both, 'purchase_order')).toBe(2)
    expect(countOf(both, 'stock_transfer')).toBe(2)
    expect(countOf(both, 'cash_voucher')).toBe(2)
    expect(both.total).toBeGreaterThan(one.total)
    // /counts carries no items.
    expect((both as unknown as { items?: unknown }).items).toBeUndefined()
    const full = (await inbox('ceoBoth', { 'x-servd-portfolio': '1' })).json() as Inbox
    expect(new Set(full.items.map((i) => i.tenantId))).toEqual(new Set([T.A, T.B]))
  })

  it("company B's HOD never sees company A's HR request; A's HOD does", async () => {
    const a = (await inbox('hodA')).json() as Inbox
    expect(a.items.filter((i) => i.type === 'hr_request').map((i) => i.id)).toEqual([ids.A['hr_request']])
    const b = (await inbox('hodB')).json() as Inbox
    expect(b.items.filter((i) => i.type === 'hr_request').map((i) => i.id)).toEqual([ids.B['hr_request']])
  })
})

describe('each role sees only the types it can approve', () => {
  const typesOf = async (key: string) => ((await counts(key)).json() as Inbox).types.map((t) => t.type).sort()

  it('matches each module\'s approve-route roles', async () => {
    expect(await typesOf('owner')).toEqual(['hr_request', 'payroll_run', 'recipe', 'stock_transfer', 'tip_pool'])
    expect(await typesOf('management')).toEqual(['hr_request', 'payroll_run', 'stock_transfer'])
    expect(await typesOf('hr')).toEqual(['hr_request'])
    expect(await typesOf('fnb_manager')).toEqual(['stock_transfer'])
    expect(await typesOf('foh_management')).toEqual(['stock_transfer'])
    // The HOD: their team's request, and the kitchen's transfers.
    expect(await typesOf('hodA')).toEqual(['hr_request', 'stock_transfer'])
    for (const r of ['cashier', 'foh', 'boh', 'kitchen', 'expediter', 'procurement', 'finance', 'marketing', 'brand_manager', 'it']) {
      expect(await typesOf(r), r).toEqual([])
    }
  })

  it('every listed type is one the registry says the role approves (or an HR step it holds)', async () => {
    for (const role of ALL_ROLES) {
      const body = (await inbox(role)).json() as Inbox
      for (const t of body.types) {
        const p = APPROVAL_PROVIDERS.find((x) => x.type === t.type)!
        if (p.approverRoles) expect(p.approverRoles as readonly string[], `${role} ${t.type}`).toContain(role)
      }
      for (const i of body.items) expect(body.types.some((t) => t.type === i.type)).toBe(true)
    }
  })

  it('an owner never sees a recipe they submitted themselves', async () => {
    const body = (await inbox('owner')).json() as Inbox
    const recipeIds = body.items.filter((i) => i.type === 'recipe').map((i) => i.id)
    expect(recipeIds).toEqual([ids.A['recipe']])
    expect(recipeIds).not.toContain(ids.A['recipe_own'])
  })

  it('module access still applies: an owner without the payroll module gets no tip pools', async () => {
    expect(await typesOf('ownerNoPayroll')).not.toContain('tip_pool')
    expect(await typesOf('owner')).toContain('tip_pool')
  })

  it('?type= narrows the items, not the counts', async () => {
    const body = (await inbox('admin', {}, '?type=purchase_order')).json() as Inbox
    expect(body.items.map((i) => i.type)).toEqual(['purchase_order'])
    expect(body.types.length).toBeGreaterThan(1)
    expect((await inbox('admin', {}, '?type=nope')).statusCode).toBe(400)
  })

  it('needs a staff session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/approvals' })).statusCode).toBe(401)
  })
})

describe('inline actions call the module\'s existing routes', () => {
  const act = (key: string, a: { method: string; path: string; body: Record<string, unknown> }, extra: Record<string, unknown> = {}) =>
    app.inject({ method: a.method as 'POST', url: `/api/v1${a.path}`, headers: auth(key), payload: { ...a.body, ...extra } })

  it('the existing guards still apply: other roles 403, other company 404, the CEO approves', async () => {
    const body = (await inbox('admin')).json() as Inbox
    const po = body.items.find((i) => i.type === 'purchase_order')!
    const approve = po.actions.find((a) => a.kind === 'approve')!
    expect(approve.path).toBe(`/procurement/purchase-orders/${ids.A['purchase_order']}/approve`)
    const reject = po.actions.find((a) => a.kind === 'reject')!
    expect(reject.input).toEqual(expect.objectContaining({ field: 'reason', required: true }))

    // Not an approver of POs (the module says so, not the inbox).
    expect((await act('owner', approve)).statusCode).toBe(403)
    // Company B's CEO: A's PO does not exist for them.
    expect((await act('adminB', approve)).statusCode).toBe(404)
    // A's CEO approves through the procurement route.
    expect((await act('admin', approve)).statusCode).toBe(200)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: ids.A['purchase_order']! } })).status).toBe('approved')
    // …and it leaves the inbox: the module's status is the only record.
    const after = (await counts('admin')).json() as Inbox
    expect(countOf(after, 'purchase_order')).toBe(0)
  })

  it('the HOD approves their step through /hr/records/:section/:id/decide; HR takes the next step', async () => {
    const body = (await inbox('hodA')).json() as Inbox
    const item = body.items.find((i) => i.type === 'hr_request')!
    const approve = item.actions.find((a) => a.kind === 'approve')!
    expect(approve.path).toBe(`/hr/records/attendance_correction/${ids.A['hr_request']}/decide`)
    // The other company's HOD cannot act on it.
    expect((await act('hodB', approve)).statusCode).toBe(404)
    expect((await act('hodA', approve)).statusCode).toBe(200)
    const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id: ids.A['hr_request']! } })
    expect(rec.currentStep).toBe(1)
    expect(((await inbox('hodA')).json() as Inbox).items.some((i) => i.id === rec.id)).toBe(false)
    expect(((await inbox('hr')).json() as Inbox).items.some((i) => i.id === rec.id)).toBe(true)
  })

  it('stock transfers: a cashier cannot approve; the F&B manager can', async () => {
    const body = (await inbox('fnb_manager')).json() as Inbox
    const item = body.items.find((i) => i.type === 'stock_transfer')!
    const approve = item.actions.find((a) => a.kind === 'approve')!
    expect((await act('cashier', approve)).statusCode).toBe(403)
    expect((await act('fnb_manager', approve)).statusCode).toBe(200)
    expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id: ids.A['stock_transfer']! } })).status).toBe('approved')
  })

  it('new logins: approve goes through PATCH /auth/staff/:id/approve (CEO only)', async () => {
    const body = (await inbox('admin')).json() as Inbox
    const item = body.items.find((i) => i.type === 'staff_login')!
    const approve = item.actions.find((a) => a.kind === 'approve')!
    expect(approve).toMatchObject({ method: 'PATCH', path: `/auth/staff/${ids.A['staff_login']}/approve` })
    expect((await act('management', approve)).statusCode).toBe(403)
    expect((await act('adminB', approve)).statusCode).toBe(404)
    expect((await act('admin', approve)).statusCode).toBe(200)
  })
})

describe('review fixes', () => {
  it('a company-less legacy login has no inline Approve (Workforce picks its company first); Reject stays', async () => {
    const legacy = await prisma.user.create({
      data: { name: `${P} legacy`, email: `${P}.legacy@apx.pk`, password: 'x', role: 'manager', tenantId: null, isActive: true, accountStatus: 'pending' },
    })
    try {
      const body = (await inbox('admin')).json() as Inbox
      const item = body.items.find((i) => i.type === 'staff_login' && i.id === legacy.id)!
      expect(item).toBeTruthy()
      expect(item.tenantId).toBeNull()
      const approve = item.actions.find((a) => a.kind === 'approve')!
      expect(approve.disabledReason).toMatch(/company/i)
      const reject = item.actions.find((a) => a.kind === 'reject')!
      expect(reject.disabledReason).toBeUndefined()
      // The route itself refuses too, so a stale page or a direct call can't
      // activate a login that belongs to no company.
      const direct = await app.inject({ method: 'PATCH', url: `/api/v1${approve.path}`, headers: auth('admin'), payload: approve.body })
      expect(direct.statusCode).toBe(422)
      expect(direct.json().error.code).toBe('LOGIN_NEEDS_COMPANY')
      expect((await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } })).accountStatus).toBe('pending')
      // A login that has a company keeps its live Approve.
      const withCompany = await prisma.user.create({
        data: { name: `${P} pending A2`, email: `${P}.pending.a2@apx.pk`, password: 'x', role: 'cashier', tenantId: T.A, isActive: true, accountStatus: 'pending' },
      })
      try {
        const again = (await inbox('admin')).json() as Inbox
        const live = again.items.find((i) => i.id === withCompany.id)!
        expect(live.actions.find((a) => a.kind === 'approve')!.disabledReason).toBeUndefined()
      } finally {
        await prisma.user.delete({ where: { id: withCompany.id } })
      }
    } finally {
      await prisma.user.delete({ where: { id: legacy.id } })
    }
  })

  it("a HOD in two companies sees both companies' HR steps, matching /hr/team's count", async () => {
    await mkUser('hodBoth', 'boh_management', [T.A, T.B])
    const recIds: string[] = []
    for (const co of ['A', 'B'] as const) {
      const tenantId = T[co]
      const boss = await prisma.hrEmployee.create({ data: { tenantId, employeeCode: `${P}-${co}-hb`, fullName: `Head ${co}`, userId: U['hodBoth']!.id } })
      const cook = await prisma.hrEmployee.create({ data: { tenantId, employeeCode: `${P}-${co}-hc`, fullName: `Prep ${co}`, managerId: boss.id } })
      const rec = await prisma.hrRecord.create({
        data: { tenantId, section: 'attendance_correction', formVersion: 1, employeeId: cook.id, startDate: new Date('2026-10-02'), status: 'submitted', currentStep: 0, data: { type: 'missed_punch' } },
      })
      recIds.push(rec.id)
    }
    const team = await app.inject({ method: 'GET', url: '/api/v1/hr/team', headers: auth('hodBoth') })
    expect(team.statusCode).toBe(200)
    expect((team.json() as { pendingApprovals: number }).pendingApprovals).toBe(2)

    // Company A active (not "All companies"): both steps still listed.
    const c = (await counts('hodBoth')).json() as Inbox
    expect(countOf(c, 'hr_request')).toBe(2)
    const body = (await inbox('hodBoth')).json() as Inbox
    const hr = body.items.filter((i) => i.type === 'hr_request')
    expect(hr.map((i) => i.id).sort()).toEqual([...recIds].sort())
    expect(new Set(hr.map((i) => i.companyName))).toEqual(new Set(['Approvals Co A', 'Approvals Co B']))
  })

  it("other types: the user's other companies are counted as `elsewhere`, never listed; a stranger company is neither", async () => {
    const base = APPROVAL_PROVIDERS.find((p) => p.type === 'purchase_order')!
    const row = (id: string, tenantId: string) => ({ type: base.type, id, tenantId, title: id, facts: [], waitingSince: null, link: null, actions: [] })
    const rows = [row('a', T.A), row('b', T.B), row('c', 'not-a-member-company')]
    const ctx = { user: { id: U['ceoBoth']!.id, role: 'admin' as never }, tenantIds: [T.A], memberTenantIds: [T.A, T.B], read: async () => null }

    const viewScoped = await collectApprovals(ctx, { providers: [{ ...base, load: async () => rows.map((r) => ({ ...r })) }] })
    expect(viewScoped.items.map((i) => i.id)).toEqual(['a'])
    expect(viewScoped.types[0]).toMatchObject({ count: 1, elsewhere: 1 })
    expect(viewScoped.elsewhere).toBe(1)

    const spanning = await collectApprovals(ctx, { providers: [{ ...base, spansMemberCompanies: true, load: async () => rows.map((r) => ({ ...r })) }] })
    expect(spanning.items.map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect(spanning.types[0]!.elsewhere).toBeUndefined()
    expect(spanning.elsewhere).toBe(0)
  })

  it('stock transfers point at the inbox itself (no admin transfer screen exists)', async () => {
    const body = (await counts('fnb_manager')).json() as Inbox & { types: Array<{ type: string; link: string }> }
    expect(body.types.find((t) => t.type === 'stock_transfer')!.link).toBe('/ceo/approvals?type=stock_transfer')
  })
})

describe('finance wave B types', () => {
  const NEW_CEO_TYPES = ['fixed_asset_request', 'bad_debt', 'raast_void', 'grni_writeoff'] as const
  const act = (key: string, a: { method: string; path: string; body: Record<string, unknown> }, extra: Record<string, unknown> = {}) =>
    app.inject({ method: a.method as 'POST', url: `/api/v1${a.path}`, headers: auth(key), payload: { ...a.body, ...extra } })

  it("each new type is A's CEO's for A's rows only, B's CEO's for B's; counts per company", async () => {
    const a = (await inbox('admin')).json() as Inbox
    const b = (await inbox('adminB')).json() as Inbox
    for (const t of NEW_CEO_TYPES) {
      expect(a.items.filter((i) => i.type === t).map((i) => i.id), t).toEqual([ids.A[t]])
      expect(b.items.filter((i) => i.type === t).map((i) => i.id), t).toEqual([ids.B[t]])
    }
    // The CEO of both companies: one each per company in view, both in "All companies".
    const one = (await counts('ceoBoth')).json() as Inbox
    const both = (await counts('ceoBoth', { 'x-servd-portfolio': '1' })).json() as Inbox
    for (const t of NEW_CEO_TYPES) {
      expect(countOf(one, t), t).toBe(1)
      expect(countOf(both, t), t).toBe(2)
    }
    // The inter-company transfer is ONE item, in whichever party is in view.
    expect(countOf(one, 'intercompany_transfer')).toBe(1)
    expect(countOf(both, 'intercompany_transfer')).toBe(1)
    expect(b.items.find((i) => i.type === 'intercompany_transfer')).toMatchObject({ id: icTransferId, tenantId: T.B })
  })

  it('an inter-company transfer is acted on only by a CEO in BOTH companies (else the buttons are disabled)', async () => {
    const onlyA = ((await inbox('admin')).json() as Inbox).items.find((i) => i.id === icTransferId)!
    for (const a of onlyA.actions) expect(a.disabledReason).toMatch(/both companies/)
    const ceo = ((await inbox('ceoBoth')).json() as Inbox).items.find((i) => i.id === icTransferId)!
    const approve = ceo.actions.find((a) => a.kind === 'approve')!
    expect(approve.disabledReason).toBeUndefined()
    expect(approve.path).toBe(`/accounting/intercompany/transfers/${icTransferId}/approve`)
    // The module route is the guard: a CEO of one company is refused.
    expect((await act('admin', approve)).statusCode).toBe(403)
  })

  it('a finance user never sees an Approve; the module routes refuse finance', async () => {
    const types = ((await counts('finance')).json() as Inbox).types.map((t) => t.type)
    for (const t of [...NEW_CEO_TYPES, 'intercompany_transfer', 'stock_difference']) expect(types).not.toContain(t)
    const item = ((await inbox('admin')).json() as Inbox).items.find((i) => i.type === 'bad_debt')!
    const approve = item.actions.find((a) => a.kind === 'approve')!
    expect(approve).toMatchObject({ method: 'POST', path: `/accounting/receivables/write-offs/${ids.A['bad_debt']}/approve` })
    expect((await act('finance', approve)).statusCode).toBe(403)
    expect((await act('adminB', approve)).statusCode).toBe(404)
  })

  it("acting calls the module's own route: the CEO sends back A's GRNI write-off; it leaves the inbox", async () => {
    const item = ((await inbox('admin')).json() as Inbox).items.find((i) => i.type === 'grni_writeoff')!
    const reject = item.actions.find((a) => a.kind === 'reject')!
    expect(reject).toMatchObject({ path: `/procurement/grni/${ids.A['grni_writeoff']}/write-off/reject`, input: { field: 'note', required: true } })
    expect((await act('adminB', reject, { note: 'not yours' })).statusCode).toBe(404)
    expect((await act('admin', reject, { note: 'The supplier will bill it next week' })).statusCode).toBe(200)
    expect((await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: ids.A['grni_writeoff']! } })).writeOffRequestedAt).toBeNull()
    expect(countOf((await counts('admin')).json() as Inbox, 'grni_writeoff')).toBe(0)
    // The fixed-asset request and the Raast void call their modules' routes too.
    const all = ((await inbox('admin')).json() as Inbox).items
    expect(all.find((i) => i.type === 'fixed_asset_request')!.actions.map((a) => a.path)).toEqual([
      `/accounting/fixed-assets/requests/${ids.A['fixed_asset_request']}/approve`, `/accounting/fixed-assets/requests/${ids.A['fixed_asset_request']}/reject`,
    ])
    const raast = all.find((i) => i.type === 'raast_void')!
    expect(raast.actions.find((a) => a.kind === 'approve')).toMatchObject({ path: `/reconciliation/raast/receipts/${ids.A['raast_void']}/void`, input: { field: 'reason', required: true } })
    expect(raast.actions.find((a) => a.kind === 'reject')).toMatchObject({ path: `/reconciliation/raast/receipts/${ids.A['raast_void']}/void-request/reject` })
  })

  it('on_account_client is PARKED: no provider, it lists nothing', async () => {
    expect(APPROVAL_PROVIDERS.some((p) => p.type === 'on_account_client')).toBe(false)
    const body = (await inbox('admin', {}, '?type=on_account_client')).json() as Inbox
    expect(body.items).toEqual([])
    expect(body.types.some((t) => t.type === 'on_account_client')).toBe(false)
  })

  it("cash requests: labelled 'Cash requests'; Approve is disabled for the login that signed as HOD", async () => {
    const box = await prisma.pettyCashBox.findFirstOrThrow({ where: { tenantId: T.A } })
    const own = await prisma.cashVoucher.create({
      data: {
        tenantId: T.A, seq: 2, number: 'CV-00002', voucherDate: new Date(), payeeName: `${P} payee own`, purpose: 'Signed by the CEO as HOD',
        amountCents: 1_000_00, boxId: box.id, status: 'hod_signed', preparedById: U['finance']!.id, hodSignedById: U['admin']!.id, hodSignedAt: new Date(),
      },
    })
    const body = (await inbox('admin')).json() as Inbox & { types: Array<{ type: string; label: string }> }
    expect(body.types.find((t) => t.type === 'cash_voucher')!.label).toBe('Cash requests')
    const mine = body.items.find((i) => i.id === own.id)!
    expect(mine.actions.find((a) => a.kind === 'approve')!.disabledReason).toMatch(/HOD/)
    expect(mine.actions.find((a) => a.kind === 'reject')!.disabledReason).toBeUndefined()
    const other = body.items.find((i) => i.id === ids.A['cash_voucher'])!
    expect(other.actions.find((a) => a.kind === 'approve')!.disabledReason).toBeUndefined()
    await prisma.cashVoucher.delete({ where: { id: own.id } })
  })

  it("cash_request_hod: the holder's line manager signs from the inbox; nobody else's request is theirs", async () => {
    // The line manager is a non-keeper login (a head chef, role boh): the HR reporting line decides.
    const lead = await mkUser('chefLead', 'boh', [T.A])
    const holder = await mkUser('chefHolder', 'kitchen', [T.A])
    const stranger = await mkUser('chefOther', 'boh', [T.A])
    const leadEmp = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-lead`, fullName: 'Lead chef', userId: lead.id } })
    await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-holder`, fullName: 'Line cook', userId: holder.id, managerId: leadEmp.id } })
    await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-other`, fullName: 'Other chef', userId: stranger.id } })
    const draft = await prisma.cashVoucher.create({
      data: {
        tenantId: T.A, seq: 3, number: 'CV-00003', voucherDate: new Date(), payeeName: 'Line cook', payeeUserId: holder.id, purpose: 'Market run for herbs',
        amountCents: 3_000_00, status: 'draft', preparedById: holder.id,
      },
    })
    try {
      const body = (await inbox('chefLead')).json() as Inbox
      const item = body.items.find((i) => i.type === 'cash_request_hod')!
      expect(item).toMatchObject({ id: draft.id, tenantId: T.A })
      const sign = item.actions.find((a) => a.kind === 'approve')!
      expect(sign).toMatchObject({ method: 'POST', path: `/trustops/cash-vouchers/${draft.id}/sign-hod` })
      expect(item.actions.find((a) => a.kind === 'reject')).toMatchObject({ path: `/trustops/cash-vouchers/${draft.id}/reject`, input: { field: 'note', required: true } })
      // Not the stranger's, not the holder's own; company B's CEO never sees it.
      expect(((await inbox('chefOther')).json() as Inbox).items.some((i) => i.id === draft.id)).toBe(false)
      expect(((await inbox('chefHolder')).json() as Inbox).items.some((i) => i.id === draft.id)).toBe(false)
      expect(((await inbox('adminB')).json() as Inbox).items.some((i) => i.id === draft.id)).toBe(false)
      expect((await act('chefOther', sign)).statusCode).toBe(403)
      expect((await act('chefLead', sign)).statusCode).toBe(200)
      expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('hod_signed')
      expect(((await inbox('chefLead')).json() as Inbox).items.some((i) => i.id === draft.id)).toBe(false)
    } finally {
      await prisma.cashVoucher.delete({ where: { id: draft.id } })
    }
  })

  it("the recipe provider resolves an add-on recipe's company through modifier → group → dish → brand", async () => {
    const concept = await prisma.concept.findFirstOrThrow({ where: { tenantId: T.A } })
    const cat = await prisma.category.create({ data: { conceptId: concept.id, name: `${P} mains` } })
    const dish = await prisma.menuItem.create({ data: { conceptId: concept.id, categoryId: cat.id, name: `${P} burger`, priceCents: 1_500_00 } })
    const group = await prisma.modifierGroup.create({ data: { menuItemId: dish.id, name: 'Extras' } })
    const mod = await prisma.modifier.create({ data: { groupId: group.id, name: 'Extra cheese', priceDeltaCents: 150_00 } })
    const r = await prisma.recipe.create({
      data: { kind: 'modifier', modifierId: mod.id, name: 'Extra cheese', status: 'pending_approval', submittedById: U['hodA']!.id, submittedAt: new Date() },
    })
    const item = ((await inbox('admin')).json() as Inbox & { items: Array<{ facts?: Array<{ label: string; value: string }> }> }).items
      .find((i) => i.id === r.id) as (Inbox['items'][number] & { facts: Array<{ label: string; value: string }> }) | undefined
    expect(item).toBeTruthy()
    expect(item!.tenantId).toBe(T.A)
    expect(item!.facts.find((f) => f.label === 'Kind')!.value).toBe('Add-on')
    // Company B's CEO does not see it.
    expect(((await inbox('adminB')).json() as Inbox).items.some((i) => i.id === r.id)).toBe(false)
  })

  it('stock_difference: not listed while its route 404s; once it answers, rows map per company with CEO-only buttons', async () => {
    expect(((await counts('admin')).json() as Inbox).types.some((t) => t.type === 'stock_difference')).toBe(false)
    const provider = APPROVAL_PROVIDERS.find((p) => (p.type as string) === 'stock_difference')!
    expect(provider).toMatchObject({ label: 'Stock differences', module: 'accounting', delegable: false })
    expect(provider.approverRoles).toEqual(['admin'])
    // GET /accounting/stock-differences answers { rows: StockDifferenceRow[] } (stockDifferences/service.ts).
    const rows = [
      { lineId: 'jl-a', tenantId: T.A, itemName: 'Flour', locationName: 'A Kitchen 1', conceptName: 'Brand A', kind: 'waste', reason: 'Spoiled', valueCents: 12_000, entryDate: '2026-10-10T10:00:00.000Z', recordedByName: 'Chef A' },
      { lineId: 'jl-b', tenantId: T.B, itemName: 'Rice', locationName: 'B Kitchen 1', conceptName: 'Brand B', kind: 'count', reason: 'Short at count', valueCents: 9_000, entryDate: '2026-10-11T10:00:00.000Z', recordedByName: 'Chef B' },
    ]
    const read = async <T,>(path: string): Promise<T | null> => (path.startsWith('/accounting/stock-differences?status=pending') ? { rows } as T : null)
    const ctx = { user: { id: U['ceoBoth']!.id, role: 'admin' as never }, tenantIds: [T.A], memberTenantIds: [T.A, T.B], read }
    const res = await collectApprovals(ctx, { providers: [provider] })
    expect(res.items.map((i) => i.id)).toEqual(['jl-a'])
    expect(res.types[0]).toMatchObject({ type: 'stock_difference', count: 1, elsewhere: 1 })
    const [approve, query] = res.items[0]!.actions
    expect(approve).toMatchObject({ kind: 'approve', method: 'POST', path: '/accounting/stock-differences/approve', body: { lineIds: ['jl-a'] } })
    expect(query).toMatchObject({ kind: 'reject', method: 'POST', path: '/accounting/stock-differences/jl-a/query', input: { field: 'note', required: true } })
    expect(res.items[0]).toMatchObject({ link: '/finance/stock-differences', amountCents: 12_000 })
    expect((res.items[0] as { facts: Array<{ label: string; value: string }> }).facts.find((f) => f.label === 'Outlet')!.value).toBe('A Kitchen 1')
    // A finance login is not offered the type at all.
    const fin = await collectApprovals({ ...ctx, user: { id: U['finance']!.id, role: 'finance' as never } }, { providers: [provider] })
    expect(fin.types).toEqual([])
  })
})

describe('resilience', () => {
  it('a module queue that fails is flagged, not fatal', async () => {
    const broken = { ...APPROVAL_PROVIDERS[0]!, async load() { throw new Error('boom') } }
    const res = await collectApprovals(
      { user: { id: U['admin']!.id, role: 'admin' as never }, tenantIds: [T.A], memberTenantIds: [T.A], read: async () => null },
      { providers: [broken] },
    )
    expect(res.types).toEqual([expect.objectContaining({ type: broken.type, count: 0, error: true })])
    expect(res.total).toBe(0)
  })
})
