// The bell's approval notices (owner, 2026-10-16) — spec §3.1 / §3.2, test 3.
//
//   - Registry: every APPROVAL_TYPES entry has an APPROVAL_NOTIFY entry.
//   - approverIdsFor = exactly the people the approve route admits (decideApproval /
//     hr decideRight) who hold the queue module; company-separated (a CEO only in
//     company B is never told about A's items); the submitter is never told.
//   - "Whoever must act next" (owner): the CEO only for items at the CEO's end —
//     not a stock transfer a manager decides (unless no manager exists), not an HR
//     step a manager / HR decides; a hand-over notifies the delegate AND the CEO.
//   - HR: HOD step → the reporting manager only; HR review step → HR (+ a
//     head-office HR login that may forward it, A20).
//   - Rounds: same round dedupes, a new round notifies again; an item decided
//     before the queued job runs is not announced.
//   - Decided: reject → reason to the submitter; journal "reject" = returned;
//     HR non-final → raiser info only, final → raiser + employee; via auditApproval.
//   - Static: no notify hook inside a `$transaction(` body.
import { describe, it, expect, beforeAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyRequest } from 'fastify'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const R = await import('../src/lib/approvalRights.js')
const N = await import('../src/modules/approvals/notify.js')
const { flushNotifications } = await import('../src/lib/staffNotify.js')
const { effectiveModulesForUser } = await import('../src/lib/moduleAccess.js')

const P = `an${Date.now()}`
const T: Record<'A' | 'B' | 'HO', string> = { A: '', B: '', HO: '' }
const U: Record<string, { id: string; role: string; members: string[]; email: string }> = {}

async function mkUser(key: string, role: string, members: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@an.pk`, password: 'x', role: role as never, tenantId: members[0] ?? null,
      isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: members.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  U[key] = { id: u.id, role, members, email: u.email! }
  return U[key]!
}
const id = (k: string) => U[k]!.id
const ids = (...ks: string[]) => ks.map(id).sort()
const sorted = (xs: string[]) => [...xs].sort()
function reqAs(key: string): FastifyRequest {
  const u = U[key]!
  return { headers: {}, staffUser: { id: u.id, email: u.email, role: u.role, tenantId: u.members[0] ?? null, memberTenantIds: u.members, reachTenantIds: [] } } as unknown as FastifyRequest
}
const notes = (userId: string, entityId: string) =>
  prisma.staffNotification.findMany({ where: { userId, entityId }, orderBy: { createdAt: 'asc' } })

let supplierA = ''
let locA1 = ''
let locA2 = ''
let itemA = ''
let empHod = ''
let empStaff = ''

async function mkPo(status = 'pending_approval', createdBy = id('buyer')) {
  return prisma.purchaseOrder.create({ data: { supplierId: supplierA, status, createdBy, totalCents: 8_400_000, reference: `${P}-PO` } })
}
async function mkVoucher(status: string, seq: number) {
  return prisma.cashVoucher.create({
    data: {
      tenantId: T.A, seq, number: `CV-${P.slice(-5)}${seq}`, voucherDate: new Date(), payeeName: 'Staff', purpose: 'Gas cylinder',
      amountCents: 450_000, preparedById: id('staff'), status: status as never,
    },
  })
}
async function mkHr(section: string, currentStep: number) {
  return prisma.hrRecord.create({
    data: { tenantId: T.A, section, formVersion: 0, status: 'submitted', currentStep, employeeId: empStaff, createdById: id('staff'), approvals: [] },
  })
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} B`, slug: `${P}-b` } })).id
  T.HO = (await prisma.tenant.create({ data: { name: `${P} HO`, slug: `${P}-ho`, kind: 'head_office' } })).id
  await mkUser('ceoA', 'admin', [T.A, T.HO])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('buyer', 'procurement', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finDenied', 'finance', [T.A], { moduleDeny: ['accounting'] })
  await mkUser('finB', 'finance', [T.B])
  await mkUser('mgrA', 'fnb_manager', [T.A])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hod', 'foh_management', [T.A])
  await mkUser('staff', 'cashier', [T.A])
  await mkUser('hoHr', 'hr', [T.HO])
  await mkUser('hoBuyer', 'procurement', [T.HO])
  await mkUser('prep', 'finance', [T.A])
  await prisma.headOfficeLink.create({ data: { tenantId: T.HO, companyTenantId: T.A, createdById: id('ceoA') } })

  supplierA = (await prisma.supplier.create({ data: { name: `${P} Supplier`, tenantId: T.A } })).id
  locA1 = (await prisma.location.create({ data: { slug: `${P}-l1`, name: 'Clifton', tenantId: T.A } })).id
  locA2 = (await prisma.location.create({ data: { slug: `${P}-l2`, name: 'DHA', tenantId: T.A } })).id
  itemA = (await prisma.inventoryItem.create({ data: { name: `${P} Flour`, unit: 'kg', tenantId: T.A } })).id
  empHod = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Hod Person', userId: id('hod') } })).id
  empStaff = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Staff Person', userId: id('staff'), managerId: empHod } })).id
}, 120_000)

describe('registry', () => {
  it('every approval type has an APPROVAL_NOTIFY entry; event-less types are marked', () => {
    for (const t of R.APPROVAL_TYPES) expect(N.APPROVAL_NOTIFY[t], t).toBeTruthy()
    expect(N.NOTIFY_TYPES_COVERED()).toBe(true)
    expect(N.APPROVAL_NOTIFY.tip_pool.eventless).toBe(true)
    expect(N.APPROVAL_NOTIFY.stock_difference.eventless).toBe(true)
    expect(N.APPROVAL_NOTIFY.cash_request_hod.eventless).toBe(true)
  })
})

/** Parity: the users for whom decideApproval answers ok and who hold the queue module. */
async function parity(type: R.ApprovalType, itemId: string): Promise<string[]> {
  const s = (await R.approvalSubject(type, itemId))!
  const input = R.approvalInputOf(type, itemId, s)
  const out: string[] = []
  for (const k of Object.keys(U)) {
    if (k === 'hoBuyer' || k === 'hoHr') continue // reach / delegation are covered separately
    const d = await R.decideApproval(reqAs(k), input)
    if (!d.ok) continue
    const u = await prisma.user.findUniqueOrThrow({ where: { id: id(k) }, select: { role: true, moduleAllow: true, moduleDeny: true } })
    const mods = await effectiveModulesForUser(u)
    if (u.role === 'admin' || mods.has(R.APPROVAL_RIGHTS[type].queueModule)) out.push(id(k))
  }
  return out.sort()
}

describe('approval.waiting recipients (approverIdsFor)', () => {
  it('PO in A: the CEO of A only — not the CEO only in B, never the submitter; equals the route rule', async () => {
    const po = await mkPo()
    const found = (await R.approverIdsFor('purchase_order', po.id))!
    expect(sorted(found.userIds)).toEqual(ids('ceoA'))
    expect(sorted(found.userIds)).toEqual(await parity('purchase_order', po.id))
    expect(found.userIds).not.toContain(id('ceoB'))
    expect(found.userIds).not.toContain(id('buyer'))
  })

  it('sends one notice per round: same round dedupes, a resubmit (new round) notifies again', async () => {
    const po = await mkPo()
    expect(await N.sendApprovalWaiting('purchase_order', po.id, 'r1', id('buyer'))).toBe(1)
    expect(await N.sendApprovalWaiting('purchase_order', po.id, 'r1', id('buyer'))).toBe(0)
    const [n] = await notes(id('ceoA'), po.id)
    expect(n).toMatchObject({ kind: 'approval.waiting', tenantId: T.A, link: '/ceo/approvals?type=purchase_order', actorId: id('buyer') })
    expect(n!.title).toContain(`PO ${P}-PO`)
    expect(n!.title).toContain('PKR 84,000')
    expect(n!.title).toContain(`${P} A`)
    expect(await N.sendApprovalWaiting('purchase_order', po.id, 'r2', id('buyer'))).toBe(1)
    expect(await notes(id('ceoB'), po.id)).toHaveLength(0)
  })

  it('an item decided before the queued job runs is not announced', async () => {
    // Queued after the submit; by the time the job runs the CEO has already decided it.
    const po = await mkPo()
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'sent' } })
    N.approvalWaiting('purchase_order', po.id, { round: 'x', actorId: id('buyer') })
    await flushNotifications()
    expect(await notes(id('ceoA'), po.id)).toHaveLength(0)
    expect(await R.approverIdsFor('purchase_order', po.id)).toBeNull()
  })

  it('approvalWaiting without a round never throws and sends nothing', async () => {
    const po = await mkPo()
    expect(() => N.approvalWaiting('purchase_order', po.id, { round: '' })).not.toThrow()
    await flushNotifications()
    expect(await notes(id('ceoA'), po.id)).toHaveLength(0)
  })

  it('cash voucher: finance of A holding accounting (not denied, not B, not the CEO); after finance → the CEO', async () => {
    const v = await mkVoucher('submitted', 1)
    const f = (await R.approverIdsFor('cash_request_finance', v.id))!
    expect(sorted(f.userIds)).toEqual(ids('finA', 'prep'))
    expect(sorted(f.userIds)).toEqual(await parity('cash_request_finance', v.id))
    expect(await N.sendApprovalWaiting('cash_request_finance', v.id, 'r0', id('staff'))).toBe(2)
    expect((await notes(id('finA'), v.id))[0]!.title).toMatch(/needs finance approval/)
    await prisma.cashVoucher.update({ where: { id: v.id }, data: { status: 'finance_approved' } })
    expect(await R.approverIdsFor('cash_request_finance', v.id)).toBeNull()
    expect(sorted((await R.approverIdsFor('cash_voucher', v.id))!.userIds)).toEqual(ids('ceoA'))
  })

  it('stock transfer: the manager decides, the CEO is not told (Q7); with no manager the CEO is', async () => {
    const t = await prisma.stockTransfer.create({
      data: { inventoryItemId: itemA, fromLocationId: locA1, toLocationId: locA2, quantity: 5, unit: 'kg', requestedById: id('staff'), status: 'requested' },
    })
    expect(sorted((await R.approverIdsFor('stock_transfer', t.id))!.userIds)).toEqual(ids('mgrA'))
    await prisma.user.update({ where: { id: id('mgrA') }, data: { isActive: false } })
    try {
      expect(sorted((await R.approverIdsFor('stock_transfer', t.id))!.userIds)).toEqual(ids('ceoA'))
    } finally {
      await prisma.user.update({ where: { id: id('mgrA') }, data: { isActive: true } })
    }
  })

  it('HR leave at the HOD step: the reporting manager only — not the CEO (override), not HR', async () => {
    const rec = await mkHr('leave', 0)
    expect(sorted((await R.approverIdsFor('hr_request', rec.id))!.userIds)).toEqual(ids('hod'))
  })

  it('HR review step (non-final): HR of A and the head-office HR login that may forward it (A20); not the CEO', async () => {
    const rec = await mkHr('promotion', 1) // HOD → HR → management
    expect(sorted((await R.approverIdsFor('hr_request', rec.id))!.userIds)).toEqual(ids('hrA', 'hoHr'))
  })

  it('hand-over: the delegate AND the CEO (owner decision)', async () => {
    const po = await mkPo()
    const d = await prisma.approvalDelegation.create({
      data: { tenantId: T.HO, companyTenantId: T.A, section: 'procurement', delegateUserId: id('hoBuyer'), grantedById: id('ceoA'), note: 'test' },
    })
    try {
      expect(sorted((await R.approverIdsFor('purchase_order', po.id))!.userIds)).toEqual(ids('ceoA', 'hoBuyer'))
      expect(await N.sendApprovalWaiting('purchase_order', po.id, 'r1', id('buyer'))).toBe(2)
    } finally {
      await prisma.approvalDelegation.update({ where: { id: d.id }, data: { revokedAt: new Date(), revokedById: id('ceoA'), revokeReason: 'test over' } })
    }
  })
})

describe('approval.decided', () => {
  it('reject with a reason → the submitter (warning, reason); never the decider', async () => {
    const po = await mkPo('draft')
    const at = new Date().toISOString()
    expect(await N.sendApprovalDecided({ type: 'purchase_order', id: po.id, tenantId: T.A, decision: 'reject', actorId: id('ceoA'), note: 'Price too high', decidedAt: at })).toBe(1)
    const [n] = await notes(id('buyer'), po.id)
    expect(n).toMatchObject({ kind: 'approval.decided', severity: 'warning', link: '/procurement', tenantId: T.A })
    expect(n!.title).toMatch(/rejected/)
    expect(n!.body).toContain('Price too high')
    expect(await notes(id('ceoA'), po.id)).toHaveLength(0)
    // The same decision replayed dedupes; a later decision notifies again.
    expect(await N.sendApprovalDecided({ type: 'purchase_order', id: po.id, tenantId: T.A, decision: 'reject', actorId: id('ceoA'), decidedAt: at })).toBe(0)
  })

  it('journal request "reject" is worded as returned for correction', async () => {
    const j = await prisma.journalRequest.create({ data: { tenantId: T.A, description: 'Accrual', preparedById: id('prep'), status: 'returned' } })
    await N.sendApprovalDecided({ type: 'journal_request', id: j.id, tenantId: T.A, decision: 'reject', actorId: id('ceoA'), note: 'Wrong account', decidedAt: new Date().toISOString() })
    const [n] = await notes(id('prep'), j.id)
    expect(n!.title).toMatch(/returned for correction/)
    expect(n!.title).not.toMatch(/rejected/)
  })

  it('HR: a non-final step → the raiser (info, "now with …"), employee nothing; final → raiser + employee', async () => {
    // Raised by HR for the employee, so raiser and employee differ.
    const rec = await prisma.hrRecord.create({
      data: { tenantId: T.A, section: 'promotion', formVersion: 0, status: 'submitted', currentStep: 1, employeeId: empStaff, createdById: id('hrA'), approvals: [] },
    })
    await N.sendApprovalDecided({ type: 'hr_request', id: rec.id, tenantId: T.A, decision: 'approve', actorId: id('hod'), decidedAt: '2026-10-16T10:00:00.000Z', final: false })
    const [step] = await notes(id('hrA'), rec.id)
    expect(step).toMatchObject({ severity: 'info' })
    expect(step!.body).toMatch(/Now with HR/)
    expect(await notes(id('staff'), rec.id)).toHaveLength(0)
    await prisma.hrRecord.update({ where: { id: rec.id }, data: { status: 'approved' } })
    await N.sendApprovalDecided({ type: 'hr_request', id: rec.id, tenantId: T.A, decision: 'approve', actorId: id('ceoA'), decidedAt: '2026-10-16T11:00:00.000Z', final: true })
    expect((await notes(id('staff'), rec.id)).map((n) => n.severity)).toEqual(['success'])
    expect(await notes(id('hrA'), rec.id)).toHaveLength(2)
  })

  it('auditApproval queues the decided notice (the one funnel)', async () => {
    const po = await mkPo('sent')
    await R.auditApproval(reqAs('ceoA'), { type: 'purchase_order', id: po.id, tenantId: T.A, decision: 'approve', grant: { via: 'role' }, entity: 'PurchaseOrder' })
    await flushNotifications()
    const [n] = await notes(id('buyer'), po.id)
    expect(n).toMatchObject({ kind: 'approval.decided', severity: 'success', actorId: id('ceoA') })
    // lock / reopen are not decisions anyone waits on.
    expect(N.decisionOutcome('lock')).toBeNull()
    expect(N.decisionOutcome('reopen')).toBeNull()
  })

  it('a decision that clears its requester column names who waited (waitingUserIds replaces the submitters)', async () => {
    // e.g. an on-account limit increase / Raast void / GRNI write-off reject: the route reads the
    // requester before the write and passes it through auditApproval's metadata.
    const po = await mkPo('sent')
    await R.auditApproval(reqAs('ceoA'), {
      type: 'purchase_order', id: po.id, tenantId: T.A, decision: 'reject', grant: { via: 'role' }, entity: 'PurchaseOrder',
      metadata: { reason: 'No budget', waitingUserIds: [id('staff')] },
    })
    await flushNotifications()
    const [n] = await notes(id('staff'), po.id)
    expect(n).toMatchObject({ kind: 'approval.decided', severity: 'warning' })
    expect(n!.body).toContain('No budget')
    expect(await notes(id('buyer'), po.id)).toHaveLength(0)
  })
})

describe('static: no notify hook inside a $transaction body', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) files.push(p)
    }
  }
  walk(join(__dirname, '..', 'src'))
  const HOOK = /\b(approvalWaiting|approvalDecided|queueStaffNotify)\(/

  /** The text of every `$transaction(` call's argument list (brace / paren matched). */
  function txBodies(src: string): string[] {
    const out: string[] = []
    let i = src.indexOf('$transaction(')
    while (i !== -1) {
      let depth = 0
      let j = i + '$transaction'.length
      for (; j < src.length; j++) {
        const c = src[j]
        if (c === '(') depth++
        else if (c === ')') { depth--; if (depth === 0) break }
      }
      out.push(src.slice(i, j))
      i = src.indexOf('$transaction(', j)
    }
    return out
  }

  it('approvalWaiting / approvalDecided / queueStaffNotify never appear inside a $transaction( body', () => {
    const offenders: string[] = []
    for (const f of files) {
      // Comments are not code (the writers' headers describe the rule in words).
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      if (!HOOK.test(src)) continue
      for (const body of txBodies(src)) if (HOOK.test(body)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
