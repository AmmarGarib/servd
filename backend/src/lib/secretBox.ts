// secretBox — encryption at rest for integration secrets (POS connector API
// keys and webhook secrets, the WhatsApp gateway key).
//
// AES-256-GCM with a 32-byte key from env SERVD_SECRET_KEY (base64; generate
// with `openssl rand -base64 32`). Stored format: `enc:v1:<iv>:<tag>:<ct>`
// (each part base64). The key lives only in the box's env — never in the repo
// or the database. Responses never carry a secret: only `secretHint()`.
//
// Without the key, encrypting throws 503 SECRET_KEY_MISSING (a secret can't be
// saved), and decrypting an `enc:v1:` value throws too; plaintext values from
// before encryption existed still read as-is (isEncrypted() tells them apart).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AppError } from './errors.js'

const PREFIX = 'enc:v1:'

function loadKey(): Buffer | null {
  const raw = (process.env['SERVD_SECRET_KEY'] ?? '').trim()
  if (!raw) return null
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) return null
  return key
}

/** True when SERVD_SECRET_KEY is set to a valid base64 32-byte key. */
export function secretKeyConfigured(): boolean {
  return loadKey() !== null
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export function encryptSecret(plain: string): string {
  const key = loadKey()
  if (!key) {
    throw new AppError('SECRET_KEY_MISSING', 'SERVD_SECRET_KEY is not set on the server, so secrets cannot be stored. Ask IT to add it to the API environment.', 503)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

/** Decrypts an `enc:v1:` value; returns a plaintext (legacy) value unchanged. */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value
  const key = loadKey()
  if (!key) {
    throw new AppError('SECRET_KEY_MISSING', 'SERVD_SECRET_KEY is not set on the server, so a stored secret cannot be read.', 503)
  }
  const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(':')
  if (!ivB64 || !tagB64 || ctB64 === undefined) throw new AppError('SECRET_CORRUPT', 'A stored secret is malformed.', 500)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new AppError('SECRET_CORRUPT', 'A stored secret could not be decrypted (wrong SERVD_SECRET_KEY?).', 500)
  }
}

/** First 4 + last 4 characters — enough to recognise which secret is stored. */
export function secretHint(plain: string): string {
  if (!plain) return ''
  if (plain.length <= 10) return `${plain.slice(0, 2)}…`
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`
}
