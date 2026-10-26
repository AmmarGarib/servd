// The countries the storefront's phone picker offers (owner, 2026-10-26: "Put
// an international number picker as well. And the preset should change
// accordingly. Make pakistan the default option tho").
//
// A small table, not a library: dial code, the example shown as the
// placeholder, and the national-number length range (digits after the dial
// code, trunk 0 dropped). The API stores E.164 digits; the picker sends
// "+<dial><national>" (lib/phone.ts toE164).

export interface PhoneCountry {
  iso: string
  name: string
  dial: string
  /** Placeholder: how a local number looks there. */
  example: string
  /** National number length (no trunk 0), inclusive. */
  min: number
  max: number
}

export const PHONE_COUNTRIES: PhoneCountry[] = [
  { iso: 'PK', name: 'Pakistan',             dial: '92',  example: '0300 1234567',    min: 10, max: 10 },
  { iso: 'AE', name: 'United Arab Emirates', dial: '971', example: '050 123 4567',    min: 9,  max: 9 },
  { iso: 'SA', name: 'Saudi Arabia',         dial: '966', example: '050 123 4567',    min: 9,  max: 9 },
  { iso: 'QA', name: 'Qatar',                dial: '974', example: '3312 3456',       min: 8,  max: 8 },
  { iso: 'OM', name: 'Oman',                 dial: '968', example: '9212 3456',       min: 8,  max: 8 },
  { iso: 'KW', name: 'Kuwait',               dial: '965', example: '500 12345',       min: 8,  max: 8 },
  { iso: 'BH', name: 'Bahrain',              dial: '973', example: '3600 1234',       min: 8,  max: 8 },
  { iso: 'GB', name: 'United Kingdom',       dial: '44',  example: '07400 123456',    min: 10, max: 10 },
  { iso: 'US', name: 'United States',        dial: '1',   example: '(201) 555-0123',  min: 10, max: 10 },
  { iso: 'CA', name: 'Canada',               dial: '1',   example: '(506) 234-5678',  min: 10, max: 10 },
  { iso: 'AU', name: 'Australia',            dial: '61',  example: '0412 345 678',    min: 9,  max: 9 },
  { iso: 'DE', name: 'Germany',              dial: '49',  example: '01512 3456789',   min: 10, max: 11 },
  { iso: 'FR', name: 'France',               dial: '33',  example: '06 12 34 56 78',  min: 9,  max: 9 },
  { iso: 'TR', name: 'Türkiye',              dial: '90',  example: '0501 234 56 78',  min: 10, max: 10 },
  { iso: 'MY', name: 'Malaysia',             dial: '60',  example: '012-345 6789',    min: 9,  max: 10 },
  { iso: 'SG', name: 'Singapore',            dial: '65',  example: '8123 4567',       min: 8,  max: 8 },
  { iso: 'CN', name: 'China',                dial: '86',  example: '131 2345 6789',   min: 11, max: 11 },
]

export const DEFAULT_PHONE_COUNTRY = PHONE_COUNTRIES[0]!

export function countryByIso(iso: string): PhoneCountry {
  return PHONE_COUNTRIES.find((c) => c.iso === iso) ?? DEFAULT_PHONE_COUNTRY
}

/** The national digits as typed, trunk 0 dropped (and a pasted +dial / 00dial prefix removed). */
export function nationalDigits(country: PhoneCountry, typed: string): string {
  let d = typed.replace(/\D/g, '')
  if (typed.trim().startsWith('+') && d.startsWith(country.dial)) d = d.slice(country.dial.length)
  else if (d.startsWith(`00${country.dial}`)) d = d.slice(2 + country.dial.length)
  if (d.startsWith('0')) d = d.replace(/^0+/, '')
  return d
}

/** "+<dial><national>" — what the API is sent. */
export function toE164(country: PhoneCountry, typed: string): string {
  return `+${country.dial}${nationalDigits(country, typed)}`
}

/** True when the typed number is a plausible number for that country (a PK one must be a mobile, 3xx). */
export function isValidPhone(country: PhoneCountry, typed: string): boolean {
  const n = nationalDigits(country, typed)
  if (n.length < country.min || n.length > country.max) return false
  if (country.iso === 'PK') return n.startsWith('3')
  return true
}

/** The country + national number of a stored E.164 value (digits, with or without +). Unknown → Pakistan, as typed. */
export function splitE164(stored: string): { country: PhoneCountry; national: string } {
  const d = stored.replace(/\D/g, '')
  // Longest dial code first (971 before 97x…, 1 last).
  const byLen = [...PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length)
  for (const c of byLen) if (d.startsWith(c.dial)) return { country: c.iso === 'CA' ? countryByIso('US') : c, national: d.slice(c.dial.length) }
  return { country: DEFAULT_PHONE_COUNTRY, national: stored }
}
