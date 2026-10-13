// Amount in words, Pakistani numbering (thousand, lakh, crore) — for the
// "Amount in words" line of the printed cash voucher.
//
// By-eye checks (run with node --experimental-strip-types, 2026-10-13;
// input is paisa):
//   25_000_000        → Pakistani Rupees Two Lakh Fifty Thousand Only        (2,50,000)
//   100               → Pakistani Rupees One Only
//   0                 → Pakistani Rupees Zero Only
//   50                → Pakistani Rupees Zero and Fifty Paisa Only
//   150_050           → Pakistani Rupees One Thousand Five Hundred and Fifty Paisa Only
//   2_000_100         → Pakistani Rupees Twenty Thousand One Only
//   10_000_001        → Pakistani Rupees One Lakh and One Paisa Only
//   12_345_678_950    → Pakistani Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand
//                       Seven Hundred Eighty Nine and Fifty Paisa Only        (12,34,56,789.50)
//   1_000_000_000_000 → Pakistani Rupees One Thousand Crore Only             (10,00,00,00,000)

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

/** 0–99 in words ('' for 0). */
function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!
  const t = TENS[Math.floor(n / 10)]!
  const o = ONES[n % 10]!
  return o ? `${t} ${o}` : t
}

/** 0–999 in words ('' for 0). */
function belowThousand(n: number): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (h) parts.push(`${ONES[h]} Hundred`)
  if (rest) parts.push(belowHundred(rest))
  return parts.join(' ')
}

/**
 * A whole number in words with the South Asian grouping:
 * crore (1,00,00,000), lakh (1,00,000), thousand, hundred. Above 99 crore the
 * crore count is itself spelled the same way ("One Thousand Crore").
 * '' for 0.
 */
export function integerInWords(n: number): string {
  n = Math.floor(Math.abs(n))
  if (n === 0) return ''
  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1_000)
  const rest = n % 1_000
  const parts: string[] = []
  if (crore) parts.push(`${integerInWords(crore)} Crore`)
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`)
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`)
  if (rest) parts.push(belowThousand(rest))
  return parts.join(' ')
}

/**
 * Paisa (cents) → "Pakistani Rupees … Only", with "and N Paisa" when there
 * are paisa.
 */
export function amountInWords(cents: number): string {
  const total = Math.round(Math.abs(cents))
  const rupees = Math.floor(total / 100)
  const paisa = total % 100
  const r = integerInWords(rupees)
  const p = integerInWords(paisa)
  if (!r && !p) return 'Pakistani Rupees Zero Only'
  if (!r) return `Pakistani Rupees Zero and ${p} Paisa Only`
  return p ? `Pakistani Rupees ${r} and ${p} Paisa Only` : `Pakistani Rupees ${r} Only`
}

/** 2500000 paisa → "25,000.00" with Pakistani grouping (lakh / crore commas). */
export function formatPkr(cents: number, opts: { decimals?: boolean } = {}): string {
  const decimals = opts.decimals ?? (Math.round(cents) % 100 !== 0)
  return (cents / 100).toLocaleString('en-IN', {
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  })
}
