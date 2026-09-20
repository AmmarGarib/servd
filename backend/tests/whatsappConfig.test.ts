// Where the WhatsApp gateway settings come from.
//
// These two values were env-only, which meant the person who owned them could
// not apply them: signup, password reset and staff sign-in were all down while
// the credentials sat in a browser tab. The DB path exists so that never
// repeats. The env path stays so existing deployments keep working untouched.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { whatsappConfigured, invalidateWhatsappConfig, WA_URL_KEY, WA_KEY_KEY } from '../src/lib/whatsapp.js'

async function setDb(url: string | null, key: string | null) {
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
  if (url !== null) await prisma.setting.create({ data: { key: WA_URL_KEY, value: url } })
  if (key !== null) await prisma.setting.create({ data: { key: WA_KEY_KEY, value: key } })
  invalidateWhatsappConfig()
}

beforeEach(async () => {
  delete process.env['WHATSAPP_API_URL']
  delete process.env['WHATSAPP_API_KEY']
  await setDb(null, null)
})

afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
})

describe('gateway configuration', () => {
  it('reports unconfigured when neither source has a value', async () => {
    expect(await whatsappConfigured()).toBe(false)
  })

  it('uses the environment when the database is empty', async () => {
    // The pre-existing mechanism must keep working with no migration.
    process.env['WHATSAPP_API_URL'] = 'https://gw.example/webhook/a/send'
    process.env['WHATSAPP_API_KEY'] = 'sk-env'
    invalidateWhatsappConfig()
    expect(await whatsappConfigured()).toBe(true)
  })

  it('prefers the database over the environment', async () => {
    // The whole point: the CEO can override a stale env value from admin
    // without touching the server.
    process.env['WHATSAPP_API_URL'] = 'https://stale.example/send'
    await setDb('https://gw.example/webhook/live/send', 'sk-db')
    expect(await whatsappConfigured()).toBe(true)
  })

  it('falls back to the environment when the stored value is cleared', async () => {
    // Saving an empty endpoint means "stop overriding", not "break sending".
    process.env['WHATSAPP_API_URL'] = 'https://gw.example/webhook/a/send'
    process.env['WHATSAPP_API_KEY'] = 'sk-env'
    await setDb('', '')
    expect(await whatsappConfigured()).toBe(true)
  })

  it('treats whitespace as unset rather than as a URL', async () => {
    await setDb('   ', '   ')
    expect(await whatsappConfigured()).toBe(false)
  })

  it('picks up a change once the cache is invalidated', async () => {
    expect(await whatsappConfigured()).toBe(false)
    await setDb('https://gw.example/webhook/a/send', 'sk-db')
    expect(await whatsappConfigured()).toBe(true)
  })
})
