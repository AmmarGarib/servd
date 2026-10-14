// The shapes of GET /finance/capex (the Project tracker) that the CapEx page
// and its capitalise / Quick buy / deposit forms share. They mirror
// backend/src/modules/financePlanning/routes.ts (withRollups + withLedger).

export type Phase = 'planning' | 'quoting' | 'executing' | 'snagging' | 'live'
export type Status =
  | 'not_quoted' | 'quoted' | 'ordered' | 'partial_paid'
  | 'delivered' | 'installed' | 'commissioned' | 'snag' | 'done'

export type Treatment = 'capital' | 'prepaid' | 'deposit' | 'expense'

export interface Quote {
  id: string
  vendor: string
  contactName: string | null
  contactPhone: string | null
  totalCents: number
  leadTimeDays: number | null
  validUntil: string | null
  fileUrl: string | null
  notes: string | null
  isWinner: boolean
}

export interface Payment {
  id: string
  label: 'deposit' | 'midpoint' | 'balance' | 'extra'
  amountCents: number
  dueDate: string | null
  paidAt: string | null
  paidAmountCents: number | null
  paymentRef: string | null
  // The company bank account it is paid from (the project's company's).
  bankAccountId: string | null
  // Wave B: income tax withheld, rent-advance term, deposit return, where it was paid from.
  whtCents: number
  whtSection: string | null
  whtRateBps: number | null
  filerStatus: string | null
  whtOverrideReason: string | null
  coversFrom: string | null
  coversMonths: number | null
  releasedCents: number
  depositReturnedCents: number
  depositForfeitedCents: number
  depositReturnedAt: string | null
  // How the landlord's returned deposit came back, and its payment reference # (2026-10-14).
  depositReturnMethod?: string | null
  depositReturnRef?: string | null
  source: 'finance' | 'cash' | string
}

export interface LedgerPayment {
  status: 'posted' | 'unposted'
  accountCode: string | null
  whtCents: number
  releasedCents: number
}

export interface LineLedger {
  advancedCents: number
  prepaidCents: number
  releasedCents: number
  depositHeldCents: number
  expensedCents: number
  settledPayableCents: number
  whtCents: number
  capitalisedCents: number
  disposedCents: number
  asset: { id: string; costCents: number; status: string } | null
  assets: Array<{ id: string; assetTag: string | null; costCents: number; status: string }>
  capitalisation: { assetIds: string[]; pendingEventId: string | null }
  payments: Record<string, LedgerPayment>
}

export interface Line {
  id: string
  scope: string
  category: string | null
  item: string
  quantity: number
  unitCostCents: number
  vendor: string | null
  vendorContact: string | null
  quotedCents: number | null
  negotiatedCents: number | null
  paidCents: number
  status: Status
  priority: 'must_have' | 'nice_to_have' | 'future'
  leadTimeDays: number | null
  expectedDeliveryDate: string | null
  actualDeliveryDate: string | null
  installedDate: string | null
  documentUrls: { label: string; url: string }[] | null
  photoUrls: string[] | null
  warrantyMonths: number | null
  notes: string | null
  supplierId: string | null
  treatment: Treatment | null
  inputTaxCents: number
  inputTaxAuthority: string | null
  whtSection: string | null
  quotes: Quote[]
  payments: Payment[]
  // The books' view (owner decision 24): posted instalments by kind, and the
  // fixed asset(s) the line was capitalised as.
  ledger?: LineLedger | null
  capitalisation?: { assetIds: string[]; pendingEventId: string | null }
}

export interface ScopeDef { key: string; label: string; emoji?: string | null; hint?: string | null }

export interface CapexSupplier {
  id: string
  name: string
  filerStatus: string
  whtExemptUntil: string | null
  whtExemptCertNo?: string | null
  defaultWhtSection: string | null
  defaultTaxAuthority: string | null
}

export interface AssetClassOption {
  key: string
  label: string
  pooled: boolean
  depreciable: boolean
  defaultLifeMonths: number | null
  costAccountCode: string
}

export interface Project {
  id: string
  tenantId: string | null
  name: string
  conceptId: string | null
  locationId: string | null
  projectType: string
  phase: Phase
  isStanding?: boolean
  budgetEnvelopeCents: number
  contingencyPct: number
  consultantFeesCents: number
  taxCents: number
  targetOpeningDate: string | null
  actualOpeningDate: string | null
  address: string | null
  floorAreaSqft: number | null
  notes: string | null
  scopeConfig: ScopeDef[] | null
  isJointVenture?: boolean
  jvPartners?: Array<{ label: string; pct: number }> | null
  lines: Line[]
  // Per company, from GET /finance/capex: the register's classes and what the forms pick from.
  assetClasses: AssetClassOption[]
  lookups: { suppliers: CapexSupplier[]; pools: Array<{ id: string; label: string; locationId: string; conceptId: string | null; classKey: string; typeKey: string }>; smallwareTypes: Array<{ key: string; label: string }> }
  rollups: {
    budgetedCents: number
    quotedCents: number
    committedCents: number
    paidCents: number
    remainingCents: number
    contingencyCents: number
    totalAskCents: number
    varianceVsEnvelopeCents: number
  }
  books?: {
    capitalisedCents: number
    disposedCents: number
    advancedCents: number
    notYetCapitalisedCents: number
    prepaidCents: number
    releasedCents: number
    depositHeldCents: number
    expensedCents: number
    whtCents: number
  }
}

/** GET /finance/capex/lookups: what Quick buy picks from, for the ACTIVE company. */
export interface CapexLookups {
  tenantId: string
  assetClasses: AssetClassOption[]
  lookups: Project['lookups']
  locations: Array<{ id: string; name: string }>
  brands: Array<{ id: string; name: string; slug: string }>
  bankAccounts: Array<{ id: string; name: string; bankName: string | null; accountCode: string | null }>
  treatments: Treatment[]
  whtSections: string[]
  taxAuthorities: string[]
}

export interface Orphan {
  paymentId: string
  tenantId: string
  entryId: string
  amountCents: number
  debitCode: string | null
  reason: 'payment_deleted' | 'project_deleted'
}
