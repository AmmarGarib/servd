// Evidence files uploaded as base64 and stored as bytes in the database (file
// storage is not configured on every server): the signed cash-voucher photo,
// cash-request receipts, bad-debt write-off evidence.
//
// ONE decoder and ONE sender, so every upload is checked the same way:
//   - JPEG / PNG / WebP, and PDF only where the caller allows it;
//   - a `data:<mime>;base64,` prefix is accepted and must agree with `mime`;
//   - the bytes must really be the declared type (magic numbers — PDF starts
//     '%PDF-'), so a script can never be stored as an "image";
//   - at most `maxBytes` decoded (3 MB by default; the admin compresses photos
//     before sending), refused before decoding when the base64 is already too
//     long.
// Anything else is 400 BAD_PHOTO for an images-only caller, 400 BAD_FILE when
// PDFs are allowed. Served back inline with its stored type, nosniff and
// private no-store — never cached by a shared proxy.

import type { FastifyReply } from 'fastify'
import { AppError } from './errors.js'

/** The default largest decoded upload: 3 MB. */
export const EVIDENCE_MAX_BYTES = 3 * 1024 * 1024
const EVIDENCE_MIN_BYTES = 32

export const EVIDENCE_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const
export type EvidenceMime = keyof typeof EVIDENCE_EXT
export type ImageMime = Exclude<EvidenceMime, 'application/pdf'>

export const isEvidenceMime = (m: string): m is EvidenceMime => Object.prototype.hasOwnProperty.call(EVIDENCE_EXT, m)
export const isImageMime = (m: string): m is ImageMime => isEvidenceMime(m) && m !== 'application/pdf'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** True when the bytes really are the declared type (magic numbers). */
export function magicMatches(mime: EvidenceMime, buf: Buffer): boolean {
  switch (mime) {
    case 'image/jpeg': return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    case 'image/png': return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)
    case 'image/webp': return buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP'
    case 'application/pdf': return buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-'
  }
}

const sizeLabel = (bytes: number) =>
  bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * Decode and check one uploaded file. `allowPdf` false (the default) takes
 * images only and answers 400 BAD_PHOTO; true also takes a PDF and answers
 * 400 BAD_FILE.
 */
export function decodeEvidenceFile(
  dataBase64: string,
  mime: string,
  opts: { allowPdf?: boolean; maxBytes?: number } = {},
): { bytes: Buffer; mime: EvidenceMime; sizeBytes: number } {
  const allowPdf = opts.allowPdf ?? false
  const maxBytes = opts.maxBytes ?? EVIDENCE_MAX_BYTES
  const noun = allowPdf ? 'file' : 'photo'
  const bad = (message: string) => new AppError(allowPdf ? 'BAD_FILE' : 'BAD_PHOTO', message, 400)
  const tooLarge = () => bad(allowPdf
    ? `The file is larger than ${sizeLabel(maxBytes)} — scan or photograph it at a lower resolution`
    : `The photo is larger than ${sizeLabel(maxBytes)} — take it again at a lower resolution`)
  const wrongType = () => bad(`The ${noun} is not the ${allowPdf ? 'file' : 'image'} type it says it is`)

  const declared = mime.trim().toLowerCase()
  if (!isEvidenceMime(declared) || (!allowPdf && declared === 'application/pdf')) {
    throw bad(allowPdf ? 'The file must be a JPEG, PNG or WebP image, or a PDF' : 'The photo must be a JPEG, PNG or WebP image')
  }
  let b64 = dataBase64
  const dataUrl = /^data:([^;,]+);base64,/i.exec(b64)
  if (dataUrl) {
    if (dataUrl[1]!.trim().toLowerCase() !== declared) throw wrongType()
    b64 = b64.slice(dataUrl[0].length)
  }
  b64 = b64.replace(/\s+/g, '')
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw bad(`The ${noun} could not be read — send it as base64`)
  }
  // Refuse an oversized upload before decoding it.
  if (Math.floor((b64.length * 3) / 4) - 2 > maxBytes) throw tooLarge()
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length > maxBytes) throw tooLarge()
  if (bytes.length < EVIDENCE_MIN_BYTES) throw bad(`The ${noun} is empty or cut off`)
  if (!magicMatches(declared, bytes)) throw wrongType()
  return { bytes, mime: declared, sizeBytes: bytes.length }
}

/**
 * Send a stored evidence row back inline. `filename` is the download name; the
 * extension of the stored type is added when it is missing. A row whose stored
 * type is not one we accept goes out as application/octet-stream.
 */
export function sendEvidence(
  reply: FastifyReply,
  row: { mime: string; data: Uint8Array },
  filename: string,
): FastifyReply {
  const known = isEvidenceMime(row.mime)
  const ext = known ? EVIDENCE_EXT[row.mime as EvidenceMime] : 'bin'
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file'
  const name = safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`
  return reply
    .header('Content-Type', known ? row.mime : 'application/octet-stream')
    .header('Content-Disposition', `inline; filename="${name}"`)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(Buffer.from(row.data))
}
