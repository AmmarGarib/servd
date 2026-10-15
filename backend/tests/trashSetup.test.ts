// Trash — setup & configuration (stream B3; modules/trash/README.md).
//
//   - Two companies: company B never sees, restores or purges A's items (404);
//     a delete in B of A's id is 404 and files nothing.
//   - Delete keeps answering 204 and files one entry stamped with the ROW's company.
//   - Custom field: restored WITH its values; key clash renames; values are not lost (F8).
//   - Notification template: clash on the scope key → 409 TRASH_CLASH.
//   - Delivery zone: snapshot round-trip; a zone of a trashed brand → PARENT_IN_TRASH.
//   - Bank account: never erasable; restore never sets the Raast default again.
//   - Scheduled report: restore re-checks mayScheduleReport for its creator.
//   - Modifier template: restores with its options; erasable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { setupRoutes } = await import('../src/modules/setup/routes.js')
const { trashProvider } = await import('../src/modules/trash/registry.js')

const stamp = Date.now()
const P = `tst${stamp}`
let app: FastifyInstance
const T = { A: '', B: '' }
const U: Record<string, { id: string }> = {}
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`.toLowerCase(), password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id }
  tokens[key] = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken
}
const call = (key: string, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({
    method, url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${tokens[key]}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  })
const code = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code
const openEntry = (type: string, id: string) =>
  prisma.trashEntry.findFirst({ where: { entityType: type, entityId: id, restoredAt: null, purgedAt: null } })
const listIds = async (key: string, type: string) =>
  ((await call(key, 'GET', `/trash?type=${type}&limit=100`)).json() as { items: Array<{ id: string }> }).items.map((i) => i.id)

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('ownerB', 'owner', [T.B])
  await mkUser('financeA', 'finance', [T.A])
  await mkUser('cashierA', 'cashier', [T.A])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await registerTrashPlugin(api)
    await api.register(setupRoutes, { prefix: '/setup' })
  }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => { await app?.close() })

describe('registry', () => {
  it('registers the six setup types with their rules', () => {
    for (const k of ['modifier_template', 'delivery_zone', 'notification_template', 'bank_account', 'custom_field', 'scheduled_report']) {
      expect(trashProvider(k), k).toBeTruthy()
    }
    expect(trashProvider('bank_account')!.erasable(null, [])).toBe(false)
    expect(trashProvider('bank_account')!.auditCategory).toBe('accounting')
    expect(trashProvider('custom_field')!.strategy).toBe('snapshot')
  })
})

describe('custom field', () => {
  it('restores WITH its values; B is blind to A; key clash renames', async () => {
    const f = await prisma.customFieldDefinition.create({ data: { tenantId: T.A, scope: 'customer', key: `vip_${stamp}`, label: 'VIP level', type: 'text' } })
    await prisma.customFieldValue.createMany({
      data: [
        { fieldId: f.id, entityType: 'customer', entityId: 'cust-1', value: 'gold' },
        { fieldId: f.id, entityType: 'customer', entityId: 'cust-2', value: 'silver' },
      ],
    })
    expect((await call('ownerB', 'DELETE', `/setup/custom-fields/${f.id}`)).statusCode).toBe(404)
    expect(await openEntry('custom_field', f.id)).toBeNull()

    expect((await call('ownerA', 'DELETE', `/setup/custom-fields/${f.id}?reason=not%20used`)).statusCode).toBe(204)
    expect(await prisma.customFieldValue.count({ where: { fieldId: f.id } })).toBe(0)
    const e = await openEntry('custom_field', f.id)
    expect(e?.tenantId).toBe(T.A)
    expect(e?.reason).toBe('not used')
    expect(await listIds('ownerA', 'custom_field')).toContain(f.id)
    expect(await listIds('ownerB', 'custom_field')).not.toContain(f.id)
    expect((await call('ownerB', 'GET', `/trash/custom_field/${f.id}`)).statusCode).toBe(404)
    expect((await call('ownerB', 'POST', `/trash/custom_field/${f.id}/restore`, {})).statusCode).toBe(404)
    // Only the CEO empties.
    expect((await call('ownerA', 'DELETE', `/trash/custom_field/${f.id}`, { reason: 'trying to empty it' })).statusCode).toBe(403)

    // The same key is taken meanwhile → clash, then a rename wins.
    const twin = await prisma.customFieldDefinition.create({ data: { tenantId: T.A, scope: 'customer', key: f.key, label: 'Twin', type: 'text' } })
    const clash = await call('ownerA', 'POST', `/trash/custom_field/${f.id}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(code(clash)).toBe('TRASH_CLASH')
    const ok = await call('ownerA', 'POST', `/trash/custom_field/${f.id}/restore`, { rename: { key: `${f.key}_old` } })
    expect(ok.statusCode).toBe(200)
    const back = await prisma.customFieldDefinition.findUnique({ where: { id: f.id } })
    expect(back!.key).toBe(`${f.key}_old`)
    expect(back!.tenantId).toBe(T.A)
    const vals = await prisma.customFieldValue.findMany({ where: { fieldId: f.id }, orderBy: { entityId: 'asc' } })
    expect(vals.map((v) => v.value)).toEqual(['gold', 'silver'])
    expect(twin.key).toBe(f.key)
    const again = await call('ownerA', 'POST', `/trash/custom_field/${f.id}/restore`, {})
    expect(code(again)).toBe('ALREADY_RESTORED')
  })

  it('purge by the CEO drops the snapshot; the field stays gone', async () => {
    const f = await prisma.customFieldDefinition.create({ data: { tenantId: T.A, scope: 'order', key: `gone_${stamp}`, label: 'Gone', type: 'text' } })
    expect((await call('ownerA', 'DELETE', `/setup/custom-fields/${f.id}`)).statusCode).toBe(204)
    expect((await call('ceoB', 'DELETE', `/trash/custom_field/${f.id}`, { reason: 'not my company' })).statusCode).toBe(404)
    expect((await call('ceoA', 'DELETE', `/trash/custom_field/${f.id}`, { reason: 'cleaning up for good' })).statusCode).toBeLessThan(300)
    expect(await prisma.customFieldDefinition.findUnique({ where: { id: f.id } })).toBeNull()
    const res = await call('ceoA', 'POST', `/trash/custom_field/${f.id}/restore`, {})
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('PURGED')
  })
})

describe('notification template', () => {
  it('snapshot round-trip; a live template with the same scope key → TRASH_CLASH', async () => {
    const t = await prisma.notificationTemplate.create({
      data: { tenantId: T.A, channel: 'sms', event: `order.ready.${stamp}`, body: 'Ready {{name}}', language: 'en', variables: ['name'] },
    })
    expect((await call('ownerB', 'DELETE', `/setup/notification-templates/${t.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/setup/notification-templates/${t.id}`)).statusCode).toBe(204)
    expect(await prisma.notificationTemplate.findUnique({ where: { id: t.id } })).toBeNull()
    expect((await openEntry('notification_template', t.id))?.tenantId).toBe(T.A)
    expect((await call('ownerB', 'POST', `/trash/notification_template/${t.id}/restore`, {})).statusCode).toBe(404)

    const live = await prisma.notificationTemplate.create({
      data: { tenantId: T.A, channel: 'sms', event: t.event, body: 'New wording', language: 'en' },
    })
    const clash = await call('ownerA', 'POST', `/trash/notification_template/${t.id}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(code(clash)).toBe('TRASH_CLASH')
    await prisma.notificationTemplate.delete({ where: { id: live.id } })

    const ok = await call('ownerA', 'POST', `/trash/notification_template/${t.id}/restore`, {})
    expect(ok.statusCode).toBe(200)
    const back = await prisma.notificationTemplate.findUnique({ where: { id: t.id } })
    expect(back).toMatchObject({ tenantId: T.A, body: 'Ready {{name}}', variables: ['name'] })
  })
})

describe('delivery zone', () => {
  it('round-trips (incl. an empty polygon); a zone of a trashed brand → PARENT_IN_TRASH', async () => {
    const brand = await prisma.concept.create({ data: { name: `${P} brand`, slug: `${P}-brand`, type: 'restaurant', tenantId: T.A } })
    const z = await prisma.deliveryZone.create({ data: { tenantId: T.A, conceptId: brand.id, name: 'Inner DHA', feeCents: 15000, radiusKmMin: 0, radiusKmMax: 5 } })
    expect((await call('ownerB', 'DELETE', `/setup/delivery-zones/${z.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/setup/delivery-zones/${z.id}`)).statusCode).toBe(204)
    expect(await prisma.deliveryZone.findUnique({ where: { id: z.id } })).toBeNull()
    expect(await listIds('ownerB', 'delivery_zone')).not.toContain(z.id)

    // Brand goes to the Trash too (as the brand route would file it).
    await prisma.$transaction(async (tx) => {
      const { moveToTrash } = await import('../src/lib/trash.js')
      await moveToTrash(tx, { userId: U['ceoA']!.id }, { type: 'brand', entityId: brand.id, tenantId: T.A, title: brand.name })
      await tx.concept.update({ where: { id: brand.id }, data: { deletedAt: new Date(), isActive: false } })
    })
    const blocked = await call('ownerA', 'POST', `/trash/delivery_zone/${z.id}/restore`, {})
    expect(blocked.statusCode).toBe(409)
    expect(code(blocked)).toBe('PARENT_IN_TRASH')
    await prisma.concept.update({ where: { id: brand.id }, data: { deletedAt: null } })
    await prisma.trashEntry.updateMany({ where: { entityType: 'brand', entityId: brand.id }, data: { restoredAt: new Date() } })

    const ok = await call('ownerA', 'POST', `/trash/delivery_zone/${z.id}/restore`, {})
    expect(ok.statusCode).toBe(200)
    const back = await prisma.deliveryZone.findUnique({ where: { id: z.id } })
    expect(back).toMatchObject({ tenantId: T.A, conceptId: brand.id, name: 'Inner DHA', feeCents: 15000, radiusKmMax: 5 })
  })
})

describe('bank account', () => {
  it('is never erasable; restore does not set the Raast default; B is blind; finance may restore, a cashier may not', async () => {
    const b = await prisma.bankAccount.create({
      data: { tenantId: T.A, name: `${P} HBL`, bankName: 'HBL', isActive: true, raastDefault: true, raastId: '03001234567' },
    })
    const rb = await prisma.concept.create({ data: { name: `${P} raast brand`, slug: `${P}-raast`, type: 'restaurant', tenantId: T.A, raastBankAccountId: b.id } })
    expect((await call('ownerB', 'DELETE', `/setup/bank-accounts/${b.id}`)).statusCode).toBe(404)
    expect((await call('cashierA', 'DELETE', `/setup/bank-accounts/${b.id}`)).statusCode).toBe(403)
    expect((await call('financeA', 'DELETE', `/setup/bank-accounts/${b.id}?reason=closed`)).statusCode).toBe(204)
    const gone = await prisma.bankAccount.findUnique({ where: { id: b.id } })
    expect(gone).toMatchObject({ isActive: false, raastDefault: false })
    expect(gone!.deletedAt).not.toBeNull()
    expect((await openEntry('bank_account', b.id))?.tenantId).toBe(T.A)
    const aud = await prisma.auditLog.findFirst({ where: { action: 'bank_account.delete', entityId: b.id } })
    expect(aud?.category).toBe('accounting')
    expect(aud?.tenantId).toBe(T.A)

    expect(await listIds('ownerB', 'bank_account')).not.toContain(b.id)
    expect(await listIds('financeA', 'bank_account')).toContain(b.id)
    expect((await call('ceoB', 'POST', `/trash/bank_account/${b.id}/restore`, {})).statusCode).toBe(404)
    expect([403, 404]).toContain((await call('cashierA', 'POST', `/trash/bank_account/${b.id}/restore`, {})).statusCode)

    const purge = await call('ceoA', 'DELETE', `/trash/bank_account/${b.id}`, { reason: 'wants it erased' })
    expect(purge.statusCode).toBe(409)
    expect(code(purge)).toBe('NOT_ERASABLE')
    expect(await prisma.bankAccount.findUnique({ where: { id: b.id } })).not.toBeNull()

    const ok = await call('financeA', 'POST', `/trash/bank_account/${b.id}/restore`, {})
    expect(ok.statusCode).toBe(200)
    const back = await prisma.bankAccount.findUnique({ where: { id: b.id } })
    expect(back!.deletedAt).toBeNull()
    expect(back!.isActive).toBe(true)
    expect(back!.raastDefault).toBe(false)
    // A brand override that pointed at it does not silently revive Raast on it.
    expect((await prisma.concept.findUnique({ where: { id: rb.id } }))!.raastBankAccountId).toBeNull()
  })

  it('a switched-off account comes back switched off', async () => {
    const b = await prisma.bankAccount.create({ data: { tenantId: T.A, name: `${P} Off`, isActive: false } })
    expect((await call('financeA', 'DELETE', `/setup/bank-accounts/${b.id}`)).statusCode).toBe(204)
    expect((await call('financeA', 'POST', `/trash/bank_account/${b.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.bankAccount.findUnique({ where: { id: b.id } }))!.isActive).toBe(false)
  })

  it('a bank whose chart code is gone cannot come back', async () => {
    const b = await prisma.bankAccount.create({ data: { tenantId: T.A, name: `${P} Meezan`, accountCode: '1029' } })
    expect((await call('financeA', 'DELETE', `/setup/bank-accounts/${b.id}`)).statusCode).toBe(204)
    await prisma.account.deleteMany({ where: { tenantId: T.A, code: '1029' } })
    const r = await call('financeA', 'POST', `/trash/bank_account/${b.id}/restore`, {})
    expect(r.statusCode).toBe(409)
    expect(code(r)).toBe('BANK_ACCOUNT_NOT_LINKED')
  })
})

describe('scheduled report', () => {
  it('restore re-checks mayScheduleReport for the creator', async () => {
    await mkUser('creatorOut', 'owner', [T.A], { moduleDeny: ['food_cost', 'accounting'] })
    await mkUser('creatorIn', 'owner', [T.A])
    const mk = (createdById: string, name: string) => prisma.scheduledReport.create({
      data: { tenantId: T.A, name, reportType: 'food_cost', cron: '0 8 * * *', recipients: ['a@b.pk'], createdById },
    })
    const r1 = await mk(U['creatorOut']!.id, `${P} cost-out`)
    const r2 = await mk(U['creatorIn']!.id, `${P} cost-in`)
    expect((await call('ownerB', 'DELETE', `/setup/scheduled-reports/${r1.id}`)).statusCode).toBe(404)
    for (const r of [r1, r2]) expect((await call('ownerA', 'DELETE', `/setup/scheduled-reports/${r.id}`)).statusCode).toBe(204)
    expect(await listIds('ownerB', 'scheduled_report')).not.toContain(r1.id)
    expect((await call('ownerB', 'POST', `/trash/scheduled_report/${r2.id}/restore`, {})).statusCode).toBe(404)

    const refused = await call('ownerA', 'POST', `/trash/scheduled_report/${r1.id}/restore`, {})
    expect(refused.statusCode).toBe(403)
    expect(code(refused)).toBe('REPORT_MODULE_REQUIRED')
    expect((await prisma.scheduledReport.findUnique({ where: { id: r1.id } }))!.deletedAt).not.toBeNull()

    const ok = await call('ownerA', 'POST', `/trash/scheduled_report/${r2.id}/restore`, {})
    expect(ok.statusCode).toBe(200)
    const back = await prisma.scheduledReport.findUnique({ where: { id: r2.id } })
    expect(back!.deletedAt).toBeNull()
    expect(back!.isActive).toBe(true)
  })
})

describe('modifier template', () => {
  it('comes back with its options; the CEO can erase it; B is blind', async () => {
    const t = await prisma.modifierTemplate.create({
      data: { tenantId: T.A, name: `${P} Sauces`, options: { create: [{ name: 'Mayo', sortOrder: 0 }, { name: 'Chilli', sortOrder: 1 }] } },
    })
    expect((await call('ownerB', 'DELETE', `/setup/modifier-templates/${t.id}`)).statusCode).toBe(404)
    expect((await call('ownerA', 'DELETE', `/setup/modifier-templates/${t.id}`)).statusCode).toBe(204)
    expect((await call('ownerA', 'GET', '/setup/modifier-templates')).json() as Array<{ id: string }>).not.toContainEqual(expect.objectContaining({ id: t.id }))
    expect((await call('ownerB', 'POST', `/trash/modifier_template/${t.id}/restore`, {})).statusCode).toBe(404)
    expect((await call('ownerA', 'POST', `/trash/modifier_template/${t.id}/restore`, {})).statusCode).toBe(200)
    const back = await prisma.modifierTemplate.findUnique({ where: { id: t.id }, include: { options: true } })
    expect(back!.deletedAt).toBeNull()
    expect(back!.isActive).toBe(true)
    expect(back!.options.map((o) => o.name).sort()).toEqual(['Chilli', 'Mayo'])

    // Delete again → a NEW entry; the CEO empties it for good.
    expect((await call('ownerA', 'DELETE', `/setup/modifier-templates/${t.id}`)).statusCode).toBe(204)
    expect((await call('ceoA', 'DELETE', `/trash/modifier_template/${t.id}`, { reason: 'cleaning up for good' })).statusCode).toBeLessThan(300)
    expect(await prisma.modifierTemplate.findUnique({ where: { id: t.id } })).toBeNull()
    expect(await prisma.modifierTemplateOption.count({ where: { templateId: t.id } })).toBe(0)
  })
})
