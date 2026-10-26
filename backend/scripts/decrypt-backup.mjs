#!/usr/bin/env node
// Open a servd backup file (owner S13, 2026-10-26).
//
//   node decrypt-backup.mjs <backup file> [output file]
//
// Asks for the backup passphrase (the one set on CEO -> Backups when the file
// was made), then writes the plain database dump next to it (<file>.dump) —
// restore that with pg_restore (the steps are on the Backups page).
// For scripted use the passphrase may come from SERVD_BACKUP_PASSPHRASE.
// Needs only Node 18+; no packages. Same format as
// src/modules/backups/crypto.ts — keep the two in step.

import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'

const MAGIC = 'SERVDBK1'

function fail(msg) { console.error(msg); process.exit(1) }

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(prompt) }
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer) })
  })
}

const [file, outArg] = process.argv.slice(2)
if (!file) fail('Usage: node decrypt-backup.mjs <backup file> [output file]')
if (!fs.existsSync(file)) fail(`No such file: ${file}`)

const size = fs.statSync(file).size
const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(12)
fs.readSync(fd, head, 0, 12, 0)
if (head.subarray(0, 8).toString('ascii') !== MAGIC) fail('This is not a servd backup file.')
const hlen = head.readUInt32BE(8)
if (hlen <= 0 || 12 + hlen + 16 > size) fail('The backup file is damaged (header).')
const hbuf = Buffer.alloc(hlen)
fs.readSync(fd, hbuf, 0, hlen, 12)
fs.closeSync(fd)
const h = JSON.parse(hbuf.toString('utf8'))
if (h.v !== 1) fail(`Unknown backup format version ${h.v}.`)

const passphrase = process.env.SERVD_BACKUP_PASSPHRASE ?? await askHidden('Backup passphrase: ')

let privateKey
try {
  const key = crypto.scryptSync(passphrase.normalize('NFKC'), Buffer.from(h.kdf.salt, 'base64'), 32, { N: h.kdf.N, r: h.kdf.r, p: h.kdf.p, maxmem: 128 * 1024 * 1024 })
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(h.privateKey.iv, 'base64'))
  d.setAuthTag(Buffer.from(h.privateKey.tag, 'base64'))
  const der = Buffer.concat([d.update(Buffer.from(h.privateKey.ct, 'base64')), d.final()])
  privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
} catch {
  fail('Wrong passphrase. Use the passphrase that was set when this backup was made.')
}

const dataKey = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(h.wrappedKey, 'base64'))
const tag = Buffer.alloc(16)
const tfd = fs.openSync(file, 'r'); fs.readSync(tfd, tag, 0, 16, size - 16); fs.closeSync(tfd)
const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(h.iv, 'base64'))
decipher.setAuthTag(tag)

const out = outArg ?? file.replace(/\.servdbackup$/, '') + '.dump'
const tmp = out + '.part'
try {
  await pipeline(fs.createReadStream(file, { start: 12 + hlen, end: size - 17 }), decipher, fs.createWriteStream(tmp))
} catch {
  try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  fail('The backup file is damaged or was changed — it did not pass its check.')
}
fs.renameSync(tmp, out)
console.log(`Opened. Database dump written to: ${out}`)
console.log('Restore it with:  pg_restore --no-owner --no-acl --dbname "<new database URL>" "' + out + '"')
