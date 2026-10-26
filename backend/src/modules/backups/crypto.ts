// The backup file's encryption (owner S13, 2026-10-26: a weekly file the CEO
// downloads; "useless without the passphrase").
//
// The weekly job runs with nobody at the keyboard, so it cannot know the
// passphrase — and the passphrase is never stored. So the key is split:
//   • When the CEO sets a passphrase, servd makes an RSA key pair. The PUBLIC
//     key is stored in plain; the PRIVATE key is stored only encrypted with a
//     key derived from the passphrase (scrypt → AES-256-GCM). That encrypted
//     blob is also the verifier: a wrong passphrase fails its GCM check.
//   • Each backup gets a fresh random 256-bit data key. The dump is encrypted
//     with it (AES-256-GCM, streamed); the data key is wrapped with the public
//     key (RSA-OAEP-SHA256).
//   • The file carries everything needed to open it EXCEPT the passphrase:
//     its header holds the passphrase-encrypted private key, the wrapped data
//     key and the IV; the GCM tag is the last 16 bytes.
// Opening a file therefore needs the passphrase that was in force when it was
// made. scripts/decrypt-backup.mjs is the stand-alone opener (same format —
// keep the two in step).
//
// File layout:  "SERVDBK1" | uint32 BE header length | header JSON | ciphertext | 16-byte GCM tag

import crypto from 'node:crypto'

export const MAGIC = Buffer.from('SERVDBK1', 'ascii')
export const MIN_PASSPHRASE = 12
const SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const
const SCRYPT_MAXMEM = 128 * 1024 * 1024

export interface KdfParams { alg: 'scrypt'; salt: string; N: number; r: number; p: number }
export interface SealedBlob { iv: string; tag: string; ct: string }

/** What servd stores (Setting backup.key). Holds no passphrase and nothing that opens a backup without it. */
export interface BackupKeyBundle {
  v: 1
  keyId: string
  publicKey: string        // SPKI PEM
  kdf: KdfParams
  privateKey: SealedBlob   // PKCS#8 DER, AES-256-GCM under scrypt(passphrase)
  setAt: string
}

export interface BackupHeader {
  v: 1
  keyId: string
  kdf: KdfParams
  privateKey: SealedBlob
  wrappedKey: string       // the data key, RSA-OAEP-SHA256
  iv: string               // the data IV (12 bytes)
  createdAt: string
}

function deriveKey(passphrase: string, kdf: KdfParams): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM })
}

/** A new key pair sealed under the passphrase. */
export function makeKeyBundle(passphrase: string, now: Date = new Date()): BackupKeyBundle {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const kdf: KdfParams = { alg: 'scrypt', salt: crypto.randomBytes(16).toString('base64'), ...SCRYPT }
  const key = deriveKey(passphrase, kdf)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(privateKey.export({ type: 'pkcs8', format: 'der' })), c.final()])
  return {
    v: 1,
    keyId: crypto.createHash('sha256').update(spki).digest('hex').slice(0, 16),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    kdf,
    privateKey: { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') },
    setAt: now.toISOString(),
  }
}

/** The private key, or null for a wrong passphrase. */
export function openPrivateKey(passphrase: string, kdf: KdfParams, sealed: SealedBlob): crypto.KeyObject | null {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, kdf), Buffer.from(sealed.iv, 'base64'))
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    const der = Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()])
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } catch {
    return null
  }
}

export function passphraseMatches(passphrase: string, bundle: BackupKeyBundle): boolean {
  return openPrivateKey(passphrase, bundle.kdf, bundle.privateKey) !== null
}

/** A fresh data key + IV for one file, and its header (the cipher is the caller's to stream). */
export function startFile(bundle: BackupKeyBundle, now: Date = new Date()): { header: Buffer; cipher: crypto.CipherGCM } {
  const dataKey = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const wrapped = crypto.publicEncrypt({ key: bundle.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dataKey)
  const h: BackupHeader = {
    v: 1, keyId: bundle.keyId, kdf: bundle.kdf, privateKey: bundle.privateKey,
    wrappedKey: wrapped.toString('base64'), iv: iv.toString('base64'), createdAt: now.toISOString(),
  }
  const json = Buffer.from(JSON.stringify(h), 'utf8')
  const len = Buffer.alloc(4); len.writeUInt32BE(json.length, 0)
  return { header: Buffer.concat([MAGIC, len, json]), cipher: crypto.createCipheriv('aes-256-gcm', dataKey, iv) }
}
