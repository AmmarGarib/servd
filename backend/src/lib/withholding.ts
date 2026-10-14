// THE income-tax withholding resolver (finance wave B, H8 / H28): how much
// income tax servd withholds from a vendor's payment and pays to FBR on its
// behalf (Cr 2040). Supplier bills (supplierPosting.withholdingForBill),
// OpEx payments and CapEx payments all call computeWithholding — never a
// second rate table or a second rule.
//
// Rates are per company, per section × filer status, in basis points
// (OperationsConfig.withholdingRates, written ONLY by
// PUT /accounting/withholding/rates). The defaults below are placeholders the
// company's CA confirms:
//
//   section    what                       filer   non-filer
//   153_1_a    goods (s.153(1)(a))         5%      10%
//   153_1_b    services (s.153(1)(b))      9%      18%
//   153_1_c    contracts (s.153(1)(c))     7%      14%
//   155        rent (s.155)               15%      30%
//
// A company that has never saved rates keeps its old single
// withholdingTaxPct as the 153(1)(a) filer rate (that is what its bills have
// been withheld at). Everything sits behind the company's existing
// withholdingTaxEnabled switch: off → nothing is withheld.
//
// The rule (computeWithholding):
//   • no section (or 'none'), or the company's switch off → 0
//   • the supplier's exemption certificate valid on the day (whtExemptUntil ≥ at) → 0
//   • non-filer → the non-filer rate
//   • filer → the filer rate; unknown (or 'exempt' with no valid certificate)
//     → the filer rate AND needsAtlCheck (check the vendor on FBR's Active
//     Taxpayers List — a non-filer owes double)
//   whtCents = round(base × rate / 10000), within the money cap.

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './prisma.js'
import { assertMoneyFits } from './money.js'

export const WHT_SECTIONS = ['153_1_a', '153_1_b', '153_1_c', '155'] as const
export type WhtSection = (typeof WHT_SECTIONS)[number]

export const FILER_STATUSES = ['filer', 'non_filer', 'exempt', 'unknown'] as const
export type FilerStatus = (typeof FILER_STATUSES)[number]

/** How each section reads on screens, the register and its CSV. */
export const WHT_SECTION_LABEL: Readonly<Record<WhtSection, string>> = {
  '153_1_a': 's.153(1)(a) — goods',
  '153_1_b': 's.153(1)(b) — services',
  '153_1_c': 's.153(1)(c) — contracts',
  '155': 's.155 — rent',
}

/** A rate can be at most 50% (5000 bps). */
export const MAX_WHT_BPS = 5000

export interface WhtRate { filerBps: number; nonFilerBps: number }
export type WhtRates = Record<WhtSection, WhtRate>

/** The CA placeholders (bps), used for every section a company has not saved. */
export const DEFAULT_WHT_RATES: Readonly<WhtRates> = {
  '153_1_a': { filerBps: 500,  nonFilerBps: 1000 },
  '153_1_b': { filerBps: 900,  nonFilerBps: 1800 },
  '153_1_c': { filerBps: 700,  nonFilerBps: 1400 },
  '155':     { filerBps: 1500, nonFilerBps: 3000 },
}

export function isWhtSection(x: unknown): x is WhtSection {
  return typeof x === 'string' && (WHT_SECTIONS as readonly string[]).includes(x)
}

/** A stored section value → a section, or null ('none', null, anything unknown). */
export function whtSectionOrNull(x: string | null | undefined): WhtSection | null {
  return isWhtSection(x) ? x : null
}

type Db = Pick<typeof prisma, 'operationsConfig'> | Prisma.TransactionClient

const bps = z.number().int().min(0).max(MAX_WHT_BPS)
const storedRate = z.object({ filerBps: bps, nonFilerBps: bps })

/** The saved JSON, section by section; a malformed section is ignored (its default applies). */
function parseStoredRates(raw: unknown): Partial<WhtRates> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Partial<WhtRates> = {}
  for (const s of WHT_SECTIONS) {
    const r = storedRate.safeParse((raw as Record<string, unknown>)[s])
    if (r.success) out[s] = r.data
  }
  return Object.keys(out).length > 0 ? out : null
}

function copyDefaults(): WhtRates {
  return Object.fromEntries(WHT_SECTIONS.map((s) => [s, { ...DEFAULT_WHT_RATES[s] }])) as WhtRates
}

/**
 * The company's withholding switch and rates. `defaultsUsed` is true while the
 * company has never saved its own rates (the CA placeholders apply, with the
 * old withholdingTaxPct as the 153(1)(a) filer rate). Reads through `db`, so a
 * caller inside a transaction sees its own writes. Never creates a row.
 */
export async function withholdingRatesFor(db: Db, tenantId: string): Promise<{
  enabled: boolean
  rates: Record<WhtSection, WhtRate>
  defaultsUsed: boolean
}> {
  const ops = await db.operationsConfig.findFirst({
    where: { tenantId, scope: 'global', scopeId: null },
    select: { withholdingTaxEnabled: true, withholdingTaxPct: true, withholdingRates: true },
  })
  const rates = copyDefaults()
  const stored = parseStoredRates(ops?.withholdingRates)
  if (stored) {
    for (const s of WHT_SECTIONS) if (stored[s]) rates[s] = { ...stored[s]! }
  } else if (ops && ops.withholdingTaxPct > 0) {
    // The legacy single % (a 0–1 fraction) was the goods rate for filers.
    rates['153_1_a'].filerBps = Math.min(MAX_WHT_BPS, Math.round(ops.withholdingTaxPct * 10_000))
  }
  return { enabled: ops?.withholdingTaxEnabled ?? false, rates, defaultsUsed: !stored }
}

/** round(base × rate / 10000) without leaving the exact-integer range for any base within the money cap. */
function applyBps(baseCents: number, rateBps: number): number {
  const whole = Math.floor(baseCents / 10_000)
  const rest = baseCents - whole * 10_000
  return whole * rateBps + Math.round((rest * rateBps) / 10_000)
}

export interface WithholdingResult {
  whtCents: number
  rateBps: number
  section: WhtSection | null
  /** The status the rate was taken at: filer | non_filer | exempt | unknown. */
  filerStatus: string
  /** True when the supplier's exemption certificate covered the day. */
  exempt: boolean
  /** The vendor's filer status is not known — the filer rate was used; check FBR's Active Taxpayers List. */
  needsAtlCheck: boolean
}

/**
 * The withholding on one payment / bill. `filerStatus` (a snapshot) wins over
 * the supplier's current status; the exemption certificate is always the
 * SUPPLIER's (never per payment). `baseCents` is the amount the section taxes
 * (a bill's subtotal; an invoice less its sales tax).
 */
export async function computeWithholding(db: Db, a: {
  tenantId: string
  supplier: { filerStatus: string; whtExemptUntil: Date | null } | null
  filerStatus?: string
  section: WhtSection | null
  baseCents: number
  at: Date
}): Promise<WithholdingResult> {
  const section = whtSectionOrNull(a.section)
  const asked = a.filerStatus ?? a.supplier?.filerStatus ?? 'unknown'
  const status: FilerStatus = (FILER_STATUSES as readonly string[]).includes(asked) ? asked as FilerStatus : 'unknown'
  const nothing = (filerStatus: string, exempt = false): WithholdingResult =>
    ({ whtCents: 0, rateBps: 0, section, filerStatus, exempt, needsAtlCheck: false })

  if (!section) return nothing(status)
  const cfg = await withholdingRatesFor(db, a.tenantId)
  if (!cfg.enabled) return nothing(status)

  const until = a.supplier?.whtExemptUntil ?? null
  if (until && until.getTime() >= a.at.getTime()) return nothing('exempt', true)

  // 'exempt' without a certificate valid on the day is not proof of anything:
  // the filer rate, with the ATL check.
  const effective: FilerStatus = status === 'exempt' ? 'unknown' : status
  const rate = cfg.rates[section]
  const rateBps = effective === 'non_filer' ? rate.nonFilerBps : rate.filerBps
  const base = Math.max(0, Math.trunc(a.baseCents))
  assertMoneyFits(base, 'The amount withholding is worked out on')
  const whtCents = base > 0 ? applyBps(base, rateBps) : 0
  assertMoneyFits(whtCents, 'The withholding')
  return { whtCents, rateBps, section, filerStatus: effective, exempt: false, needsAtlCheck: effective === 'unknown' }
}

/**
 * The usual section of a CapEx payment, when neither its line nor the
 * supplier names one: a build-out contractor is a contract (153(1)(c)),
 * equipment is goods (153(1)(a)), a rent advance is rent (155), a broker /
 * legal fee is a service (153(1)(b)); a refundable deposit is not income of
 * the payee — nothing.
 */
export function defaultSectionForCapex(treatment: 'capital' | 'prepaid' | 'deposit' | 'expense', projectType: string): WhtSection | null {
  switch (treatment) {
    case 'capital':
      return ['kitchen_buildout', 'refurb', 'expansion', 'new_brand'].includes(projectType) ? '153_1_c' : '153_1_a'
    case 'prepaid':
      return '155'
    case 'expense':
      return '153_1_b'
    case 'deposit':
    default:
      return null
  }
}
