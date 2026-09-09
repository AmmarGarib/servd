// Sales tax return — generates the inputs needed to file Pakistan FBR
// monthly STR (Annexure C summary). Operators still file via IRIS / FBR
// portal; this report just tells them what numbers to enter.
//
// Important caveats:
//   1. We DO NOT classify supplies into zero-rated / exempt / standard. Those
//      classifications are policy decisions the operator (or their CA) makes
//      per menu item / per service category. Until the operator marks items
//      explicitly, every taxable sale is reported as standard-rate.
//   2. Provincial sales tax (PRA / SRB / KPRA / BRA) on services is
//      computed only when the corresponding output account has activity.
//      Multi-province operators should run the report once per province.
//   3. The return needs to be signed and filed by a person — never auto-file.

import { prisma } from '../../lib/prisma.js'
import { ACCT } from './journal.js'
import { fmtPktDate } from './dates.js'

interface AccountTotal {
  code: string
  name: string
  totalCents: number   // natural balance in the account's normal direction
}

async function netCreditCents(tenantId: string, accountCode: string, from: Date, to: Date): Promise<number> {
  // The return is filed by ONE company, against its own chart of accounts.
  const account = await prisma.account.findFirst({ where: { tenantId, code: accountCode } })
  if (!account) return 0
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    _sum: { amountCents: true },
    where: {
      accountId: account.id,
      journalEntry: { tenantId, entryDate: { gte: from, lte: to } },
    },
  })
  let debit = 0, credit = 0
  for (const s of sums) {
    if (s.type === 'debit') debit  = s._sum.amountCents ?? 0
    else                     credit = s._sum.amountCents ?? 0
  }
  return credit - debit
}

async function netDebitCents(tenantId: string, accountCode: string, from: Date, to: Date): Promise<number> {
  return -(await netCreditCents(tenantId, accountCode, from, to))
}

export interface SalesTaxReturnReport {
  period: { from: string; to: string }
  outputTax: {
    fbr: AccountTotal
    pra: AccountTotal
    srb: AccountTotal
    kpra: AccountTotal
    bra: AccountTotal
    totalCents: number
  }
  inputTax: {
    fbr: AccountTotal
    pra: AccountTotal
    srb: AccountTotal
    kpra: AccountTotal
    bra: AccountTotal
    totalCents: number
  }
  taxableSalesCents: number    // sum of all per-concept revenue
  taxableValueByConceptCents: Array<{ conceptSlug: string; conceptName: string; revenueCents: number }>
  netPayableCents: number      // outputTax - inputTax (positive = owed; negative = refund)
  notes: string[]              // operator-facing caveats
}

const PROVINCIAL_OUTPUT_CODES = [
  ACCT.PRA_TAX_OUTPUT,
  ACCT.SRB_TAX_OUTPUT,
  ACCT.KPRA_TAX_OUTPUT,
  ACCT.BRA_TAX_OUTPUT,
]

const PROVINCIAL_INPUT_CODES = ['1321', '1322', '1323', '1324']

export async function salesTaxReturn(tenantId: string, from: Date, to: Date): Promise<SalesTaxReturnReport> {
  const accounts = await prisma.account.findMany({
    where: { tenantId, code: { in: [ACCT.GST_OUTPUT, ACCT.GST_INPUT, ...PROVINCIAL_OUTPUT_CODES, ...PROVINCIAL_INPUT_CODES] } },
    select: { code: true, name: true },
  })
  const named = (code: string) => accounts.find((a) => a.code === code)?.name ?? code

  const [fbrOut, fbrIn,
         praOut, srbOut, kpraOut, braOut,
         praIn,  srbIn,  kpraIn,  braIn] = await Promise.all([
    netCreditCents(tenantId, ACCT.GST_OUTPUT, from, to),
    netDebitCents(tenantId, ACCT.GST_INPUT,   from, to),
    netCreditCents(tenantId, ACCT.PRA_TAX_OUTPUT, from, to),
    netCreditCents(tenantId, ACCT.SRB_TAX_OUTPUT, from, to),
    netCreditCents(tenantId, ACCT.KPRA_TAX_OUTPUT, from, to),
    netCreditCents(tenantId, ACCT.BRA_TAX_OUTPUT, from, to),
    netDebitCents(tenantId, '1321', from, to),
    netDebitCents(tenantId, '1322', from, to),
    netDebitCents(tenantId, '1323', from, to),
    netDebitCents(tenantId, '1324', from, to),
  ])

  const totalOutput = fbrOut + praOut + srbOut + kpraOut + braOut
  const totalInput  = fbrIn  + praIn  + srbIn  + kpraIn  + braIn

  // Per-concept revenue for the period
  const concepts = await prisma.concept.findMany({
    where: { tenantId, isActive: true, deletedAt: null },
    select: { id: true, slug: true, name: true, province: true },
  })
  const taxableByConcept: Array<{ conceptSlug: string; conceptName: string; revenueCents: number }> = []
  let taxableSales = 0
  const revenueAccounts = await prisma.account.findMany({ where: { tenantId, type: 'revenue' }, select: { id: true, code: true } })
  for (const c of concepts) {
    // Find the matching 4xxx account by code-mapping in journal.ts (revenueCodeForConcept)
    const revAccount = revenueAccounts.find((a) => a.code === conceptRevenueCodeFromSlug(c.slug))
    if (!revAccount) continue
    const sums = await prisma.journalLine.groupBy({
      by: ['type'], _sum: { amountCents: true },
      where: { accountId: revAccount.id, journalEntry: { tenantId, entryDate: { gte: from, lte: to } } },
    })
    let debit = 0, credit = 0
    for (const s of sums) {
      if (s.type === 'debit') debit  = s._sum.amountCents ?? 0
      else                     credit = s._sum.amountCents ?? 0
    }
    const revenue = Math.max(0, credit - debit)
    if (revenue > 0) {
      taxableByConcept.push({ conceptSlug: c.slug, conceptName: c.name, revenueCents: revenue })
      taxableSales += revenue
    }
  }

  const notes: string[] = []
  if (concepts.some((c) => !c.province)) {
    notes.push('Some concepts have no `province` set — set Concept.province to enable per-jurisdiction filing.')
  }
  if (totalInput === 0) {
    notes.push('No input tax recorded. Verify supplier bills are tagging GST Input (1320) when applicable.')
  }
  notes.push('This report does NOT distinguish standard / zero-rated / exempt supplies. Adjust with your CA before filing.')
  notes.push('Provincial output accounts (2031–2034) only have activity if you explicitly post to them. Currently all sales tax lands in 2030 (federal) until policy is encoded.')

  return {
    period: { from: fmtPktDate(from), to: fmtPktDate(to) },
    outputTax: {
      fbr:  { code: ACCT.GST_OUTPUT, name: named(ACCT.GST_OUTPUT), totalCents: fbrOut },
      pra:  { code: ACCT.PRA_TAX_OUTPUT, name: named(ACCT.PRA_TAX_OUTPUT), totalCents: praOut },
      srb:  { code: ACCT.SRB_TAX_OUTPUT, name: named(ACCT.SRB_TAX_OUTPUT), totalCents: srbOut },
      kpra: { code: ACCT.KPRA_TAX_OUTPUT, name: named(ACCT.KPRA_TAX_OUTPUT), totalCents: kpraOut },
      bra:  { code: ACCT.BRA_TAX_OUTPUT, name: named(ACCT.BRA_TAX_OUTPUT), totalCents: braOut },
      totalCents: totalOutput,
    },
    inputTax: {
      fbr:  { code: ACCT.GST_INPUT, name: named(ACCT.GST_INPUT), totalCents: fbrIn },
      pra:  { code: '1321', name: named('1321'), totalCents: praIn },
      srb:  { code: '1322', name: named('1322'), totalCents: srbIn },
      kpra: { code: '1323', name: named('1323'), totalCents: kpraIn },
      bra:  { code: '1324', name: named('1324'), totalCents: braIn },
      totalCents: totalInput,
    },
    taxableSalesCents: taxableSales,
    taxableValueByConceptCents: taxableByConcept,
    netPayableCents: totalOutput - totalInput,
    notes,
  }
}

// Mirror of revenueCodeForConcept (kept private here to avoid circular import).
const SLUG_TO_REVENUE_CODE: Record<string, string> = {
  'simmer':          '4001',
  'stackd':          '4002',
  'stax':            '4002',  // pre-rename slug — keep so historical rows still map
  'strata':          '4003',
  'flipd':           '4004',
  'garnish-station': '4005',
  'stax-padel':      '4006',
  'bukhari':         '4007',
}
function conceptRevenueCodeFromSlug(slug: string): string {
  return SLUG_TO_REVENUE_CODE[slug] ?? '4090'
}
