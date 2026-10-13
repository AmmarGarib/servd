// THE sales-tax authority table (finance wave B, H8 / H13): which authority
// a brand's output tax is owed to, and which account each authority's output
// (payable) and input (recoverable) tax sits on. Every other module reads it
// from here — the order / shift / refund postings (orderPosting.ts re-exports
// outputTaxCodeFor and OUTPUT_TAX_ACCOUNTS), the sales tax return
// (salesTaxReturn.ts re-exports AUTHORITIES), the tax payments register
// (taxPayments.ts), supplier bills and OpEx / CapEx input tax
// (inputTaxCodeFor) and customer-withheld sales tax (authorityOfOutputCode).
// Never keep a second province or authority map.
//
//   authority  output (payable)              input (recoverable)
//   fbr        2030 GST Output (FBR)         1320 GST Input (FBR)
//   pra        2031 PRA (Punjab)             1321 PRA input
//   srb        2032 SRB (Sindh)              1322 SRB input
//   kpra       2033 KPRA (Khyber Pakhtunkhwa) 1323 KPRA input
//   bra        2034 BRA (Balochistan)        1324 BRA input
//
// Restaurant services are taxed by the PROVINCE the kitchen is in, not by FBR
// (BOOKS-10): a Karachi brand's 15% cash / 8% card tax is Sindh sales tax on
// services, payable to SRB. Concept.province decides; a brand registered with
// SRB (srbPosId) but with no province set is a Sindh kitchen; Islamabad (ICT)
// services tax is collected by FBR, and a brand with no province stays on
// 2030 — the return flags it. Input tax is set off only against the SAME
// authority's output (H8).

import { AppError } from '../../lib/errors.js'
import { ACCT } from './journal.js'

export type AuthorityKey = 'fbr' | 'pra' | 'srb' | 'kpra' | 'bra'

/** Every authority, in the order the return lists them. A tuple, so `z.enum(TAX_AUTHORITY_KEYS)` works. */
export const TAX_AUTHORITY_KEYS = ['fbr', 'pra', 'srb', 'kpra', 'bra'] as const satisfies readonly AuthorityKey[]

export interface AuthorityInfo {
  key: AuthorityKey
  /** Short name: 'FBR', 'SRB', … */
  label: string
  /** Full name of the authority. */
  name: string
  /** Output (payable) account code. */
  outputCode: string
  /** Input (recoverable) account code. */
  inputCode: string
}

export const AUTHORITIES: Readonly<Record<AuthorityKey, AuthorityInfo>> = {
  fbr:  { key: 'fbr',  label: 'FBR',  name: 'Federal Board of Revenue',             outputCode: ACCT.GST_OUTPUT,      inputCode: ACCT.GST_INPUT },
  pra:  { key: 'pra',  label: 'PRA',  name: 'Punjab Revenue Authority',             outputCode: ACCT.PRA_TAX_OUTPUT,  inputCode: ACCT.PRA_TAX_INPUT },
  srb:  { key: 'srb',  label: 'SRB',  name: 'Sindh Revenue Board',                  outputCode: ACCT.SRB_TAX_OUTPUT,  inputCode: ACCT.SRB_TAX_INPUT },
  kpra: { key: 'kpra', label: 'KPRA', name: 'Khyber Pakhtunkhwa Revenue Authority', outputCode: ACCT.KPRA_TAX_OUTPUT, inputCode: ACCT.KPRA_TAX_INPUT },
  bra:  { key: 'bra',  label: 'BRA',  name: 'Balochistan Revenue Authority',        outputCode: ACCT.BRA_TAX_OUTPUT,  inputCode: ACCT.BRA_TAX_INPUT },
}

/** AUTHORITIES as a list, in TAX_AUTHORITY_KEYS order (for .map / .find over every authority). */
export const AUTHORITY_LIST: readonly AuthorityInfo[] = TAX_AUTHORITY_KEYS.map((k) => AUTHORITIES[k])

/** True when `x` is one of the five authority keys. */
export function isAuthorityKey(x: unknown): x is AuthorityKey {
  return typeof x === 'string' && (TAX_AUTHORITY_KEYS as readonly string[]).includes(x)
}

// ─── Province → authority (the brand's output-tax account) ──────────────────

/** Provinces whose own authority taxes restaurant services. Anything else (ICT, unknown) is FBR. */
export const AUTHORITY_BY_PROVINCE: Readonly<Record<string, AuthorityKey>> = {
  SD: 'srb',   // Sindh Revenue Board
  PB: 'pra',   // Punjab Revenue Authority
  KP: 'kpra',  // KP Revenue Authority
  BL: 'bra',   // Balochistan Revenue Authority
}

/** Province code → output-tax account (derived from the two tables above). */
export const OUTPUT_TAX_BY_PROVINCE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(AUTHORITY_BY_PROVINCE).map(([province, key]) => [province, AUTHORITIES[key].outputCode]),
)

/** Every output sales-tax account: FBR 2030 and the four provincial ones. */
export const OUTPUT_TAX_ACCOUNTS: readonly string[] = AUTHORITY_LIST.map((a) => a.outputCode)
/** Every input sales-tax account: FBR 1320 and the four provincial ones. */
export const INPUT_TAX_ACCOUNTS: readonly string[] = AUTHORITY_LIST.map((a) => a.inputCode)

/** What decides a brand's authority. Both optional, so `{ province }` alone and null work. */
export interface TaxJurisdiction { province?: string | null; srbPosId?: number | null }

/** The authority a brand's sales tax is owed to today. */
export function authorityForConcept(concept: TaxJurisdiction | null | undefined): AuthorityKey {
  const province = concept?.province?.trim().toUpperCase() || null
  if (province) return AUTHORITY_BY_PROVINCE[province] ?? 'fbr'
  if (concept?.srbPosId != null) return 'srb'
  return 'fbr'
}

/**
 * The output-tax account a brand's sales tax is credited to today (2030 FBR,
 * 2031 PRA, 2032 SRB, 2033 KPRA, 2034 BRA). A refund debits the account its
 * SALE credited while that account still holds the brand's tax
 * (orderPosting.ts refundTaxAccountFor) — this answer only when the sale's
 * account has been reclassed away.
 */
export function outputTaxCodeFor(concept: TaxJurisdiction | null | undefined): string {
  return AUTHORITIES[authorityForConcept(concept)].outputCode
}

/** The input (recoverable) account of an authority: fbr 1320, pra 1321, srb 1322, kpra 1323, bra 1324. */
export function inputTaxCodeFor(key: AuthorityKey): string {
  // A DB string reaches here typed as a key (SupplierBill.taxAuthority, …):
  // refuse an unknown one rather than post input tax to an undefined code.
  if (!isAuthorityKey(key)) throw new AppError('BAD_TAX_AUTHORITY', `Unknown sales tax authority "${String(key)}"`, 422)
  return AUTHORITIES[key].inputCode
}

/** The authority whose OUTPUT account `code` is, or null (not an output-tax account). */
export function authorityOfOutputCode(code: string): AuthorityKey | null {
  return AUTHORITY_LIST.find((a) => a.outputCode === code)?.key ?? null
}

/** The authority whose INPUT account `code` is, or null (not an input-tax account). */
export function authorityOfInputCode(code: string): AuthorityKey | null {
  return AUTHORITY_LIST.find((a) => a.inputCode === code)?.key ?? null
}
