// The audit trail, split in two.
//
// Until now one tenant-less table held everything, every finance-tier role in
// either company could read all of it, and it contained no identity events at
// all — no record of who created an account, who assigned a role, or who
// changed what a role can reach.
//
// These tests pin down the three properties that split is supposed to buy:
//   1. an event lands in exactly one trail, and the wrong trail never shows it
//   2. the accounting trail is readable by the CEO and the exec only
//   3. neither trail leaks one company's rows to the other
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { audit } from '../src/lib/audit.js'
import { DEFAULT_MODULE_ACCESS, ACCOUNTING_AUDIT_ROLES, MODULE_IDS } from '../src/lib/moduleAccess.js'

let tenantA: string
let tenantB: string

beforeAll(async () => {
  const a = await prisma.tenant.create({ data: { name: 'Audit Co A', slug: 'audit-co-a' }, select: { id: true } })
  const b = await prisma.tenant.create({ data: { name: 'Audit Co B', slug: 'audit-co-b' }, select: { id: true } })
  tenantA = a.id
  tenantB = b.id
})

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

beforeEach(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
})

describe('the two trails stay separate', () => {
  it('files an identity event where only the identity trail can see it', async () => {
    await audit({
      category: 'identity',
      action: 'user.role_change',
      entity: 'User',
      entityId: 'u1',
      tenantId: tenantA,
      before: { role: 'cashier' },
      after: { role: 'manager' },
    })
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA, category: 'identity' } })).toBe(1)
    // The load-bearing half: it must NOT appear in the accounting trail, which
    // is the one with the narrower audience.
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA, category: 'accounting' } })).toBe(0)
  })

  it('files a books event where only the accounting trail can see it', async () => {
    await audit({ category: 'accounting', action: 'period.close', entity: 'PeriodLock', tenantId: tenantA })
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA, category: 'accounting' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA, category: 'identity' } })).toBe(0)
  })

  it('keeps the before/after snapshot a role change is worth reading for', async () => {
    await audit({
      category: 'identity',
      action: 'user.role_change',
      entity: 'User',
      entityId: 'u2',
      tenantId: tenantA,
      before: { role: 'foh' },
      after: { role: 'finance', targetEmail: 'x@gsfoods.pk' },
    })
    const row = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, action: 'user.role_change' } })
    expect((row?.before as { role: string }).role).toBe('foh')
    expect((row?.after as { role: string }).role).toBe('finance')
  })
})

describe('one company cannot read the other', () => {
  it('separates the trails by the company the actor was working in', async () => {
    await audit({ category: 'accounting', action: 'wage.update', entity: 'User', tenantId: tenantA })
    await audit({ category: 'accounting', action: 'wage.update', entity: 'User', tenantId: tenantB })

    // This is the JV case: a wage change in one company must not surface in the
    // other's trail, whoever is reading.
    const seenByA = await prisma.auditLog.findMany({ where: { category: 'accounting', tenantId: { in: [tenantA] } } })
    expect(seenByA).toHaveLength(1)
    expect(seenByA[0]!.tenantId).toBe(tenantA)
  })

  it('leaves pre-split rows unattributed rather than guessing', async () => {
    // A row written before the column existed has no company. It must not be
    // silently adopted into either one — the actor's CURRENT company is not
    // necessarily the one they were acting in.
    await audit({ category: 'accounting', action: 'journal.manual', entity: 'JournalEntry', tenantId: null })
    const scoped = await prisma.auditLog.findMany({ where: { category: 'accounting', tenantId: { in: [tenantA, tenantB] } } })
    expect(scoped).toHaveLength(0)
    const legacy = await prisma.auditLog.findMany({ where: { category: 'accounting', tenantId: null } })
    expect(legacy.length).toBeGreaterThan(0)
    await prisma.auditLog.deleteMany({ where: { tenantId: null, action: 'journal.manual' } })
  })
})

describe('who may read the books trail', () => {
  it('is the CEO and the exec, and nobody else', () => {
    expect([...ACCOUNTING_AUDIT_ROLES].sort()).toEqual(['admin', 'management'])
  })

  it('withholds it from co-owners, managers and finance', () => {
    // All three can see the numbers. This trail is the record of who MOVED
    // them, which is what you read when the person you doubt is one of them.
    for (const role of ['owner', 'manager', 'finance'] as const) {
      expect(DEFAULT_MODULE_ACCESS[role] ?? []).not.toContain('accounting_audit')
    }
  })

  it('grants it to the two roles that should have it', () => {
    expect(DEFAULT_MODULE_ACCESS['admin']).toContain('accounting_audit')
    expect(DEFAULT_MODULE_ACCESS['management']).toContain('accounting_audit')
  })

  it('still grants the identity trail to ordinary managers', () => {
    // Splitting the trails must not cost a manager the log they need to run a
    // shift — that would push them to ask for the accounting one instead.
    expect(DEFAULT_MODULE_ACCESS['manager']).toContain('audit_log')
  })

  it('registers accounting_audit as a real module id', () => {
    // A module id the registry does not know is silently ignored by the
    // permission check, which fails OPEN.
    expect(MODULE_IDS as readonly string[]).toContain('accounting_audit')
  })
})

describe('the writer refuses to guess', () => {
  it('records the acting company, not the actor’s company', async () => {
    // tenantId is passed in from the request, never read off the user later:
    // operators here belong to both companies and switch between them.
    await audit({ category: 'identity', action: 'user.create', entity: 'User', tenantId: tenantB, userId: 'someone' })
    const row = await prisma.auditLog.findFirst({ where: { action: 'user.create' } })
    expect(row?.tenantId).toBe(tenantB)
  })

  it('never breaks the mutation it is recording', async () => {
    // An audit write that throws must not take the refund with it.
    await expect(
      audit({ category: 'identity', action: 'x'.repeat(100_000), entity: 'User', tenantId: tenantA }),
    ).resolves.toBeUndefined()
  })
})
