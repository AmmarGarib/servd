// One mail configuration, one place to read it.
//
// The bug this guards: the settings moved into the database, /health was
// pointed at the new resolver, but the code that actually SENDS kept reading
// process.env. So the test button worked, /health reported email as fine, and
// the real password-reset path silently skipped email — the worst shape of
// failure, because the monitoring said the opposite of the truth.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { emailConfigured, invalidateMailConfig, SMTP_USER_KEY, SMTP_PASS_KEY } from '../src/lib/mailer.js'
import { deliveryConfigured } from '../src/modules/auth/passwordReset.js'
import { invalidateWhatsappConfig, WA_URL_KEY, WA_KEY_KEY } from '../src/lib/whatsapp.js'

const ALL = [SMTP_USER_KEY, SMTP_PASS_KEY, WA_URL_KEY, WA_KEY_KEY]

async function clear() {
  await prisma.setting.deleteMany({ where: { key: { in: ALL } } })
  invalidateMailConfig(); invalidateWhatsappConfig()
}

async function setDb(pairs: Array<[string, string]>) {
  for (const [key, value] of pairs) {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  invalidateMailConfig(); invalidateWhatsappConfig()
}

beforeEach(async () => {
  for (const k of ['SMTP_USER', 'SMTP_PASS', 'WHATSAPP_API_URL', 'WHATSAPP_API_KEY']) delete process.env[k]
  await clear()
})

afterAll(clear)

describe('email config has one source of truth', () => {
  it('agrees with the send path when credentials are in the database', async () => {
    // The exact regression: configured in admin, nothing in env. If the send
    // path reads env directly it disagrees with /health, and /forgot refuses
    // to send while the dashboard says email is fine.
    await setDb([[SMTP_USER_KEY, 'contact@example.com'], [SMTP_PASS_KEY, 'secret']])
    expect(await emailConfigured()).toBe(true)
    expect(await deliveryConfigured()).toBe(true)
  })

  it('agrees when credentials are in the environment instead', async () => {
    process.env['SMTP_USER'] = 'u'; process.env['SMTP_PASS'] = 'p'
    invalidateMailConfig()
    expect(await emailConfigured()).toBe(true)
    expect(await deliveryConfigured()).toBe(true)
  })

  it('agrees that nothing is configured when nothing is', async () => {
    expect(await emailConfigured()).toBe(false)
    expect(await deliveryConfigured()).toBe(false)
  })

  it('counts WhatsApp alone as deliverable', async () => {
    // Password reset can reach a phone even with no email at all.
    await setDb([[WA_URL_KEY, 'https://gw.example/webhook/a/send'], [WA_KEY_KEY, 'sk-x']])
    expect(await emailConfigured()).toBe(false)
    expect(await deliveryConfigured()).toBe(true)
  })

  it('does not treat a user without a password as configured', async () => {
    await setDb([[SMTP_USER_KEY, 'contact@example.com'], [SMTP_PASS_KEY, '']])
    expect(await emailConfigured()).toBe(false)
    expect(await deliveryConfigured()).toBe(false)
  })
})
