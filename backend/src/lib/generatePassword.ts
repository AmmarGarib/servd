import { randomInt } from 'crypto'

// Generated staff passwords.
//
// These get read aloud down a phone line, written on a scrap of paper, and
// typed on a tablet's on-screen keyboard by someone mid-shift. So the shape
// matters as much as the entropy:
//
//   - Words, not characters. "Harbour-Copper-4831" survives being spoken;
//     "x7Qm!2vB" does not, and gets written down wrong.
//   - No ambiguous glyphs anywhere. The digit block excludes 0 and 1 because
//     O/0 and l/1/I are the classic transcription errors.
//   - Hyphens, which every keyboard has, rather than symbols that move around
//     on mobile layouts.
//
// Entropy: two words from 32 (10 bits) plus a 4-digit block from 8^4 (12 bits)
// plus 6 hex characters (24 bits) — around 46 bits. That is not a passphrase
// to keep forever, and it is not meant to be: the account is flagged
// mustChangePassword and the holder is prompted to replace it. It is a
// hand-over credential that has to survive being spoken once.

const WORDS = [
  'Harbour', 'Lantern', 'Cobalt', 'Marble', 'Ember', 'Anchor', 'Copper', 'Saffron',
  'Quill', 'Aster', 'Basalt', 'Cinder', 'Willow', 'Pewter', 'Cedar', 'Garnet',
  'Meadow', 'Kettle', 'Amber', 'Thistle', 'Bramble', 'Cypress', 'Juniper', 'Slate',
  'Verdant', 'Orchid', 'Pepper', 'Cardamom', 'Clove', 'Nutmeg', 'Sorrel', 'Fennel',
]

// No 0 or 1 — they are the digits people mishear and mistype as O and l.
const DIGITS = '23456789'
// No 0/1/l/o for the same reason.
const HEXISH = 'abcdef23456789'

function pick(pool: string[] | string): string {
  return pool[randomInt(pool.length)] as string
}

/** A password safe to read aloud. Minimum 12 characters by construction. */
export function generateStaffPassword(): string {
  const a = pick(WORDS)
  const b = pick(WORDS)
  const digits = Array.from({ length: 4 }, () => pick(DIGITS)).join('')
  const tail = Array.from({ length: 6 }, () => pick(HEXISH)).join('')
  return `${a}-${b}-${digits}-${tail}`
}
