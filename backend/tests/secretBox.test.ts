// secretBox — encryption at rest for connector secrets (POS connector, WhatsApp).

import { describe, it, expect, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, isEncrypted, secretHint, secretKeyConfigured } from '../src/lib/secretBox.js'

const ORIGINAL = process.env['SERVD_SECRET_KEY']
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = ORIGINAL
})

describe('secretBox', () => {
  it('round-trips a secret and never stores it in clear', () => {
    process.env['SERVD_SECRET_KEY'] = randomBytes(32).toString('base64')
    const enc = encryptSecret('sk_live_1234567890abcdef')
    expect(isEncrypted(enc)).toBe(true)
    expect(enc).not.toContain('sk_live')
    expect(decryptSecret(enc)).toBe('sk_live_1234567890abcdef')
  })

  it('uses a fresh IV every time', () => {
    process.env['SERVD_SECRET_KEY'] = randomBytes(32).toString('base64')
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('refuses to store a secret without a key (503) and reads legacy plaintext as-is', () => {
    delete process.env['SERVD_SECRET_KEY']
    expect(secretKeyConfigured()).toBe(false)
    expect(() => encryptSecret('x')).toThrow(/SERVD_SECRET_KEY/)
    expect(decryptSecret('plain-old-key')).toBe('plain-old-key')
  })

  it('rejects a key that is not 32 bytes', () => {
    process.env['SERVD_SECRET_KEY'] = Buffer.from('short').toString('base64')
    expect(secretKeyConfigured()).toBe(false)
  })

  it('fails loudly on a value encrypted under another key', () => {
    process.env['SERVD_SECRET_KEY'] = randomBytes(32).toString('base64')
    const enc = encryptSecret('secret')
    process.env['SERVD_SECRET_KEY'] = randomBytes(32).toString('base64')
    expect(() => decryptSecret(enc)).toThrow(/could not be decrypted/)
  })

  it('hints show only the ends', () => {
    expect(secretHint('abcd1234efgh5678')).toBe('abcd…5678')
    expect(secretHint('short')).toBe('sh…')
    expect(secretHint('')).toBe('')
  })
})
