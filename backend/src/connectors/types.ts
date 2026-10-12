// POS connector — the vendor-neutral driver contract (spec §3, frozen).
//
// servd talks to two kinds of external systems through drivers:
//   fiscal   — the external fiscal POS that files FBR / SRB (the ONLY filer
//              since 2026-10-10; servd no longer files directly), and
//   terminal — the payment processor's card machine at the till.
// A vendor is one file in connectors/drivers/ plus one line in registry.ts.
// Every driver call returns a classified Outcome and never throws on a vendor
// answer; 'unknown' means the vendor MAY have acted, so the caller looks the
// document/charge up before any resubmit.

export type ConnectorKindT = 'fiscal' | 'terminal'
export type FiscalAuthority = 'fbr' | 'srb' | 'pra' | 'kpra' | 'bra'

export type Outcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'rejected'; code: string; message: string; httpStatus?: number }                          // permanent; no auto retry (except code 'AUTH', see §6)
  | { kind: 'transient'; code: string; message: string; retryAfterMs?: number; httpStatus?: number } // vendor never acted (refused/5xx/429/DNS)
  | { kind: 'unknown'; code: string; message: string }                                               // vendor MAY have acted (timeout after send, reset mid-response)

export interface ConnectorCtx {
  tenantId: string
  connectorId: string
  driver: string
  isTest: boolean
  baseUrl: string | null
  apiKey: string | null          // decrypted in memory for this call only
  webhookSecret: string | null
  settings: FiscalSettings | TerminalSettings
  signal: AbortSignal            // every call bounded by the caller's budget
  now: () => Date                // injectable (tests)
  log: (obj: Record<string, unknown>, msg: string) => void
}

// ── fiscal ────────────────────────────────────────────────────────────────
export interface FiscalParty { legalName?: string; ntn?: string; strn?: string; cnic?: string; address?: string; phone?: string; province?: string }
export interface FiscalRegistration { authority: FiscalAuthority; posId: string; storeId?: string }
export interface FiscalLine {
  lineId: string; itemCode: string; description: string; quantity: number
  unitPriceCents: number; grossCents: number; discountCents: number
  taxableCents: number; taxRatePct: number; taxCents: number
}
export interface FiscalPayload {
  version: 1
  documentId: string               // FiscalDocument.id — the vendor idempotency key
  kind: 'sale' | 'refund'
  orderId: string
  orderRef: string                 // human order ref (last 8)
  source: string                   // Order.source
  issuedAt: string                 // ISO with +05:00 (completion time for sales, refund time for refunds)
  currency: 'PKR'
  registrations: FiscalRegistration[]
  seller: FiscalParty & { legalName: string }
  buyer: FiscalParty | null
  lines: FiscalLine[]
  // Identity (contract v1, checked by fiscal/payload.ts totalsCheck before any
  // document is filed):
  //   Σ lines.taxableCents + taxCents + serviceChargeCents + tipCents
  //     + (deliveryChargeCents ?? 0) − (billDiscountCents ?? 0) === totalCents
  totals: {
    saleValueCents: number         // pre-discount sum of line gross
    discountCents: number          // Order.discountCents + Order.promoDiscountCents, capped at saleValueCents (the rest is billDiscountCents)
    taxableCents: number
    taxCents: number               // Order.taxCents (stored; never recomputed)
    taxRatePct: number             // Order.taxRatePct (15 cash / 8 card); fallback gstRatePct(concept, tender)
    serviceChargeCents: number
    tipCents: number
    deliveryChargeCents?: number   // delivery fee, untaxed (ONL-R2-02); optional, absent = 0
    billDiscountCents?: number     // discount above the food value, taken off after tax (F-RV-1); only when > 0, absent = 0
    totalCents: number             // the BILL: Order.totalCents + walletAmountCents + gift-card redemptions
                                   //   = lines + tax + service + tip + delivery − bill discount (not Order.totalCents alone)
  }
  payment: { mode: 'cash' | 'card' | 'mixed'; tenders: { method: string; amountCents: number }[] }
  servdInvoiceNumber?: string      // TaxInvoice number when one exists (owner flag a)
  original?: { documentId?: string; fiscalNumber: string; authority?: string; issuedAt?: string } // refunds
  refundAmountCents?: number
  reason?: string
  test?: boolean                   // dry run from the setup page — never stored
}
export interface FiscalResult {
  fiscalNumber: string; authority: FiscalAuthority; fiscalAt: string
  qrPayload?: string; verifyUrl?: string; providerRef?: string
  extraNumbers?: { authority: FiscalAuthority; number: string; qrPayload?: string; verifyUrl?: string }[]
}
export type FiscalSubmitValue =
  | { state: 'filed'; result: FiscalResult }
  | { state: 'processing'; providerRef?: string; retryAfterMs?: number }
export type FiscalLookupValue =
  | { state: 'filed'; result: FiscalResult }
  | { state: 'processing'; retryAfterMs?: number }
  | { state: 'not_found' }

export interface FiscalDriver {
  readonly id: string
  readonly label: string
  readonly needs: { baseUrl: boolean; apiKey: boolean; webhookSecret: boolean }
  capabilities(ctx: ConnectorCtx): { refunds: boolean; zeroValue: boolean; lookup: boolean }
  submitSale(ctx: ConnectorCtx, p: FiscalPayload): Promise<Outcome<FiscalSubmitValue>>     // idempotent on p.documentId
  submitRefund(ctx: ConnectorCtx, p: FiscalPayload): Promise<Outcome<FiscalSubmitValue>>   // credit note / sales return vs p.original
  getDocumentStatus(ctx: ConnectorCtx, ref: { documentId: string; providerRef?: string }): Promise<Outcome<FiscalLookupValue>>
  health(ctx: ConnectorCtx): Promise<Outcome<{ latencyMs: number; detail?: string }>>
}

// ── terminal ──────────────────────────────────────────────────────────────
export interface ChargeRequest {
  chargeId: string                 // TerminalCharge.id — merchant ref + idempotency key
  terminalId: string               // VENDOR device id (settings.terminals[].terminalId)
  amountCents: number
  currency: 'PKR'
  kind: 'charge' | 'refund'
  startedAt: Date                  // TerminalCharge.createdAt (lets stateless drivers compute progress)
  description: string              // "<brand> order <ref>"
  original?: { chargeId?: string; providerRef?: string; approvalRef?: string } // refunds
  callbackUrl: string              // https://<api>/api/v1/webhooks/pos/<webhookToken>
}
export type ChargeState =
  | { state: 'pending' }
  | { state: 'awaiting_card' }
  | { state: 'approved'; providerRef: string; approvalRef: string; authCode?: string; cardBrand?: string; last4?: string; amountCents: number }
  | { state: 'declined'; reason: string }
  | { state: 'cancelled' }
  | { state: 'expired' }
  | { state: 'not_found' }

export interface TerminalDriver {
  readonly id: string
  readonly label: string
  readonly needs: { baseUrl: boolean; apiKey: boolean; webhookSecret: boolean }
  capabilities(ctx: ConnectorCtx): { cancel: boolean; void: boolean; referencedRefund: boolean; webhooks: boolean }
  startCharge(ctx: ConnectorCtx, r: ChargeRequest): Promise<Outcome<{ providerRef?: string }>>               // idempotent on chargeId
  getChargeStatus(ctx: ConnectorCtx, r: ChargeRequest & { providerRef?: string }): Promise<Outcome<ChargeState>>
  cancelCharge(ctx: ConnectorCtx, r: ChargeRequest & { providerRef?: string }): Promise<Outcome<ChargeState>> // may answer 'approved' (too late)
  voidCharge(ctx: ConnectorCtx, r: ChargeRequest & { providerRef: string }): Promise<Outcome<{ voided: true }>>
  refund(ctx: ConnectorCtx, r: ChargeRequest): Promise<Outcome<{ providerRef?: string }>>                    // kind 'refund'; poll like a charge
  health(ctx: ConnectorCtx, terminalId?: string): Promise<Outcome<{ online: boolean; latencyMs: number }>>
  listTransactions?(ctx: ConnectorCtx, day: string): Promise<Outcome<{ chargeId?: string; providerRef: string; approvalRef: string; amountCents: number; kind: 'charge' | 'refund' | 'void' }[]>> // D17, not used tonight
}

// ── inbound webhooks (both kinds) ─────────────────────────────────────────
export type InboundEvent =
  | { id: string; type: 'fiscal.document.updated'; documentId: string; value: FiscalLookupValue | { state: 'rejected'; code: string; message: string } }
  | { id: string; type: 'terminal.charge.updated'; chargeId: string; state: ChargeState }

// settings (zod schemas in connectors/config.ts mirror these)
export interface FiscalSettings {
  syncTimeoutMs: number          // 500..5000, default 3000
  syncAtTill: boolean            // default true
  fileZeroValue: boolean         // default true (owner flag d)
  maxAgeHours: number            // 1..168, default 72
  outlets: { locationId: string; conceptId: string | null; authority: FiscalAuthority; posId: string; storeId?: string }[] // max 200
  apiKeyHeader?: string          // default 'Authorization' (sent as 'Bearer <key>'); any other header name gets the raw key
  paths?: Partial<Record<'sales' | 'refunds' | 'documents' | 'health', string>>
  test?: { scenario: 'ok' | 'slow' | 'down' | 'reject' | 'auth' | 'processing_then_ok' | 'unknown_then_filed' }
}
export interface TerminalSettings {
  chargeTimeoutSec: number       // 45..300, default 120
  pollMs: number                 // 1000..5000, default 1500
  allowManualRef: boolean        // default true; cannot be false while driver === 'none'
  terminals: { id: string; label: string; locationId: string; terminalId: string; active: boolean }[] // max 100
  apiKeyHeader?: string
  paths?: Partial<Record<'charges' | 'refunds' | 'health', string>>
  test?: { scenario: 'approve' | 'decline' | 'never' | 'unknown_start' | 'late_approve' | 'void_fails' | 'offline' | 'by_amount' }
}
