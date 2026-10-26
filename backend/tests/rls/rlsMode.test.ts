// TEST_RLS=1 self-check: the run really is under the company lock. Skipped in
// the normal run. If this file fails in the RLS job, every other green file of
// that job proves nothing (the app would be bypassing RLS).
import { describe, it, expect, beforeAll } from 'vitest'
import { prisma, serviceClient } from '../../src/lib/prisma.js'
import { runWithRlsContext } from '../../src/lib/rlsContext.js'
import { isRlsMode, RLS_ROLE } from './rlsMode.js'

const on = isRlsMode()
const RUN = Math.random().toString(36).slice(2, 8)
const ids: Record<'A' | 'B', { tenantId: string; conceptId: string; orderId: string }> = {} as never

async function seed(key: 'A' | 'B') {
  const tenant = await serviceClient.tenant.create({ data: { name: `RLS mode ${key}`, slug: `rlsmode-${key.toLowerCase()}-${RUN}` } })
  const concept = await serviceClient.concept.create({ data: { name: `RLS ${key}`, slug: `rlsmode-c-${key.toLowerCase()}-${RUN}`, type: 'restaurant', tenantId: tenant.id } as never })
  const order = await serviceClient.order.create({
    data: { conceptId: concept.id, source: 'servd', totalCents: 100 },
  })
  ids[key] = { tenantId: tenant.id, conceptId: concept.id, orderId: order.id }
}

describe.skipIf(!on)('TEST_RLS mode is really on', () => {
  beforeAll(async () => { await seed('A'); await seed('B') })

  it('connects as the plain role, which does not bypass RLS', async () => {
    const [me] = await prisma.$queryRawUnsafe<Array<{ u: string; bypass: boolean; superuser: boolean }>>(
      `SELECT current_user AS u, r.rolbypassrls AS bypass, r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname = current_user`)
    expect(me).toEqual({ u: RLS_ROLE, bypass: false, superuser: false })
    expect(process.env.RLS_ENFORCE).toBe('1')
  })

  it("company A's request sees only A's orders and cannot touch B's", async () => {
    // Await INSIDE the context: a PrismaPromise is lazy and runs where it is awaited.
    const seen = await runWithRlsContext({ tenantIds: [ids.A.tenantId] }, async () =>
      await prisma.order.findMany({ where: { id: { in: [ids.A.orderId, ids.B.orderId] } }, select: { id: true } }))
    expect(seen.map((o) => o.id)).toEqual([ids.A.orderId])
    const hit = await runWithRlsContext({ tenantIds: [ids.A.tenantId] }, async () =>
      await prisma.order.updateMany({ where: { id: ids.B.orderId }, data: { totalCents: 1 } }))
    expect(hit.count).toBe(0)
  })

  it('service mode (no request) still sees both, even on a connection a request used', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await runWithRlsContext({ tenantIds: [ids.A.tenantId] }, async () => await prisma.order.count({ where: { id: ids.B.orderId } }))).toBe(0)
    }
    const all = await serviceClient.order.count({ where: { id: { in: [ids.A.orderId, ids.B.orderId] } } })
    expect(all).toBe(2)
  })

  // Every table that holds a company's rows (a tenantId column) carries a
  // policy — a new company table without one fails here (F13, 2026-10-26).
  // Platform tables without tenantId are listed in NON_OWNER_SWITCH.md.
  it('every table with a tenantId column has row-level security and a policy', async () => {
    const rows = await serviceClient.$queryRawUnsafe<Array<{ t: string }>>(`
      SELECT c.relname AS t FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns k
                      WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'tenantId')
         AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname))
       ORDER BY 1`)
    expect(rows.map((r) => r.t)).toEqual([])
  })

  it('group orders: a customer member reads the group without policy recursion (42P17)', async () => {
    const n = await runWithRlsContext({ customerId: 'no-such-customer' }, async () =>
      await prisma.groupOrder.count({ where: { id: 'no-such-group' } }))
    expect(n).toBe(0)
  })
})
