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
//
// `allowOffice` (opt-in, cash-voucher supporting documents 2026-10-15) also
// takes Office and text files, named by `fileName` — the EXTENSION decides
// the type and the declared mime and the magic bytes must both agree with it:
//   xlsx / docx / pptx — a ZIP (PK\x03\x04) holding [Content_Types].xml and
//                        the part folder of that kind (xl/, word/, ppt/);
//   xls / doc / ppt    — an OLE compound file (D0 CF 11 E0 A1 B1 1A E1);
//   csv / txt          — valid UTF-8 with no NUL byte and no markup start.
// HTML, SVG, scripts, executables and anything unnamed are always refused.
// Office and text files go back as an ATTACHMENT (never rendered inline);
// only images and PDFs are served inline.

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

/** Office / text documents (allowOffice only): stored type → file extension and its magic family. */
export const OFFICE_TYPES = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', magic: 'zip', part: 'xl/' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', magic: 'zip', part: 'word/' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: 'pptx', magic: 'zip', part: 'ppt/' },
  'application/vnd.ms-excel': { ext: 'xls', magic: 'ole', part: null },
  'application/msword': { ext: 'doc', magic: 'ole', part: null },
  'application/vnd.ms-powerpoint': { ext: 'ppt', magic: 'ole', part: null },
  'text/csv': { ext: 'csv', magic: 'text', part: null },
  'text/plain': { ext: 'txt', magic: 'text', part: null },
} as const
export type OfficeMime = keyof typeof OFFICE_TYPES
export const isOfficeMime = (m: string): m is OfficeMime => Object.prototype.hasOwnProperty.call(OFFICE_TYPES, m)

/** A file extension → the one type it is stored as (allowOffice). */
const TYPE_OF_EXT: Record<string, EvidenceMime | OfficeMime> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf',
  ...Object.fromEntries(Object.entries(OFFICE_TYPES).map(([m, t]) => [t.ext, m as OfficeMime])),
}
/** Declared types a browser sends for a file besides its own (CSV is often sent as Excel). */
const DECLARED_ALIASES: Record<string, readonly string[]> = {
  csv: ['application/vnd.ms-excel', 'application/csv', 'text/plain', 'text/comma-separated-values'],
  jpg: ['image/jpg', 'image/pjpeg'], jpeg: ['image/jpg', 'image/pjpeg'],
}
const GENERIC_DECLARED = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

function officeMagicMatches(mime: OfficeMime, buf: Buffer): boolean {
  const t = OFFICE_TYPES[mime]
  if (t.magic === 'zip') {
    if (!(buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) return false
    // File names in a ZIP's headers are stored as-is: an OOXML package names its parts.
    return buf.includes('[Content_Types].xml', 0, 'latin1') && buf.includes(t.part!, 0, 'latin1')
  }
  if (t.magic === 'ole') return buf.length >= 8 && buf.subarray(0, 8).equals(OLE_SIGNATURE)
  if (buf.includes(0)) return false
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return false }
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 64).toLowerCase()
  return !/^<(!doctype|html|svg|script|\?xml|body|head|iframe)/.test(head)
}
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
  opts: { allowPdf?: boolean; maxBytes?: number; allowOffice?: false } ,
): { bytes: Buffer; mime: EvidenceMime; sizeBytes: number }
export function decodeEvidenceFile(
  dataBase64: string,
  mime: string,
  opts: { maxBytes?: number; allowOffice: true; fileName: string },
): { bytes: Buffer; mime: EvidenceMime | OfficeMime; sizeBytes: number; fileName: string }
export function decodeEvidenceFile(dataBase64: string, mime: string): { bytes: Buffer; mime: EvidenceMime; sizeBytes: number }
export function decodeEvidenceFile(
  dataBase64: string,
  mime: string,
  opts: { allowPdf?: boolean; maxBytes?: number; allowOffice?: boolean; fileName?: string } = {},
): { bytes: Buffer; mime: EvidenceMime | OfficeMime; sizeBytes: number; fileName?: string } {
  if (opts.allowOffice) return decodeDocumentFile(dataBase64, mime, opts.fileName ?? '', opts.maxBytes ?? EVIDENCE_MAX_BYTES)
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

/** A stored file name: no path, no control or quote characters, ≤ 120 characters, extension kept. */
export function safeFileName(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  if (!cleaned) return fallback
  if (cleaned.length <= 120) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 && cleaned.length - dot <= 6 ? cleaned.slice(dot) : ''
  return cleaned.slice(0, 120 - ext.length) + ext
}

/** decodeEvidenceFile with allowOffice: the extension decides the type; declared mime and magic bytes must agree. */
function decodeDocumentFile(dataBase64: string, mime: string, fileName: string, maxBytes: number): { bytes: Buffer; mime: EvidenceMime | OfficeMime; sizeBytes: number; fileName: string } {
  const bad = (message: string) => new AppError('BAD_FILE', message, 400)
  const kinds = 'a PDF, a JPG / PNG / WebP image, an Excel, Word or PowerPoint file, or a CSV / text file'
  const name = safeFileName(fileName, '')
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const type = TYPE_OF_EXT[ext]
  if (!name || !type) throw bad(`The file must be ${kinds} (name it with its extension)`)
  const declared = mime.trim().toLowerCase()
  if (declared !== type && !GENERIC_DECLARED.has(declared) && !(DECLARED_ALIASES[ext] ?? []).includes(declared)) {
    throw bad(`The file "${name}" is not the type it says it is`)
  }
  let b64 = dataBase64
  const dataUrl = /^data:([^;,]*);base64,/i.exec(b64)
  if (dataUrl) b64 = b64.slice(dataUrl[0].length)
  b64 = b64.replace(/\s+/g, '')
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) throw bad('The file could not be read — send it as base64')
  const tooLarge = () => bad(`The file is larger than ${sizeLabel(maxBytes)}`)
  if (Math.floor((b64.length * 3) / 4) - 2 > maxBytes) throw tooLarge()
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length > maxBytes) throw tooLarge()
  const textual = isOfficeMime(type) && OFFICE_TYPES[type].magic === 'text'
  if (bytes.length < (textual ? 1 : EVIDENCE_MIN_BYTES)) throw bad('The file is empty or cut off')
  const ok = isOfficeMime(type) ? officeMagicMatches(type, bytes) : magicMatches(type, bytes)
  if (!ok) throw bad(`The file "${name}" is not the type its name says it is`)
  return { bytes, mime: type, sizeBytes: bytes.length, fileName: name }
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
  const office = isOfficeMime(row.mime)
  const known = isEvidenceMime(row.mime) || office
  const ext = isEvidenceMime(row.mime) ? EVIDENCE_EXT[row.mime] : office ? OFFICE_TYPES[row.mime as OfficeMime].ext : 'bin'
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file'
  const name = safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`
  // Only images and PDFs are shown in the browser; everything else downloads.
  const disposition = isEvidenceMime(row.mime) ? 'inline' : 'attachment'
  return reply
    .header('Content-Type', known ? (row.mime.startsWith('text/') ? `${row.mime}; charset=utf-8` : row.mime) : 'application/octet-stream')
    .header('Content-Disposition', `${disposition}; filename="${name}"`)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(Buffer.from(row.data))
}
