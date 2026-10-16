// The notification bell's ONE writer (lib/staffNotify.ts) and retention.
//
//   - the same dedupeKey twice → one row; the actor never notified;
//   - pending / suspended / deleted / inactive recipients dropped; a
//     non-member of the event's company dropped; a head-office member with a
//     live link to the company kept; a NULL-company row kept for admins only;
//   - the link CHECK refuses //host and absolute URLs (the writer stores null);
//     title / body truncated to the CHECK lengths;
//   - a DB error → 0, never thrown; a route that queues a failing notice still 200;
//   - a queued job runs in a FRESH RLS context and never widens the caller's;
//   - retention: read rows > 90 days and any row > 180 days removed, fresh kept.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import {
  notifyStaff, notifyStaffMany, queueStaffNotify, flushNotifications, isSafeLink,
  TITLE_MAX, BODY_MAX, type NotifyInput,
} from '../src/lib/staffNotify.js'
import { runWithRlsContext, getRlsContext, appendRlsTenantIds } from '../src/lib/rlsContext.js'
import { runStaffNotificationRetention } from '../src/workers/staffNotifications.js'

const RUN = Date.now().toString(36)
let seq = 0

async function tenant(name: string, kind: 'company' | 'head_office' = 'company'): Promise<string> {
  return (await prisma.tenant.create({ data: { name: `SN ${name}`, slug: `sn-${++seq}-${RUN}`, kind } })).id
}
async function user(role: string, tenantId: string | null, data: Partial<Prisma.UserUncheckedCreateInput> = {}): Promise<string> {
  const u = await prisma.user.create({
    data: {
      name: `sn-${role}-${++seq}`, email: `sn.${role}.${randomBytes(3).toString('hex')}@bell.test`,
      password: await bcrypt.hash('x-Password-1', 4), role: role as Prisma.UserCreateInput['role'],
      isActive: true, accountStatus: 'active', tenantId, ...data,
    },
  })
  if (tenantId) await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  return u.id
}
const row = (userId: string, tenantId: string | null, extra: Partial<NotifyInput> = {}): NotifyInput => ({
  userId, tenantId, kind: 'approval.waiting', title: 'PO-00001 waiting for your approval', dedupeKey: `k:${++seq}`, ...extra,
})
const rowsOf = (userId: string) => prisma.staffNotification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })

let A: string, B: string, HO: string
let ceo: string, mgrA: string, mgrB: string, hoHr: string

beforeAll(async () => {
  A = await tenant('A')
  B = await tenant('B')
  HO = await tenant('HO', 'head_office')
  ceo = await user('admin', A)
  await prisma.tenantMember.create({ data: { tenantId: B, userId: ceo } })
  mgrA = await user('manager', A)
  mgrB = await user('manager', B)
  hoHr = await user('hr', HO)
  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: A, createdById: ceo } })
}, 60_000)

afterAll(async () => { await flushNotifications() })

describe('notifyStaffMany', () => {
  it('the same dedupeKey twice → one row', async () => {
    const r = row(mgrA, A, { dedupeKey: 'approval.waiting:purchase_order:x:r0' })
    expect(await notifyStaff(r)).toBe(1)
    expect(await notifyStaff(r)).toBe(0)
    expect(await notifyStaffMany([r, r])).toBe(0)
    expect((await rowsOf(mgrA)).filter((n) => n.dedupeKey === r.dedupeKey)).toHaveLength(1)
  })

  it('never the actor', async () => {
    expect(await notifyStaff(row(mgrA, A, { actorId: mgrA, dedupeKey: 'actor-self' }))).toBe(0)
    expect(await notifyStaff(row(ceo, A, { actorId: mgrA, dedupeKey: 'actor-other' }))).toBe(1)
    const n = await prisma.staffNotification.findFirstOrThrow({ where: { userId: ceo, dedupeKey: 'actor-other' } })
    expect(n.actorId).toBe(mgrA)
  })

  it('pending, suspended, deleted and inactive logins are dropped', async () => {
    const pending = await user('manager', A, { accountStatus: 'pending' })
    const suspended = await user('manager', A, { accountStatus: 'suspended' })
    const deleted = await user('manager', A, { deletedAt: new Date() })
    const inactive = await user('manager', A, { isActive: false })
    expect(await notifyStaffMany([pending, suspended, deleted, inactive].map((id) => row(id, A)))).toBe(0)
    expect(await prisma.staffNotification.count({ where: { userId: { in: [pending, suspended, deleted, inactive] } } })).toBe(0)
  })

  it('a recipient outside the event\'s company is dropped (company B never hears of A)', async () => {
    expect(await notifyStaff(row(mgrB, A))).toBe(0)
    expect(await notifyStaff(row(mgrA, B))).toBe(0)
    expect(await notifyStaff(row(mgrB, B))).toBe(1)
  })

  it('a head-office member reaching the company through a live link is kept; an ended link drops it', async () => {
    expect(await notifyStaff(row(hoHr, A, { dedupeKey: 'ho-live' }))).toBe(1)
    expect(await notifyStaff(row(hoHr, B, { dedupeKey: 'ho-unlinked' }))).toBe(0)
    await prisma.headOfficeLink.updateMany({ where: { tenantId: HO, companyTenantId: A }, data: { endedAt: new Date() } })
    expect(await notifyStaff(row(hoHr, A, { dedupeKey: 'ho-ended' }))).toBe(0)
    await prisma.headOfficeLink.updateMany({ where: { tenantId: HO, companyTenantId: A }, data: { endedAt: null } })
  })

  it('a NULL-company notice is kept for an admin only', async () => {
    expect(await notifyStaff(row(mgrA, null, { dedupeKey: 'null-mgr' }))).toBe(0)
    expect(await notifyStaff(row(ceo, null, { dedupeKey: 'null-ceo' }))).toBe(1)
  })

  it('unsafe links are stored as null; the CHECK refuses them at the database too', async () => {
    expect(isSafeLink('/ceo/approvals?type=purchase_order')).toBe(true)
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '']) expect(isSafeLink(bad)).toBe(false)
    await notifyStaff(row(mgrA, A, { dedupeKey: 'link-bad', link: '//evil.com/x' }))
    await notifyStaff(row(mgrA, A, { dedupeKey: 'link-good', link: '/finance/night-audit?day=2026-10-15' }))
    const [bad, good] = await Promise.all([
      prisma.staffNotification.findFirstOrThrow({ where: { userId: mgrA, dedupeKey: 'link-bad' } }),
      prisma.staffNotification.findFirstOrThrow({ where: { userId: mgrA, dedupeKey: 'link-good' } }),
    ])
    expect(bad.link).toBeNull()
    expect(good.link).toBe('/finance/night-audit?day=2026-10-15')
    for (const link of ['//evil.com', 'https://evil.com']) {
      await expect(prisma.staffNotification.create({
        data: { userId: mgrA, tenantId: A, kind: 'exception', title: 't', dedupeKey: `raw:${link}`, link },
      })).rejects.toThrow(/staff_notifications_link_chk/)
    }
    await expect(prisma.staffNotification.create({
      data: { userId: mgrA, tenantId: A, kind: 'exception', title: 't', dedupeKey: 'raw-sev', severity: 'loud' },
    })).rejects.toThrow(/staff_notifications_severity_chk/)
  })

  it('title and body are cut to the CHECK lengths; an unknown severity becomes info', async () => {
    await notifyStaff(row(mgrA, A, {
      dedupeKey: 'long', title: 'T'.repeat(400), body: 'B'.repeat(2000), severity: 'loud' as never,
    }))
    const n = await prisma.staffNotification.findFirstOrThrow({ where: { userId: mgrA, dedupeKey: 'long' } })
    expect(n.title.length).toBe(TITLE_MAX)
    expect(n.body!.length).toBe(BODY_MAX)
    expect(n.severity).toBe('info')
  })

  it('a database error returns 0 and never throws', async () => {
    // Postgres refuses a NUL byte in text: the insert itself fails.
    await expect(notifyStaff(row(mgrA, A, { title: 'bad\u0000title', dedupeKey: 'nul' }))).resolves.toBe(0)
  })
})

describe('queueStaffNotify', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify()
    app.post('/act', async () => {
      // The business action committed; the notice fails afterwards.
      queueStaffNotify(() => notifyStaff(row(mgrA, A, { title: 'bad\u0000', dedupeKey: 'route-nul' })))
      queueStaffNotify(async () => { throw new Error('recipient lookup exploded') })
      return { ok: true }
    })
    await app.ready()
  })
  afterAll(async () => { await app.close() })

  it('a failing notice never fails the route', async () => {
    const res = await app.inject({ method: 'POST', url: '/act' })
    expect(res.statusCode).toBe(200)
    await flushNotifications()
    expect(await prisma.staffNotification.count({ where: { dedupeKey: 'route-nul' } })).toBe(0)
  })

  it('runs later, in a fresh RLS context, and never widens the caller\'s', async () => {
    const seen: Array<string[] | undefined> = []
    await runWithRlsContext({ tenantIds: [A], staffUserId: mgrA }, async () => {
      queueStaffNotify(async () => {
        seen.push(getRlsContext()?.tenantIds)
        appendRlsTenantIds([B])   // e.g. widenRls inside recipient resolution
        seen.push(getRlsContext()?.tenantIds)
        await notifyStaff(row(mgrA, A, { dedupeKey: 'queued' }))
      })
      expect(seen).toHaveLength(0)   // not run synchronously
      await flushNotifications()
      expect(getRlsContext()?.tenantIds).toEqual([A])
      expect(getRlsContext()?.staffUserId).toBe(mgrA)
    })
    expect(seen).toEqual([[], [B]])
    expect(await prisma.staffNotification.count({ where: { userId: mgrA, dedupeKey: 'queued' } })).toBe(1)
  })
})

describe('retention', () => {
  it('removes read rows older than 90 days and any row older than 180 days; keeps the rest', async () => {
    const day = 86_400_000
    const now = Date.now()
    const mk = (key: string, ageDays: number, read: boolean) => prisma.staffNotification.create({
      data: {
        userId: mgrB, tenantId: B, kind: 'exception', title: key, dedupeKey: `ret:${key}`,
        createdAt: new Date(now - ageDays * day), readAt: read ? new Date(now - (ageDays - 1) * day) : null,
      },
    })
    await mk('read-91', 91, true)
    await mk('unread-91', 91, false)
    await mk('read-10', 10, true)
    await mk('unread-181', 181, false)
    await mk('fresh', 0, false)
    expect(await runStaffNotificationRetention(new Date(now))).toBe(2)
    const left = (await prisma.staffNotification.findMany({ where: { dedupeKey: { startsWith: 'ret:' } } })).map((n) => n.title).sort()
    expect(left).toEqual(['fresh', 'read-10', 'unread-91'])
  })
})
