// Test company (owner, 2026-10-14): a test company never contacts anyone
// outside — no customer WhatsApp / email, no webhook, no supplier PO — while
// its staff still get their sign-in codes. Two companies side by side: the
// real one's messages go out, the test one's do not. The transports (the
// WhatsApp gateway's fetch, nodemailer, the webhook queue) are stubbed; the
// funnels above them are real.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const sent = vi.hoisted(() => {
  process.env['SMTP_USER'] = 'smtp-user'
  process.env['SMTP_PASS'] = 'smtp-pass'
  return {
    emails: [] as Array<{ to: string; subject: string }>,
    webhooks: [] as Array<{ subscriptionId: string; event: string }>,
  }
})

vi.mock('nodemailer', () => {
  const createTransport = () => ({
    sendMail: async (m: { to: string; subject: string }) => { sent.emails.push({ to: m.to, subject: m.subject }); return {} },
  })
  return { default: { createTransport }, createTransport }
})

vi.mock('../src/lib/queue.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/queue.js')>()),
  getWebhookQueue: () => ({
    add: async (_name: string, data: { subscriptionId: string; event: string }) => { sent.webhooks.push({ subscriptionId: data.subscriptionId, event: data.event }); return {} },
  }),
}))

import { serviceClient as prisma } from '../src/lib/prisma.js'
import { invalidateWhatsappConfig, WA_URL_KEY, WA_KEY_KEY, sendText } from '../src/lib/whatsapp.js'
import { invalidateTestTenants } from '../src/lib/testCompany.js'
import { sendOrderStatusUpdate, sendPhoneMessage, sendEmail } from '../src/lib/notify.js'
import { customerScope } from '../src/lib/outboundScope.js'
import { updateOrderStatus } from '../src/modules/orders/service.js'
import { sendHandoverCode } from '../src/modules/rider/service.js'
import { startLoginChallenge } from '../src/modules/auth/twoFactor.js'
import { emitDomainEvent } from '../src/lib/webhook-events.js'
import { sendPoToSupplier } from '../src/modules/procurement/service.js'
import { deliverToSupplier } from '../src/lib/supplier-channels.js'
import { deliverToCustomer } from '../src/lib/customer-channels.js'

const RUN = Date.now().toString(36)
let realTenant = ''
let testTenant = ''
let realConcept = ''
let testConcept = ''
let staffUser = ''

// Distinct numbers per company so a send can be attributed.
const REAL_PHONE = '923001110001'
const TEST_PHONE = '923002220002'
const REAL_EMAIL = `real.${RUN}@example.com`
const TEST_EMAIL = `test.${RUN}@example.com`

const waTo: string[] = []
function stubGateway() {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { number?: string }
    if (body.number) waTo.push(body.number)
    return { ok: true, json: async () => ({ ok: true }), text: async () => '' }
  }) as unknown as typeof fetch)
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}
/** Give fire-and-forget sends time to land before asserting that one did NOT. */
const settle = () => new Promise((r) => setTimeout(r, 300))

async function mkOrder(conceptId: string, phone: string, status = 'confirmed') {
  const customer = (await prisma.customer.findFirst({ where: { phone: `+${phone}` } }))
    ?? (await prisma.customer.create({ data: { name: `Guest ${phone}`, phone: `+${phone}` } as never }))
  return prisma.order.create({
    data: {
      conceptId, customerId: customer.id, source: 'servd', status, totalCents: 10_000, placedAt: new Date(),
      deliveryOtp: '4321',
      items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: 10_000 }] },
    } as never,
  })
}

beforeAll(async () => {
  realTenant = (await prisma.tenant.create({ data: { name: 'Real Co', slug: `real-${RUN}` } })).id
  testTenant = (await prisma.tenant.create({ data: { name: 'Test Co', slug: `testco-${RUN}`, isTest: true } })).id
  realConcept = (await prisma.concept.create({ data: { name: 'Real Brand', slug: `rb-${RUN}`, type: 'restaurant', tenantId: realTenant } as never })).id
  testConcept = (await prisma.concept.create({ data: { name: 'Test Brand', slug: `tb-${RUN}`, type: 'restaurant', tenantId: testTenant } as never })).id
  staffUser = (await prisma.user.create({
    data: { name: 'Test Co Manager', email: `mgr.${RUN}@gsfoods.pk`, password: 'x', role: 'manager', tenantId: testTenant, twoFactorPhone: '923003330003' } as never,
  })).id
  invalidateTestTenants()
})

beforeEach(async () => {
  vi.unstubAllGlobals()
  stubGateway()
  waTo.length = 0
  sent.emails.length = 0
  sent.webhooks.length = 0
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
  await prisma.setting.create({ data: { key: WA_URL_KEY, value: 'https://gw.example/webhook/abc/send' } })
  await prisma.setting.create({ data: { key: WA_KEY_KEY, value: 'sk-test' } })
  invalidateWhatsappConfig()
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
})

describe('customer messages: a test company never sends', () => {
  it('an order status change messages the real company\'s customer, never the test company\'s', async () => {
    const real = await mkOrder(realConcept, REAL_PHONE)
    const test = await mkOrder(testConcept, TEST_PHONE)
    await updateOrderStatus(real.id, 'preparing')
    await updateOrderStatus(test.id, 'preparing')
    await waitFor(() => waTo.includes(REAL_PHONE))
    await settle()
    expect(waTo).toContain(REAL_PHONE)
    expect(waTo).not.toContain(TEST_PHONE)
  })

  it('the notify helpers skip a test company by email and WhatsApp', async () => {
    const base = { conceptName: 'Brand', orderId: 'ord_abcdefgh12345678', status: 'ready', customerName: 'A' }
    await sendOrderStatusUpdate({ ...base, email: REAL_EMAIL, tenantId: realTenant })
    await sendOrderStatusUpdate({ ...base, email: TEST_EMAIL, tenantId: testTenant })
    await sendOrderStatusUpdate({ ...base, phone: REAL_PHONE, tenantId: realTenant })
    await sendOrderStatusUpdate({ ...base, phone: TEST_PHONE, tenantId: testTenant })
    expect(sent.emails.map((e) => e.to)).toEqual([REAL_EMAIL])
    expect(waTo).toEqual([REAL_PHONE])

    await sendEmail(TEST_EMAIL, 'x', '<p>x</p>', 'test', customerScope(testTenant))
    await sendPhoneMessage(TEST_PHONE, 'x', 'test', customerScope(testTenant))
    const res = await sendText(TEST_PHONE, 'x', customerScope(testTenant))
    expect(res).toMatchObject({ practice: true, testCompany: true })
    expect(sent.emails.map((e) => e.to)).toEqual([REAL_EMAIL])
    expect(waTo).toEqual([REAL_PHONE])
  })

  it('the rider hand-over code reaches the real company\'s customer only', async () => {
    const real = await mkOrder(realConcept, REAL_PHONE, 'ready')
    const test = await mkOrder(testConcept, TEST_PHONE, 'ready')
    await sendHandoverCode(real.id)
    await sendHandoverCode(test.id)
    expect(waTo).toEqual([REAL_PHONE])
  })

  it('CRM chat to a customer is skipped for a test company', async () => {
    const customer = { id: 'c1', name: 'Guest', email: TEST_EMAIL, phone: TEST_PHONE }
    const conversation = { id: 'conv1', subject: null }
    const blocked = await deliverToCustomer({ conversation, customer, body: 'hi', fromStaffName: 'Staff', tenantId: testTenant })
    expect(blocked).toMatchObject({ email: 'skipped', whatsapp: 'skipped' })
    expect(sent.emails).toHaveLength(0)
    expect(waTo).toHaveLength(0)
    const real = await deliverToCustomer({ conversation, customer: { ...customer, email: REAL_EMAIL, phone: REAL_PHONE }, body: 'hi', fromStaffName: 'Staff', tenantId: realTenant })
    expect(real).toMatchObject({ email: 'sent', whatsapp: 'sent' })
  })
})

describe('staff messages are never blocked', () => {
  it('a test company\'s manager still gets the 2FA code', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: staffUser }, select: { id: true, twoFactorPhone: true, email: true } })
    const res = await startLoginChallenge(u)
    expect(res.challengeToken).toBeTruthy()
    expect(waTo).toContain('923003330003')
    expect(sent.emails.map((e) => e.to)).toContain(u.email!.toLowerCase())
  })

  it('a send with no scope, or a staff scope, goes out for a test company', async () => {
    await sendText(TEST_PHONE, 'code 1234')
    await sendText(TEST_PHONE, 'code 1234', { tenantId: testTenant, audience: 'staff' })
    expect(waTo).toEqual([TEST_PHONE, TEST_PHONE])
  })
})

describe('outside parties: a test company never calls out', () => {
  it('webhook events of a test company are not queued; a real company\'s are', async () => {
    const realSub = await prisma.webhookSubscription.create({ data: { url: 'https://real.example/hook', secret: 's', events: ['order.delivered'], tenantId: realTenant } as never })
    await prisma.webhookSubscription.create({ data: { url: 'https://test.example/hook', secret: 's', events: ['order.delivered'], tenantId: testTenant } as never })
    await emitDomainEvent('order.delivered', { orderId: 'x' }, testTenant)
    expect(sent.webhooks).toHaveLength(0)
    await emitDomainEvent('order.delivered', { orderId: 'y' }, realTenant)
    expect(sent.webhooks).toEqual([{ subscriptionId: realSub.id, event: 'order.delivered' }])
  })

  it('a test company\'s PO is not sent to the supplier but moves on as sent; a real one is sent', async () => {
    const testSupplier = await prisma.supplier.create({ data: { name: 'Test Supplier', email: TEST_EMAIL, whatsappPhone: TEST_PHONE, tenantId: testTenant } as never })
    const realSupplier = await prisma.supplier.create({ data: { name: 'Real Supplier', email: REAL_EMAIL, whatsappPhone: REAL_PHONE, tenantId: realTenant } as never })
    const testPo = await prisma.purchaseOrder.create({ data: { supplierId: testSupplier.id, status: 'approved' } as never })
    const realPo = await prisma.purchaseOrder.create({ data: { supplierId: realSupplier.id, status: 'approved' } as never })

    const t = await sendPoToSupplier(testPo.id, staffUser)
    expect(t).toMatchObject({ status: 'sent', channels: [], testCompany: true })
    expect(sent.emails).toHaveLength(0)
    expect(waTo).toHaveLength(0)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: testPo.id } })).status).toBe('sent')

    const r = await sendPoToSupplier(realPo.id, staffUser)
    expect(r.channels).toEqual(expect.arrayContaining(['email', 'whatsapp']))
    expect(sent.emails.map((e) => e.to)).toEqual([REAL_EMAIL])
    expect(waTo).toEqual([REAL_PHONE])
  })

  it('supplier chat to a test company\'s supplier is skipped (company read from the supplier row)', async () => {
    const s = await prisma.supplier.create({ data: { name: 'Chat Supplier', whatsappPhone: TEST_PHONE, tenantId: testTenant } as never })
    const res = await deliverToSupplier({
      conversation: { id: 'sconv1', subject: null },
      supplier: { id: s.id, name: s.name, email: null, whatsappPhone: TEST_PHONE, phone: null },
      body: 'hello', fromStaffName: 'Staff',
    })
    expect(res).toMatchObject({ email: 'skipped', whatsapp: 'skipped' })
    expect(waTo).toHaveLength(0)
  })
})
