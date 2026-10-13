// On-account client cards (finance wave B, owner 2026-10-13: "client gets a QR
// code the cashier scans").
//
// A card code is 20 Crockford base32 characters (100 random bits from
// crypto.randomBytes) printed as SVOA-XXXXX-XXXXX-XXXXX-XXXXX and encoded in
// the card's QR. servd stores only its sha256 (CustomerAccountCard.tokenHash,
// unique per company) and the last four characters (tokenHint) — the full
// code is shown ONCE, when the card is issued, for printing, and is never
// logged. A scan or a typed code is normalised the same forgiving way (case,
// spaces, dashes, the SVOA prefix, O→0, I/L→1) and looked up by hash inside
// the till's company.

import { createHash, randomBytes } from 'node:crypto'

/** Crockford base32: no I, L, O or U — nothing a cashier can misread. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 20
const PREFIX = 'SVOA'

/** 'SVOA-XXXXX-XXXXX-XXXXX-XXXXX' from 20 normalised characters. */
export function formatCardCode(normalized: string): string {
  return [PREFIX, ...normalized.match(/.{1,5}/g)!].join('-')
}

/** A new card: the printable code (shown once), its hash and its hint. */
export function newCardCode(): { code: string; hash: string; hint: string } {
  const bytes = randomBytes(CODE_LENGTH)
  // 256 is a multiple of 32, so `byte & 31` is uniform over the alphabet.
  let body = ''
  for (const b of bytes) body += CROCKFORD[b & 31]
  return { code: formatCardCode(body), hash: hashCardCode(body), hint: cardHintOf(body) }
}

/**
 * A scanned or typed code to its 20 canonical characters, or null when it
 * cannot be a card code: upper-cased, spaces and dashes removed, a leading
 * SVOA dropped, O → 0 and I / L → 1.
 */
export function normalizeCardCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.toUpperCase().replace(/[\s-]+/g, '')
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length)
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== CODE_LENGTH) return null
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null
  return s
}

/** sha256 hex of a NORMALISED code — what CustomerAccountCard.tokenHash stores. */
export function hashCardCode(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/** The last four characters, printed beside the client's name ("card …7K2Q"). */
export function cardHintOf(normalized: string): string {
  return normalized.slice(-4)
}
