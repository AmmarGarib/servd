// Where the WhatsApp gateway settings come from.
//
// These two values were env-only, which meant the person who owned them could
// not apply them: signup, password reset and staff sign-in were all down while
// the credentials sat in a browser tab. The DB path exists so that never
// repeats. The env path stays so existing deployments keep working untouched.
//
// The key is encrypted at rest (lib/secretBox, SERVD_SECRET_KEY — POS
// connector spec D14/D15): saved as `enc:v1:`, a legacy plaintext key is
// re-encrypted on first read when the server has the key, and without the
// key a plaintext key keeps working while /health warns.
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import {
  whatsappConfigured, invalidateWhatsappConfig, WA_URL_KEY, WA_KEY_KEY,
  saveWhatsappSettings, whatsappSettingsView, whatsappSecretHealth, sendText,
} from '../src/lib/whatsapp.js'
import { decryptSecret, encryptSecret, isEncrypted } from '../src/lib/secretBox.js'

const TEST_KEY = Buffer.alloc(32, 9).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 3).toString('base64')
const prevSecretKey = process.env['SERVD_SECRET_KEY']

async function setDb(url: string | null, key: string | null) {
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
  if (url !== null) await prisma.setting.create({ data: { key: WA_URL_KEY, value: url } })
  if (key !== null) await prisma.setting.create({ data: { key: WA_KEY_KEY, value: key } })
  invalidateWhatsappConfig()
}

beforeEach(async () => {
  delete process.env['WHATSAPP_API_URL']
  delete process.env['WHATSAPP_API_KEY']
  delete process.env['SERVD_SECRET_KEY']
  await setDb(null, null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
  if (prevSecretKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevSecretKey
})

async function storedKey(): Promise<string | null> {
  return (await prisma.setting.findUnique({ where: { key: WA_KEY_KEY } }))?.value ?? null
}

/** Capture the x-api-key the gateway would receive (no network). */
function captureFetch(): { keys: string[] } {
  const seen = { keys: [] as string[] }
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    seen.keys.push(init.headers['x-api-key'] ?? '')
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return seen
}

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

describe('the gateway key is encrypted at rest', () => {
  it('a saved key is stored as enc:v1: and the view shows only a hint', async () => {
    process.env['SERVD_SECRET_KEY'] = TEST_KEY
    const secret = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789'
    await saveWhatsappSettings({ apiUrl: 'https://gw.example/webhook/a/send', apiKey: secret })
    const raw = await storedKey()
    expect(raw?.startsWith('enc:v1:')).toBe(true)
    expect(raw).not.toContain(secret)
    expect(decryptSecret(raw!)).toBe(secret)
    const view = await whatsappSettingsView()
    expect(view).toMatchObject({ apiKeyHint: 'sk-l…6789', keyAtRest: 'encrypted', source: 'database', configured: true, scope: 'platform' })
    expect(JSON.stringify(view)).not.toContain(secret)
    // …and it is the real key the gateway receives.
    const seen = captureFetch()
    await sendText('923001234567', 'hi')
    expect(seen.keys).toEqual([secret])
    expect((await whatsappSecretHealth()).check).toBe('ok')
  })

  it('without SERVD_SECRET_KEY a new key is refused (503) and nothing is written', async () => {
    await setDb('https://gw.example/webhook/a/send', null)
    await expect(saveWhatsappSettings({ apiUrl: 'https://gw.example/webhook/b/send', apiKey: 'sk-new' }))
      .rejects.toMatchObject({ code: 'SECRET_KEY_MISSING', statusCode: 503 })
    expect(await storedKey()).toBeNull()
    // The URL was not half-saved either.
    expect((await prisma.setting.findUnique({ where: { key: WA_URL_KEY } }))?.value).toBe('https://gw.example/webhook/a/send')
  })

  it('without SERVD_SECRET_KEY the URL can still be corrected and the key cleared', async () => {
    await setDb('https://gw.example/webhook/a/send', 'sk-legacy')
    await saveWhatsappSettings({ apiUrl: 'https://gw.example/webhook/b/send' })
    expect(await storedKey()).toBe('sk-legacy')
    await saveWhatsappSettings({ apiUrl: 'https://gw.example/webhook/b/send', apiKey: '' })
    expect(await storedKey()).toBe('')
  })

  it('a legacy plaintext key is re-encrypted on first read once the server has the key (idempotent)', async () => {
    await setDb('https://gw.example/webhook/a/send', 'sk-legacy-plaintext-key')
    process.env['SERVD_SECRET_KEY'] = TEST_KEY
    invalidateWhatsappConfig()
    const seen = captureFetch()
    await sendText('923001234567', 'hi')
    expect(seen.keys).toEqual(['sk-legacy-plaintext-key'])
    const first = await storedKey()
    expect(isEncrypted(first)).toBe(true)
    expect(decryptSecret(first!)).toBe('sk-legacy-plaintext-key')
    // A second read leaves the encrypted row alone.
    invalidateWhatsappConfig()
    await whatsappConfigured()
    await whatsappSettingsView()
    expect(await storedKey()).toBe(first)
    expect((await whatsappSecretHealth()).check).toBe('ok')
  })

  it('without SERVD_SECRET_KEY a legacy plaintext key keeps working and /health warns', async () => {
    await setDb('https://gw.example/webhook/a/send', 'sk-legacy-plaintext-key')
    const seen = captureFetch()
    await sendText('923001234567', 'hi')
    expect(seen.keys).toEqual(['sk-legacy-plaintext-key'])
    expect(await storedKey()).toBe('sk-legacy-plaintext-key')
    const health = await whatsappSecretHealth()
    expect(health.check).toBe('warn')
    expect(health.detail).toMatch(/SERVD_SECRET_KEY/)
    expect((await whatsappSettingsView()).keyAtRest).toBe('plaintext')
  })

  it('an encrypted key this server cannot read is never sent; the env key is used and /health warns', async () => {
    process.env['SERVD_SECRET_KEY'] = OTHER_KEY
    const enc = encryptSecret('sk-from-another-server')
    process.env['SERVD_SECRET_KEY'] = TEST_KEY   // the wrong key
    process.env['WHATSAPP_API_KEY'] = 'sk-env'
    await setDb('https://gw.example/webhook/a/send', enc)
    const seen = captureFetch()
    await sendText('923001234567', 'hi')
    expect(seen.keys).toEqual(['sk-env'])
    expect((await whatsappSecretHealth()).check).toBe('warn')
    const view = await whatsappSettingsView()
    expect(view.keyAtRest).toBe('unreadable')
    expect(JSON.stringify(view)).not.toContain(enc)
    // Nothing rewrote the row.
    expect(await storedKey()).toBe(enc)
  })

  it('DB-over-env precedence is unchanged with an encrypted key', async () => {
    process.env['SERVD_SECRET_KEY'] = TEST_KEY
    process.env['WHATSAPP_API_URL'] = 'https://stale.example/send'
    process.env['WHATSAPP_API_KEY'] = 'sk-env'
    await saveWhatsappSettings({ apiUrl: 'https://gw.example/webhook/live/send', apiKey: 'sk-db-key-1234' })
    const seen = captureFetch()
    await sendText('923001234567', 'hi')
    expect(seen.keys).toEqual(['sk-db-key-1234'])
    expect((vi.mocked(fetch).mock.calls[0]?.[0])).toBe('https://gw.example/webhook/live/send')
    // Cleared in the database → the environment again.
    await saveWhatsappSettings({ apiUrl: '', apiKey: '' })
    const again = captureFetch()
    await sendText('923001234567', 'hi')
    expect(again.keys).toEqual(['sk-env'])
    expect((await whatsappSettingsView()).source).toBe('environment')
    expect((await whatsappSecretHealth()).check).toBe('off')
  })
})
