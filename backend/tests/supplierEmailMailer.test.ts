// F5 — supplier chat emails use THE mail settings the admin keeps
// (Configuration → Email: lib/mailer.ts mailConfig, database first, env
// second) through lib/mailer.ts sendEmail — never a transport of their own
// built from SMTP_USER / SMTP_PASS with a hard-coded AWS host.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const mail = vi.hoisted(() => ({ transports: [] as Array<Record<string, unknown>>, sent: [] as Array<Record<string, unknown>> }))
vi.mock('nodemailer', () => {
  const createTransport = (opts: Record<string, unknown>) => {
    mail.transports.push(opts)
    return { sendMail: async (m: Record<string, unknown>) => { mail.sent.push(m); return { messageId: 'mock' } } }
  }
  return { default: { createTransport }, createTransport }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { deliverToSupplier } = await import('../src/lib/supplier-channels.js')
const { invalidateMailConfig, SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY } = await import('../src/lib/mailer.js')

const KEYS = [SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY]
const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'INBOUND_EMAIL_DOMAIN'] as const
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))

const ctx = {
  conversation: { id: 'conv-f5', subject: 'Order' },
  supplier: { id: 'sup-f5', name: 'Fresh Farms', email: 'orders@freshfarms.example', whatsappPhone: null, phone: null, tenantId: null },
  body: 'Please send 10kg', fromStaffName: 'Ali',
}

beforeEach(async () => {
  mail.transports.length = 0
  mail.sent.length = 0
  for (const k of ENV) delete process.env[k]
  await prisma.setting.deleteMany({ where: { key: { in: KEYS } } })
  invalidateMailConfig()
})

afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: KEYS } } })
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  invalidateMailConfig()
})

describe('supplier chat email (F5)', () => {
  it('uses the SMTP settings saved in admin, with the conversation Reply-To', async () => {
    // A leftover env user/pass must not win over the admin's saved settings.
    process.env['SMTP_USER'] = 'env-user'; process.env['SMTP_PASS'] = 'env-pass'
    process.env['INBOUND_EMAIL_DOMAIN'] = 'in.example'
    await prisma.setting.createMany({
      data: [
        { key: SMTP_HOST_KEY, value: 'smtp.admin-set.example' },
        { key: SMTP_PORT_KEY, value: '465' },
        { key: SMTP_USER_KEY, value: 'admin-user' },
        { key: SMTP_PASS_KEY, value: 'admin-pass' },
        { key: SMTP_FROM_KEY, value: 'buying@gsfoods.example' },
      ],
    })
    invalidateMailConfig()
    const r = await deliverToSupplier(ctx)
    expect(r.email, r.errors.join('; ')).toBe('sent')
    expect(mail.transports).toHaveLength(1)
    expect(mail.transports[0]).toMatchObject({ host: 'smtp.admin-set.example', port: 465, secure: true, auth: { user: 'admin-user', pass: 'admin-pass' } })
    expect(mail.sent[0]).toMatchObject({ to: 'orders@freshfarms.example', from: 'servd <buying@gsfoods.example>' })
    expect(mail.sent[0]!['replyTo']).toBe('chat-conv-f5@in.example')
  })

  it('not configured: reported as failed, never a silent "sent", and no transport', async () => {
    const r = await deliverToSupplier(ctx)
    expect(r.email).toBe('failed')
    expect(r.errors.join(' ')).toMatch(/not configured/i)
    expect(mail.transports).toHaveLength(0)
  })
})
