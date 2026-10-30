// POS connector — the vendor-neutral driver contract (spec §3, frozen).
//
// servd talks to two kinds of external systems through drivers:
//   fiscal   — the filer of FBR / SRB invoices: an external fiscal POS
//              (http) or, since 2026-10-30 (owner), servd itself filing
//              directly with SRB (drivers/srb.ts — SRB only), and
//   terminal — the payment processor's card machine at the till.
//   raast    — Raast QR bank alerts (2026-10-12): bank-SMS matching now
//              (enabled = SMS matching ON), a bank / aggregator API later.
// A vendor is one file in connectors/drivers/ plus one line in registry.ts.
// Every driver call returns a classified Outcome and never throws on a vendor
// answer; 'unknown' means the vendor MAY have acted, so the caller looks the
// document/charge up before any resubmit.

export type ConnectorKindT = 'fiscal' | 'terminal' | 'raast'
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
  settings: FiscalSettings | TerminalSettings | RaastSettings
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
    deliveryChargeCents?: number   // legacy untaxed fee; 0 when the fee is a line (H9: a 'DELIVERY-CHARGE' line with its GST); optional, absent = 0
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
  // Till flow (2026-10-20, optional — contract v1 stays): a sale whose bill was
  // PUSHED to the Keenu POS (pushBill below) names that push, so the vendor
  // files the bill it settled instead of a new one. Absent on every other sale.
  settlement?: { channel: 'keenu'; pushId?: string; providerRef?: string }
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

// ── Keenu bill push (till flow, owner 2026-10-20) ─────────────────────────
// "Push to Keenu": the till sends an open bill to the fiscal POS (Keenu), which
// takes the money on its own device and settles it. servd then records the
// tender the POS reports and completes the order; the sale's FiscalDocument
// (outbox, completeOrder) carries `settlement` so the POS files THAT bill.
// A vendor implements pushBill (and getBillPush to look a push up); the real
// Keenu driver is one file in drivers/ + one line in registry.ts.
export interface BillPushRequest {
  pushId: string                   // servd's idempotency key for this push (stable across retries)
  orderId: string
  orderRef: string
  description: string              // "<brand> order <ref>"
  method: 'cash' | 'card'          // the tender the bill is priced for
  amountCents: number              // what the POS must take: the bill (priced for `method`) + tip
  tipCents: number
  currency: 'PKR'
  lines: Array<{ name: string; quantity: number; unitPriceCents: number }>
  taxCents: number
  registrations: FiscalRegistration[]
}
export type BillPushState =
  | { state: 'settled'; providerRef: string; approvalRef: string; method: 'cash' | 'card'; amountCents: number; tipCents?: number }
  | { state: 'pending'; providerRef?: string }
  | { state: 'declined'; reason: string }
  | { state: 'not_found' }

export interface FiscalDriver {
  readonly id: string
  readonly label: string
  readonly needs: { baseUrl: boolean; apiKey: boolean; webhookSecret: boolean }
  capabilities(ctx: ConnectorCtx): { refunds: boolean; zeroValue: boolean; lookup: boolean; billPush?: boolean }
  /** Push an open bill to the POS to settle (Keenu). Optional: a driver without it cannot take a push (409 KEENU_PUSH_UNSUPPORTED). */
  pushBill?(ctx: ConnectorCtx, r: BillPushRequest): Promise<Outcome<BillPushState>>
  /** Look a push up (after 'pending' / 'unknown'). */
  getBillPush?(ctx: ConnectorCtx, r: { pushId: string; providerRef?: string }): Promise<Outcome<BillPushState>>
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
  test?: { scenario: 'ok' | 'slow' | 'down' | 'reject' | 'auth' | 'processing_then_ok' | 'unknown_then_filed'; push?: 'settle' | 'decline' | 'pending' }
  /** SRB direct driver (owner, 2026-10-30): the SRB POS user; live = transType "Live" (default false = "Test"). The password is the connector's API key. */
  srb?: { posUser: string; live: boolean }
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

// ── raast (2026-10-12) ────────────────────────────────────────────────────
// Matching consumes a normalised BankCredit. The SMS parser
// (connectors/raast/sms.ts) is one producer; a later bank / aggregator API
// driver ('http', registered in RAAST_DRIVERS, webhook event 'raast.credit'
// on /webhooks/pos/:token with HMAC) is another — no rework of intents,
// receipts, matching, ledger or UI. v1 registers no driver.
export interface RaastSender {
  id: string
  senderId: string                 // normalised sender (connectors/raast/sms.ts normalizeSender)
  bankAccountId: string            // the company's receiving account this sender reports on
  accountLast4?: string            // when several accounts share one sender
  templateIds: string[]            // 1..10
  active: boolean
}
export interface RaastTemplate {
  id: string
  label: string
  kind: 'credit' | 'debit'
  // servd's template DSL, never a user regex: literal text, whitespace -> \s+,
  // placeholders {amount} {ref} {date} {time} {account} {payer} {*}.
  // Credit templates must contain {amount} and {ref}. <= 500 chars.
  template: string
  dateFormat?: string
  timeFormat?: string
  active: boolean
}
export interface RaastSettings {
  matchWindowMin: number           // 2..60, default 10
  intentTtlMin: number             // 5..120, default 30
  clockSkewMin: number             // 0..10, default 2
  smsConfirmMin: number            // 5..240, default 30
  unmatchedAlertEscalateMin: number // 15..1440, default 120
  statementMatchDays: number       // 1..10, default 3
  provisionalFlagDays: number      // 1..30, default 3
  refMinLength: number             // default 6
  refMaxLength: number             // default 35
  ignoreKeywords: string[]         // default ['OTP','one time','one-time','password','PIN','verification code']
  senders: RaastSender[]           // max 20
  templates: RaastTemplate[]       // max 50
}

/** One money-in event on a company's receiving account, from any producer. */
export interface BankCredit {
  tenantId: string
  bankAccountId: string | null     // known from the sender entry / the API account
  amountCents: number
  bankRef: string                  // normalised (connectors/raast/reference.ts)
  occurredAt: Date
  payer?: string
  accountLast4?: string
  receiptId?: string | null        // future dynamic QR: the bill reference = RaastReceipt.id
}

/** A future bank / aggregator API (dynamic QR with the amount + bill reference). */
export interface RaastDriver {
  readonly id: string
  readonly label: string
  readonly needs: { baseUrl: boolean; apiKey: boolean; webhookSecret: boolean }
  capabilities(ctx: ConnectorCtx): { dynamicQr: boolean; webhooks: boolean; lookup: boolean }
  createPaymentRequest?(ctx: ConnectorCtx, r: { receiptId: string; amountCents: number; billRef: string; expiresAt: Date }): Promise<Outcome<{ qrPayload: string; providerRef?: string }>>
  getPaymentStatus?(ctx: ConnectorCtx, r: { receiptId: string; providerRef?: string }): Promise<Outcome<{ state: 'pending' | 'paid' | 'expired' | 'not_found'; bankRef?: string; amountCents?: number; occurredAt?: string }>>
  health(ctx: ConnectorCtx): Promise<Outcome<{ latencyMs: number; detail?: string }>>
}
