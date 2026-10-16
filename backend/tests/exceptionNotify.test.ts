// Unusual activity → the CEO(s) of that company (workers/staffNotifications.ts).
//
//   - a flag a user raised in A → the admins of A only (not B's CEO, not the
//     actor, not A's managers or finance);
//   - a flag the CEO raised → not to that CEO (another admin of A hears it);
//   - a quiet system flag (no actor, low/medium, not ALWAYS_NOTIFY) → nobody;
//     a high one → the CEO; a company-less flag → claimed, nobody;
//   - a flag of a rolled-back transaction → nothing; a flag committed late
//     (createdAt before the previous tick) → still announced;
//   - two workers at once → each flag claimed and announced once;
//   - more than 10 flags for one recipient + company in a batch → one digest;
//   - flags older than 2 days → never announced;
//   - night_audit_pending → CEO + finance (with accounting) of THAT company only.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import {
  claimAndNotifyBatch, runStaffNotificationsOnce, DIGEST_OVER,
} from '../src/workers/staffNotifications.js'

const RUN = Date.now().toString(36)
let seq = 0
let A: string, B: string
let ceoA: string, ceoA2: string, ceoB: string, mgrA: string, finA: string, finADenied: string, finB: string

async function tenant(name: string): Promise<string> {
  return (await prisma.tenant.create({ data: { name: `EN ${name}`, slug: `en-${++seq}-${RUN}` } })).id
}
async function user(role: string, tenantId: string, data: Partial<Prisma.UserUncheckedCreateInput> = {}): Promise<string> {
  const u = await prisma.user.create({
    data: {
      name: `en-${role}-${++seq}`, email: `en.${role}.${randomBytes(3).toString('hex')}@bell.test`,
      password: await bcrypt.hash('x-Password-1', 4), role: role as Prisma.UserCreateInput['role'],
      isActive: true, accountStatus: 'active', tenantId, ...data,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  return u.id
}
type FlagData = Partial<Prisma.ExceptionFlagUncheckedCreateInput>
const flag = (tenantId: string | null, data: FlagData = {}) => prisma.exceptionFlag.create({
  data: {
    tenantId, kind: 'shrinkage', severity: 'low', title: `Flag ${++seq}`, description: 'Something unusual happened.', ...data,
  },
})
const notesFor = (userId: string) => prisma.staffNotification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
const notesOfFlag = (flagId: string) => prisma.staffNotification.findMany({ where: { dedupeKey: `exception:${flagId}` } })
async function drain() {
  for (let i = 0; i < 20; i++) if ((await claimAndNotifyBatch()).claimed === 0) return
}

beforeAll(async () => {
  A = await tenant('A')
  B = await tenant('B')
  ceoA = await user('admin', A)
  ceoA2 = await user('admin', A)
  ceoB = await user('admin', B)
  mgrA = await user('manager', A)
  finA = await user('finance', A)
  finADenied = await user('finance', A, { moduleDeny: ['accounting'] })
  finB = await user('finance', B)
}, 60_000)

describe('which flags, which people', () => {
  it('a flag a user raised in A → the CEOs of A only', async () => {
    const f = await flag(A, { actorId: mgrA, kind: 'discount_above_cap' })
    await drain()
    const notes = await notesOfFlag(f.id)
    expect(notes.map((n) => n.userId).sort()).toEqual([ceoA, ceoA2].sort())
    expect(notes[0]).toMatchObject({
      tenantId: A, kind: 'exception', severity: 'warning', title: f.title,
      link: `/exceptions?flag=${f.id}`, actorId: mgrA, entityType: 'ExceptionFlag', entityId: f.id,
    })
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: f.id } })).notifiedAt).not.toBeNull()
  })

  it('a flag the CEO raised → not to that CEO', async () => {
    const f = await flag(A, { actorId: ceoA, kind: 'manual_journal' })
    await drain()
    expect((await notesOfFlag(f.id)).map((n) => n.userId)).toEqual([ceoA2])
  })

  it('a quiet system flag → nobody; a high or critical one → the CEO', async () => {
    const quiet = await flag(A, { severity: 'medium' })
    const high = await flag(A, { severity: 'high', kind: 'cash_variance' })
    const critical = await flag(A, { severity: 'critical', kind: 'fiscal_failed' })
    await drain()
    expect(await notesOfFlag(quiet.id)).toHaveLength(0)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: quiet.id } })).notifiedAt).not.toBeNull()
    expect((await notesOfFlag(high.id)).map((n) => n.userId).sort()).toEqual([ceoA, ceoA2].sort())
    expect((await notesOfFlag(critical.id))[0]!.severity).toBe('critical')
  })

  it('a system flag of an ALWAYS_NOTIFY kind → the CEO', async () => {
    const f = await flag(A, { kind: 'consecutive_voids', severity: 'medium' })
    await drain()
    expect(await notesOfFlag(f.id)).toHaveLength(2)
  })

  it('a company-less flag is claimed and announced to nobody', async () => {
    const f = await flag(null, { actorId: mgrA, severity: 'critical' })
    await drain()
    expect(await notesOfFlag(f.id)).toHaveLength(0)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: f.id } })).notifiedAt).not.toBeNull()
  })

  it('B\'s CEO, A\'s manager and A\'s finance never hear of A\'s warnings', async () => {
    expect(await notesFor(ceoB)).toHaveLength(0)
    expect(await notesFor(mgrA)).toHaveLength(0)
    expect(await notesFor(finA)).toHaveLength(0)
  })
})

describe('the claim', () => {
  it('a flag of a rolled-back transaction is never announced', async () => {
    const before = await prisma.staffNotification.count()
    await expect(prisma.$transaction(async (tx) => {
      await tx.exceptionFlag.create({ data: { tenantId: A, kind: 'self_approval', severity: 'high', title: 'rolled back', description: 'x', actorId: mgrA } })
      throw new Error('business action failed')
    })).rejects.toThrow('business action failed')
    await drain()
    expect(await prisma.exceptionFlag.count({ where: { title: 'rolled back' } })).toBe(0)
    expect(await prisma.staffNotification.count()).toBe(before)
  })

  it('a flag committed after a tick, dated before it, is still announced', async () => {
    await drain()
    const late = await flag(A, { actorId: mgrA, createdAt: new Date(Date.now() - 30 * 60_000) })
    const r = await runStaffNotificationsOnce()
    expect(r.claimed).toBeGreaterThanOrEqual(1)
    expect(await notesOfFlag(late.id)).toHaveLength(2)
  })

  it('two workers at once → each flag claimed and announced once', async () => {
    const flags = await Promise.all(Array.from({ length: 5 }, () => flag(B, { actorId: finB, kind: 'price_override' })))
    const [r1, r2] = await Promise.all([claimAndNotifyBatch(3), claimAndNotifyBatch(3)])
    await drain()
    expect(r1.claimed + r2.claimed).toBe(5)
    for (const f of flags) {
      const notes = await notesOfFlag(f.id)
      expect(notes.map((n) => n.userId)).toEqual([ceoB])
    }
    expect(await prisma.exceptionFlag.count({ where: { id: { in: flags.map((f) => f.id) }, notifiedAt: null } })).toBe(0)
  })

  it(`more than ${DIGEST_OVER} flags for one company in a batch → one digest, no single notices`, async () => {
    await drain()
    const flags: Array<{ id: string }> = []
    for (let i = 0; i < DIGEST_OVER + 1; i++) flags.push(await flag(B, { actorId: finB, kind: 'price_override' }))
    const before = (await notesFor(ceoB)).length
    await drain()
    const after = await notesFor(ceoB)
    expect(after.length - before).toBe(1)
    const digest = after[after.length - 1]!
    expect(digest).toMatchObject({ kind: 'exception.digest', tenantId: B, link: '/exceptions' })
    expect(digest.title).toBe(`${DIGEST_OVER + 1} new warnings in EN B`)
    for (const f of flags) expect(await notesOfFlag(f.id)).toHaveLength(0)
  })

  it('flags older than 2 days are left alone', async () => {
    const old = await flag(A, { actorId: mgrA, severity: 'critical', createdAt: new Date(Date.now() - 3 * 86_400_000) })
    await drain()
    expect(await notesOfFlag(old.id)).toHaveLength(0)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: old.id } })).notifiedAt).toBeNull()
  })
})

describe('night_audit_pending (a night-run notice)', () => {
  it('→ the CEOs and finance (with accounting) of that company; never B\'s finance', async () => {
    const f = await flag(A, {
      kind: 'night_audit_pending', severity: 'medium', title: 'Night audit not run for 2026-10-15',
      metadata: { day: '2026-10-15' },
    })
    await drain()
    const notes = await notesOfFlag(f.id)
    expect(notes.map((n) => n.userId).sort()).toEqual([ceoA, ceoA2, finA].sort())
    expect(notes[0]!.link).toBe('/finance/night-audit?day=2026-10-15')
    expect(notes.find((n) => n.userId === finADenied)).toBeUndefined()
    expect(await notesFor(finB)).toHaveLength(0)
  })
})
