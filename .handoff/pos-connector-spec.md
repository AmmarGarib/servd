# POS connector + API section — final build spec (2026-10-10)

Owner request (verbatim intent): the admin "API" section holds exactly two things — Hasham's WhatsApp connector and a POS connector. servd is the in-house order-taking software; it talks through the POS connector to (a) an external fiscal POS that does FBR + SRB compliance and (b) the payment processor's card machine. Vendors not chosen yet.

---

## 1. Decisions recap

**Base design: Design B (the simpler one).** It has three core tables, keeps POS ids on `Concept`, and keeps the WhatsApp API paths. From Design A it takes these reliability guarantees:

| # | Decision | Source |
|---|---|---|
| D1 | One vendor-neutral connector in `backend/src/connectors/`. There are two kinds: **fiscal** (external fiscal POS) and **terminal** (card machine). Each kind has its own `PosConnector` row per company, so the POS and the card processor can be different vendors. | B |
| D2 | Drivers: `none`, `test` (built in, deterministic, no network) and `http` (generic "servd connector API v1"). A real vendor is one file in `connectors/drivers/` plus one line in `registry.ts`. | B |
| D3 | Every driver call returns a classified `Outcome` (`ok` / `rejected` / `transient` / `unknown`). It never throws on a vendor answer. `unknown` triggers a **lookup before any resubmit**. | A |
| D4 | **Transactional outbox.** The sale `FiscalDocument` is inserted inside completeOrder's existing `order.complete` claim transaction. The refund document is inserted inside refundOrder's transaction, together with the negative Payment. Nothing else enqueues fiscal work. | A |
| D5 | **Single flight through a DB lease** (`UPDATE … RETURNING`). Retries and backoff are driven by the DB (`nextAttemptAt`). BullMQ is only a fast path. A Redis-independent sweeper re-drives anything due, frees expired leases (their next attempt does a lookup first) and promotes waiting refunds. No advisory lock is needed, because the per-row lease is the guarantee. | A |
| D6 | **Never both filers.** The direct FBR/SRB adapters, workers, queues and the `/integrations/tax/status` route are deleted in the same release that switches completeOrder to the connector (§12). At boot, the legacy BullMQ queues are drained and obliterated once. Orders that already carry `fbrInvoiceNumber`/`srbInvoiceNumber` are auto-skipped. | A+B |
| D7 | **Gap until a vendor exists.** When the fiscal connector is off, sales create `held` documents. They are visible and counted in /health, and they are never auto-sent. When the CEO goes live (`liveSince`), new sales file. Held documents are released or skipped explicitly by the CEO, by date range. Late or back-dated filing is never silent. | A |
| D8 | Fiscal payload is built only from **stored** order figures: `Order.taxCents`, `Order.taxRatePct` (cash 15 / card 8 via tender re-pricing), `discountCents + promoDiscountCents`, `serviceChargeCents`, `tipCents`, `totalCents`. Never `concept.taxRate`. Line tax comes from `allocateTaxCents`, so it sums exactly. | A+B |
| D9 | Brand POS ids **stay** in `Concept.fbrPosId` / `Concept.srbPosId`, which remain the one store. The ledger still reads `srbPosId` for the 2032 routing, and the column is never nulled. Per-outlet overrides live in the fiscal connector's `settings.outlets`. The POS connector page is the only editor; the brand editor loses the inputs. | B |
| D10 | Till fiscal sync attempt is bounded: default 3 s, clamp 500–5000 ms (SRB used 8 s). After that it falls back to the outbox. A sale is never blocked, and the receipt prints "Fiscal invoice: pending". | A |
| D11 | Card machine: the server re-quotes before any push, using `expectedDueCents` (2-paisa tolerance). There is a persisted `TerminalCharge` with a client idempotency key and at most one active charge per order (partial unique index). The **server** records the Payment on approval through the existing `processPayment` / `settlePayment`, with idempotency key `term:<chargeId>`. Approved-but-refused leads to an automatic void and then `needs_attention` plus an alert. The `unknown` outcome has a cashier resolver and a 24 h reconciler. Other tenders, comp, gift card, check split and shift close are refused while a charge is active. The manual-reference path stays as the fallback. | A+B |
| D12 | `PaymentGateway` gains `card_terminal`. `keenuSettle` ignores those rows, so there is no double settlement if the processor is also Keenu. | B |
| D13 | Sidebar: Dev workspace gets section `{ key:'api', title:'API', modules:['api_whatsapp','api_pos'] }`. Pages are `/connectors/whatsapp` (the **existing** page moved with git mv, old path redirected) and `/connectors/pos` (new). Not `/api/*`, because admin next.config rewrites `/api/:path*` to the backend. | A+B |
| D14 | WhatsApp backend routes keep their paths (`/auth/integrations/whatsapp*`). Their roles change from ADMIN_ONLY to `CONNECTOR_ADMINS = ['admin','it']`. The key is encrypted at rest. Config stays one platform-wide gateway, as a deliberate, commented null-tenant row. | B |
| D15 | Secrets use `lib/secretBox.ts` (AES-256-GCM, env `SERVD_SECRET_KEY`, base64 32 bytes, format `enc:v1:<iv>:<tag>:<ct>`). Responses carry only a hint (first 4 + last 4). The one exception: a freshly **generated** webhook secret is returned once. | A+B |
| D16 | Alerts reuse `flagException` (`lib/exceptions.ts`) plus a best-effort WhatsApp notice. The console-only `COMPLIANCE` log goes away. | A |
| D17 | Deferred, and not built tonight: the nightly settlement match (it needs vendor `listTransactions`), terminal test charges from the setup page, and a credit-note slip print. The driver interface keeps optional hooks for them. | — |

**Owner flags (standing duplicate rule).** The build ships with these defaults; see §16.
- (a) servd `TaxInvoice` vs the fiscal number. Default: keep TaxInvoice. When filed, the receipt headline "Invoice #" is the fiscal number and the TaxInvoice number prints as "Ref".
- (b) `TerminalDriver` is kept separate from the unwired online `PaymentAdapter`.
- (c) WhatsApp stays one global gateway.
- (d) Zero-value comps and staff meals are filed (`fileZeroValue` defaults to true, which is today's behaviour).
- (e) A refund of a sale filed directly before cutover becomes `manual_required`.
- (f) **Shipping removal before a vendor exists means NOTHING is filed until go-live.**

---

## 2. Data model (exact Prisma)

All edits are in `backend/prisma/schema.prisma` and are owned by W0.

```prisma
// EXISTING enum — add one value (own migration, see §13)
enum PaymentGateway {
  keenu
  jazzcash
  easypaisa
  none
  card_terminal // till card charged through the POS connector's card machine (TerminalCharge); keenuSettle never touches these
}

enum ConnectorKind {
  fiscal   // external fiscal POS that files FBR / SRB
  terminal // payment processor's card machine
}

enum FiscalDocKind {
  sale
  refund
}

enum FiscalDocStatus {
  held            // connector off / not live / brand+outlet not registered — visible backlog, never auto-sent
  waiting         // refund waiting for its sale document to be filed
  pending         // due at nextAttemptAt
  submitting      // leased by one sender (leaseUntil)
  filed           // fiscal number back
  rejected        // permanent vendor validation error — needs a fix + manual retry
  failed          // retries exhausted (age > maxAgeHours or attempts >= 60) — manual retry only
  skipped         // AUTOMATIC ONLY — statusReason: prefiled_direct | zero_value | zero_value_unsupported | no_sale_document (never an operator choice; see §17.0)
  manual_required // e.g. refund of a sale filed directly with SRB/FBR before cutover
  manual_filed    // operator recorded an out-of-band fiscal number
}

enum TerminalChargeKind {
  charge
  refund
}

enum TerminalChargeStatus {
  pending          // row created, driver not yet accepted (or start was transient: TERMINAL_UNREACHABLE)
  sent             // driver accepted; waiting for the card
  approved         // vendor approved; Payment not yet recorded
  recorded         // Payment (or refund Payment) written — success, final
  declined         // final, no money
  cancel_requested // cancel sent, outcome not yet known
  cancelled        // final, no money
  expired          // vendor confirmed nothing charged after timeout; final
  unknown          // outcome not known (network drop / timeout / cancel unreachable) — blocks the order
  unverified       // cashier said "not charged"; order released; reconciler still verifies 24h
  void_pending     // approved but servd refused the payment — auto-reversal in progress
  voided           // money given back (void or refund); final
  needs_attention  // reversal failed, or unknown > 24h — manager alert; human action
  manual_resolved  // cashier recorded it from the machine slip (approved_manual); reconciler verifies
}

/// One per company per kind (per-company singleton rule). Secrets stored only as secretBox ciphertext.
model PosConnector {
  id                String        @id @default(cuid())
  tenantId          String
  kind              ConnectorKind
  driver            String        @default("none") // 'none' | 'test' | 'http' | later '<vendor>'
  enabled           Boolean       @default(false)  // fiscal: live (set ONLY by go-live); terminal: shown at the till
  liveSince         DateTime?                       // fiscal: first go-live; earlier completions stay held
  baseUrl           String?                         // https only (SSRF-guarded); unused by 'test'
  apiKeyEnc         String?
  apiKeyHint        String?
  webhookSecretEnc  String?
  webhookSecretHint String?
  webhookToken      String        @unique           // random 32-byte hex; selects the company for inbound webhooks; rotatable
  settings          Json          @default("{}")    // zod-validated per kind (§8)
  lastTestAt        DateTime?
  lastTestOk        Boolean?
  lastTestDetail    String?
  lastOkAt          DateTime?
  lastError         String?
  lastErrorAt       DateTime?
  updatedById       String?
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  tenant  Tenant           @relation("TenantPosConnectors", fields: [tenantId], references: [id])
  charges TerminalCharge[]

  @@unique([tenantId, kind])
  @@index([tenantId])
  @@map("pos_connectors")
}

/// The fiscal outbox: one row per sale, one per refund/void. id doubles as the vendor idempotency key.
model FiscalDocument {
  id              String          @id @default(cuid())
  tenantId        String
  kind            FiscalDocKind
  orderId         String
  conceptId       String
  locationId      String?
  idempotencyKey  String          // 'sale:<orderId>' | 'refund:<refundPaymentId>' | 'void:<orderId>'
  saleDocumentId  String?         // refund -> its sale document
  refundPaymentId String?         // refund -> the negative Payment row
  status          FiscalDocStatus @default(pending)
  statusReason    String?         // no_connector | not_registered | prefiled_direct | prefiled_direct_refund | zero_value | zero_value_unsupported | legacy_unfiled | operator | <vendor code>
  driver          String?         // driver at the last attempt ('manual' for manual_filed)
  payload         Json            // neutral FiscalPayload; FROZEN from the first submit attempt
  payloadHash     String          // sha256(JSON) of payload
  amountCents     Int             // sale total, or refund amount (positive)
  attempts        Int             @default(0)
  nextAttemptAt   DateTime        @default(now())
  leaseUntil      DateTime?
  leaseOwner      String?         // hostname:pid:rand
  lastErrorCode   String?         // e.g. UNKNOWN_TIMEOUT, UNKNOWN_LEASE_EXPIRED, PROCESSING, AUTH, <vendor code>
  lastError       String?
  fiscalNumber    String?
  authority       String?         // 'fbr' | 'srb' | 'pra' | 'kpra' | 'bra'
  qrPayload       String?         // exact string to encode as QR
  verifyUrl       String?
  extraNumbers    Json?           // [{authority, number, qrPayload?, verifyUrl?}] when the POS files with >1 authority
  providerRef     String?
  fiscalAt        DateTime?
  filedAt         DateTime?
  isTest          Boolean         @default(false) // filed by the 'test' driver — never a real fiscal invoice
  alertedAt       DateTime?
  resolvedById    String?
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  tenant      Tenant          @relation("TenantFiscalDocuments", fields: [tenantId], references: [id])
  order       Order           @relation(fields: [orderId], references: [id])
  attemptsLog FiscalAttempt[]

  @@unique([tenantId, idempotencyKey])
  @@index([tenantId, status, nextAttemptAt])
  @@index([status, nextAttemptAt])
  @@index([status, leaseUntil])
  @@index([orderId])
  @@index([saleDocumentId])
  @@index([tenantId, createdAt(sort: Desc)])
  @@index([tenantId, fiscalNumber])
  @@map("fiscal_documents")
}

/// Append-only attempt log ("recent submissions" + per-document drawer).
model FiscalAttempt {
  id         String   @id @default(cuid())
  tenantId   String
  documentId String
  attemptNo  Int
  op         String   // 'submit' | 'lookup'
  outcome    String   // 'filed' | 'processing' | 'rejected' | 'transient' | 'unknown' | 'not_found'
  httpStatus Int?
  errorCode  String?
  message    String?  // truncated 500, secrets/PII stripped
  durationMs Int
  via        String   // 'sync_till' | 'worker' | 'sweeper' | 'manual_retry' | 'webhook'
  createdAt  DateTime @default(now())

  document FiscalDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@index([tenantId, createdAt(sort: Desc)])
  @@index([documentId])
  @@map("fiscal_attempts")
}

/// One per push to the card machine (charge or refund).
model TerminalCharge {
  id               String               @id @default(cuid()) // sent to the vendor as our charge id / merchant ref
  tenantId         String
  kind             TerminalChargeKind   @default(charge)
  connectorId      String
  terminalId       String               // PosConnector(terminal).settings.terminals[].id
  orderId          String
  shiftId          String?
  targetPaymentId  String?              // charge: pending split Payment being settled; refund: the Payment being refunded
  paymentId        String?              @unique // Payment written on approval (charge) / negative Payment (refund)
  originalChargeId String?              // refund -> the charge it refunds
  amountCents      Int                  // what the machine is asked to take/return (due + tip)
  tipCents         Int                  @default(0)
  quoteDueCents    Int                  // server card quote (8% re-priced) at creation
  idempotencyKey   String               // client key per tap; 'refund:<key>' for refunds
  status           TerminalChargeStatus @default(pending)
  providerRef      String?
  approvalRef      String?              // becomes Payment.gatewayRef
  authCode         String?
  cardBrand        String?
  cardLast4        String?              // masked only; never a PAN
  message          String?
  refusalCode      String?              // processPayment error that forced the reversal
  manualReason     String?              // terminal_offline | unknown_outcome | cashier_not_charged
  vendorMeta       Json?                // last raw status, PII-stripped
  reverseAttempts  Int                  @default(0)
  nextActionAt     DateTime?            // reconciler due time
  expiresAt        DateTime
  lastPolledAt     DateTime?
  pollLeaseUntil   DateTime?
  resolvedAt       DateTime?
  alertedAt        DateTime?
  createdById      String
  createdAt        DateTime             @default(now())
  updatedAt        DateTime             @updatedAt

  tenant    Tenant       @relation("TenantTerminalCharges", fields: [tenantId], references: [id])
  connector PosConnector @relation(fields: [connectorId], references: [id])
  order     Order        @relation(fields: [orderId], references: [id])

  @@unique([tenantId, idempotencyKey])
  @@index([tenantId, status, updatedAt])
  @@index([status, nextActionAt])
  @@index([orderId])
  @@index([shiftId, status])
  @@index([connectorId, providerRef])
  @@map("terminal_charges")
}
```

Back-relations to add:
- `Order`: `fiscalDocuments FiscalDocument[]` and `terminalCharges TerminalCharge[]`.
- `Tenant`: `posConnectors PosConnector[] @relation("TenantPosConnectors")`, `fiscalDocuments FiscalDocument[] @relation("TenantFiscalDocuments")` and `terminalCharges TerminalCharge[] @relation("TenantTerminalCharges")`.

Kept untouched:
- `Order.fbrInvoiceNumber`, `srbInvoiceNumber` and `srbQrCodeLink`. They become read-only history: nothing writes them after cutover, and they drive the `prefiled_direct` skip and the receipt fallback. Add comments saying so.
- `Concept.fbrPosId` and `srbPosId`, with this comment: "brand POS ids; edited on the POS connector page; srbPosId ALSO routes Sindh output tax to 2032 — never null it".
- `ReceiptConfig.showFbrInvoice`, relabelled in the UI.
- `TaxInvoice` and `InvoiceCounter`.
- `Setting`: the WhatsApp rows stay global. The key value becomes `enc:v1:…`.

`Payment.gatewayMeta` gains keys `{ terminalChargeId, authCode, cardBrand, cardLast4, manualReason? }` for terminal rows. There is no new column.

---

## 3. Driver interface (exact TS)

`backend/src/connectors/types.ts`. W0 writes it verbatim and it is frozen after that; W1 owns any change.

```ts
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
  totals: {
    saleValueCents: number         // pre-discount sum of line gross
    discountCents: number          // Order.discountCents + Order.promoDiscountCents
    taxableCents: number
    taxCents: number               // Order.taxCents (stored; never recomputed)
    taxRatePct: number             // Order.taxRatePct (15 cash / 8 card); fallback gstRatePct(concept, tender)
    serviceChargeCents: number
    tipCents: number
    totalCents: number             // Order.totalCents
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
```

`backend/src/connectors/registry.ts` holds `FISCAL_DRIVERS = { test, http }` and `TERMINAL_DRIVERS = { test, http }`. Its functions:
- `getConnector(tenantId, kind)` loads the row, decrypts it, caches it per tenant+kind for 30 s, and creates it lazily as `driver:'none'`, `enabled:false`, with a random `webhookToken`.
- `invalidateConnector(tenantId, kind)` drops the cache entry.
- `buildCtx(row, budgetMs)` builds a `ConnectorCtx`.
- `listDrivers()` returns the driver list.

---

## 4. Test driver behaviour

File: `backend/src/connectors/drivers/test.ts`. It makes no network calls, needs no baseUrl or key, and holds **no result state**. Every answer is a pure function of the inputs and `ctx.now()`, so it is deterministic and safe across processes. A per-process call counter (`testDriverCalls`) is exported for tests only.

**Fiscal**
- `fiscalNumber` is `TEST-<AUTH>-` followed by `sha256(tenantId+':'+documentId).slice(0,10).toUpperCase()`. Refunds use `TEST-<AUTH>-CN-…`.
  - `AUTH` is `registrations[0]?.authority ?? 'srb'`, upper-cased.
  - `qrPayload` and `verifyUrl` are `https://fiscal.test.servd.pk/verify/<number>`.
  - `fiscalAt` is `payload.issuedAt`.
- Behaviour per `settings.test.scenario` (default `ok`):
  - `ok`: submit returns filed. Lookup returns filed, because the vendor is idempotent.
  - `slow`: submit waits 6000 ms while honouring `ctx.signal`. If aborted it returns `unknown` (UNKNOWN_TIMEOUT). If not aborted it returns filed. Lookup returns filed. This proves the till times out, the worker looks up the document, and the same number comes back.
  - `down`: submit and lookup return `transient` (`TEST_DOWN`). Health fails.
  - `reject`: submit returns `rejected` (`TEST_REJECT`).
  - `auth`: every call returns `rejected` with code `AUTH`.
  - `processing_then_ok`: submit returns `{state:'processing', providerRef:'P-'+documentId}`. Lookup returns filed.
  - `unknown_then_filed`: submit returns `unknown`. Lookup returns filed. A test asserts submit was called once.
- Capabilities: `{ refunds:true, zeroValue:true, lookup:true }`.

**Terminal** (`elapsed = ctx.now() - startedAt`)
- Approval values: `approvalRef = 'TST' + sha256(chargeId).slice(0,8).toUpperCase()`, `authCode` is 6 digits from the same hash, `cardBrand 'TESTCARD'`, `last4 '4242'`, `providerRef 'T-'+chargeId`.
- Behaviour per scenario (default `approve`). In `by_amount`, the last two digits of `amountCents` choose the scenario: 00–49 → approve, 51 → decline, 52 → never, 53 → unknown_start, 54 → late_approve, 55 → void_fails, 56 → offline.
  - `approve`: start returns ok. Status is `awaiting_card` until 1500 ms has elapsed, then `approved`. Cancel before 1500 ms returns `cancelled`; after that it returns `approved`.
  - `decline`: `declined('TEST_DECLINED')` once 1500 ms has elapsed.
  - `never`: always `awaiting_card`. Cancel returns `expired`.
  - `unknown_start`: start returns `unknown`. Status returns `approved` once 1500 ms has elapsed.
  - `late_approve`: like approve, but cancel always returns `approved`.
  - `void_fails`: approves like approve. `voidCharge` and `refund` return `transient`.
  - `offline`: start returns `transient('TERMINAL_UNREACHABLE')`. Health returns `{online:false}`.
- Refund (kind refund) starts ok and returns `approved` immediately on status.
- Capabilities: `{ cancel:true, void:true, referencedRefund:true, webhooks:true }`.
- `POST /connectors/terminal/test/simulate` exists only for the CEO or IT on a test-driver connector. It takes `{chargeId, outcome:'approved'|'declined'}` and runs the webhook path end to end.

**Receipts and labels.** A document filed by the test driver has `isTest=true`. Receipts print `TEST — NOT A FISCAL INVOICE`. The admin shows a TEST badge everywhere.

---

## 5. Generic HTTP driver contract ("servd connector API v1")

`connectors/drivers/http.ts` speaks this contract and `docs/pos-connector-api.md` publishes it (owned by W1). A vendor implements it natively or through a thin middleware.

**Transport**
- https only. No redirects are followed and responses are capped at 256 KB.
- SSRF guard: the host must not resolve to a private, loopback or link-local address (`dns.lookup` all records).
- Per-call budget: fiscal sync 3 s (the configured value) or 15 s in the worker; terminal start 8 s; poll, cancel and void 4 s; health 5 s.

**Outbound headers**
```
Authorization: Bearer <apiKey>            (or <apiKeyHeader>: <apiKey>)
Idempotency-Key: <documentId | chargeId>
X-Servd-Connector: <connectorId>          (opaque; not the tenant id)
X-Servd-Signature: t=<unix>,v1=<hex HMAC-SHA256(webhookSecret, t + "." + rawBody)>   (rawBody "" for GET)
Content-Type: application/json
```

**Fiscal**

| Call | Request | Success |
|---|---|---|
| `POST {base}/fiscal/sales` | FiscalPayload JSON (amounts in integer paisa) | `201` or `200` (duplicate) `{ "status":"filed", "fiscalNumber":"…", "authority":"srb", "qrPayload":"…", "verifyUrl":"…", "fiscalAt":"ISO", "providerRef":"…", "extraNumbers":[…] }`, or `202 { "status":"processing", "providerRef":"…", "retryAfterMs":30000 }` |
| `POST {base}/fiscal/refunds` | FiscalPayload with `kind:"refund"`, `original`, `refundAmountCents` | same |
| `GET {base}/fiscal/documents/{documentId}` | — | `200` filed body / `202` processing / `404` not found |
| `GET {base}/health` | — | `200 { "ok":true, "detail":"…" }` |

**Terminal**

| Call | Request | Success body (`200`/`201`) |
|---|---|---|
| `POST {base}/terminal/charges` | `{ chargeId, terminalId, amountCents, currency:"PKR", kind:"charge", description, callbackUrl }` | `{ "status":"pending", "providerRef":"…" }` |
| `GET {base}/terminal/charges/{chargeId}` | — | `{ "status":"pending"\|"awaiting_card"\|"approved"\|"declined"\|"cancelled"\|"expired", "providerRef", "approvalRef", "authCode", "cardBrand", "last4", "amountCents", "message" }` (`404` = not_found) |
| `POST {base}/terminal/charges/{chargeId}/cancel` | `{}` | same shape as GET |
| `POST {base}/terminal/charges/{chargeId}/void` | `{ providerRef }` | `{ "voided": true }` |
| `POST {base}/terminal/refunds` | `{ chargeId (the refund's id), terminalId, amountCents, currency, kind:"refund", original:{chargeId, providerRef, approvalRef} }` | `{ "status":"pending", "providerRef" }` |
| `GET {base}/terminal/health?terminalId=` | — | `{ "online":true }` |

**Classification**
- `2xx` → ok.
- `409` with code `duplicate` and the document body → ok. This is an idempotent replay.
- `400`/`409`/`422` `{code,message}` → rejected.
- `401`/`403` → rejected with code `AUTH`.
- `404` on GET → not_found.
- `408`/`429`/`5xx`, `ECONNREFUSED`, DNS failure, or TLS failure before send → transient. `Retry-After` is honoured.
- Abort or timeout after the request was written, or `ECONNRESET` mid-response → **unknown**.

**Inbound webhooks:** `POST https://api.servd.pk/api/v1/webhooks/pos/{webhookToken}`
- The vendor signs with header `X-Servd-Signature: t=<unix>,v1=<hex HMAC-SHA256(webhookSecret, t + "." + rawBody)>`.
- servd compares with `timingSafeEqual` on equal-length buffers and requires `|now − t| ≤ 300 s`. Otherwise it answers `401`.
- If no secret is configured, servd answers `503` (fail closed).
- An unknown token gets `404` with no detail.
- Body:
```json
{ "id": "evt_123", "type": "terminal.charge.updated", "createdAt": "ISO",
  "data": { "chargeId": "…", "status": "approved", "providerRef": "…", "approvalRef": "…", "authCode": "…", "cardBrand": "VISA", "last4": "4242", "amountCents": 123400 } }
{ "id": "evt_124", "type": "fiscal.document.updated",
  "data": { "documentId": "…", "status": "filed" | "processing" | "rejected", "fiscalNumber": "…", "authority": "srb", "qrPayload": "…", "verifyUrl": "…", "fiscalAt": "ISO", "code": "…", "message": "…" } }
```
- Rows are looked up **with `tenantId = connector.tenantId`**. A foreign or unknown id is answered `200 {ignored:true}` and never applied across companies.
- Replay dedupe has two layers. The first is best effort: `redisFast SET NX poswh:<connectorId>:<eventId> EX 86400`. The second always holds: state transitions only move forward (§6, §7).
- The route answers 200 fast. Heavy work (`recordApprovedCharge`) runs in `setImmediate`, with the reconciler as backstop.
- Rate limit: 120/min per token.

---

## 6. Fiscal flow

Files: `connectors/fiscal/payload.ts`, `connectors/fiscal/outbox.ts`, `connectors/fiscal/view.ts` and `connectors/fiscal/qr.ts`, all owned by W1.

### 6.1 Payload builder

`buildFiscalSaleTx(tx, orderId)` and `buildFiscalRefundTx(tx, {...})` port the rules of the FBR and SRB adapters:
- Lines come from order items. `grossCents` is qty × unit price, including modifiers, exactly as the order stores it.
- `discountCents` is `Order.discountCents + promoDiscountCents`. It is allocated over line gross with `allocateTaxCents(weights, total)`, used as a generic largest-remainder allocator.
- `taxableCents` is gross minus the line's discount share.
- Line `taxCents` is `allocateTaxCents(lineTaxable, Order.taxCents)`, so the line taxes sum exactly to the order tax.
- `taxRatePct` is `Order.taxRatePct ?? gstRatePct(concept, tenderOfOrder)`. **Never `concept.taxRate`.**
- `payment.mode` is `cash` only when every **paid** tender is cash, `card` when every paid tender is card or keenu_qr, and `mixed` otherwise. A zero-value order has mode `cash` and no tenders.
- Seller fields come from Concept: `invoiceLegalName` (falling back to concept name), `ntn`, `strn`, `province` and `invoiceAddress`. Buyer comes from the Customer's `ntn`, `cnic` and name, only when present.
- `registrations` are resolved in this order. Each authority appears at most once, and when an override and a brand id give the same authority, the override wins.
  1. `settings.outlets` where both `locationId` and `conceptId` match.
  2. `settings.outlets` where `locationId` matches and `conceptId` is null.
  3. Brand ids: `Concept.srbPosId` gives `{srb}` and `Concept.fbrPosId` gives `{fbr}`.
- The order's outlet is `Order.locationId`.
- `servdInvoiceNumber` is the TaxInvoice number when one exists at build time.
- Refund payload:
  - `refundTax = round(sale.totals.taxCents × refundAmount / sale.totals.totalCents)`.
  - Lines are the sale lines' taxable values scaled by `allocateTaxCents(saleLineTaxable, refundAmount − refundTax)`.
  - Line tax is `allocateTaxCents(those, refundTax)`.
  - `original` is the sale document's `{documentId, fiscalNumber, authority, issuedAt}`.
  - When the sale was prefiled directly, `original.fiscalNumber` is the old SRB or FBR number.

### 6.2 Enqueue

`enqueueFiscalSaleTx(tx, { orderId, tenantId })` is called **inside** completeOrder's claim `prisma.$transaction`, right after the `order.complete` audit row is created. The tenant comes from the claim row. It is idempotent on `(tenantId, 'sale:'+orderId)`. The first matching rule sets the status:
1. A document with that key already exists → return it.
2. `order.fbrInvoiceNumber || order.srbInvoiceNumber` → `skipped / prefiled_direct`.
3. `totalCents === 0 && !settings.fileZeroValue` → `skipped / zero_value`.
4. There is no fiscal connector, the driver is `none`, or `!enabled` → `held / no_connector`.
5. The registrations list is empty → `held / not_registered`.
6. `totalCents === 0` and the driver lacks `zeroValue` → `skipped / zero_value_unsupported`.
7. Otherwise → `pending` with `nextAttemptAt = now`.

The payload is built in every case and its hash is stored. While a document is `held` and has never been attempted, **release** rebuilds its payload, because registrations may have been fixed. From the first attempt on, the payload is frozen and never rebuilt.

`enqueueFiscalRefundTx(tx, { orderId, tenantId, refundPaymentId | null, amountCents, reason? })` uses the key `refund:<refundPaymentId>`, or `void:<orderId>` when it comes from the status path. The status depends on the sale document:
- Sale `filed` or `manual_filed` → `pending`.
- Sale `held`, `pending`, `submitting`, `waiting`, `failed` or `rejected` → `waiting`, with `saleDocumentId` set.
- Sale `skipped` → `skipped` with the same reason.
- No sale document, but the order has `fbrInvoiceNumber` or `srbInvoiceNumber` → `manual_required / prefiled_direct_refund`, plus ExceptionFlag `fiscal_manual_refund` (medium).
- No sale document and no legacy number → `skipped / no_sale_document`, and a log line (automatic; not an operator skip).

### 6.3 After commit (the fast path)
- Till (`completeOrder` with `syncFiscal: true` and `settings.syncAtTill`): `submitFiscalNow(docId, { budgetMs: settings.syncTimeoutMs, via: 'sync_till' })`. It always resolves to a `FiscalView`, never throws, and catches everything.
- Other doors and refunds: `kickFiscal(docId)` adds a BullMQ job to `fiscal-connector` with jobId `fiscal-<docId>-<attempts>`. If Redis is down the error is swallowed and the sweeper covers it.

### 6.4 Send

`sendFiscalDocument(docId, via, budgetMs)` is the one function. The sync path, the worker, the sweeper and manual retry all call it.
1. **Lease.** Run `$queryRaw`:
   ```sql
   UPDATE fiscal_documents
      SET status='submitting', "leaseUntil"=now()+interval '60 seconds',
          "leaseOwner"=$me, attempts=attempts+1, "updatedAt"=now()
    WHERE id=$1 AND status='pending' AND "nextAttemptAt"<=now()
    RETURNING *
   ```
   Zero rows means the document is busy, final or not due. Return the current view.
2. Load the connector with `WHERE tenantId = doc.tenantId`. If it is now off or `none`, set the document back to `held / no_connector` and stop.
3. If `lastErrorCode` starts with `UNKNOWN`, or equals `PROCESSING`, or `providerRef` is set, and the driver has `lookup`: call `getDocumentStatus` first.
   - filed → apply the result.
   - processing → `pending`, with `nextAttemptAt = now + (retryAfterMs ?? 30 s)`.
   - not_found → continue to submit.
4. Call `submitSale` or `submitRefund` with the frozen payload.
5. Apply the outcome:
   - ok filed → `filed`. Store the number, QR, verifyUrl, authority, fiscalAt, providerRef, extraNumbers, `filedAt` and `isTest`. Clear the lease. Set `connector.lastOkAt`. Promote that sale's `waiting` refunds to `pending` and kick them. Emit socket `tenant:{tenantId}:orders` with event `fiscal.filed` and payload `{orderId, documentId}`.
   - ok processing → `pending`, with providerRef stored and `lastErrorCode='PROCESSING'`.
   - transient → `pending` with backoff.
   - unknown → `pending` with backoff and `lastErrorCode='UNKNOWN_<code>'`.
   - rejected `AUTH` → `pending` with backoff of at least 5 min. Set `connector.lastError`. Raise alert `fiscal_auth`, at most once per hour per company.
   - rejected (any other code) → `rejected`, plus ExceptionFlag `fiscal_rejected` (high) and an alert.
6. Write a `FiscalAttempt` row for every submit and every lookup.

**Backoff** (by attempt number): 5 s, 15 s, 1 m, 5 m, 15 m, 30 m, 1 h, then hourly, with ±20 % jitter. The vendor's `retryAfterMs` wins when it is longer. The document becomes `failed` when `now − createdAt > maxAgeHours` (default 72) or `attempts >= 60`. That raises ExceptionFlag `fiscal_failed` (high) and an alert.

**Lease expiry.** The sweeper turns `submitting` rows with `leaseUntil < now` into `pending` with `lastErrorCode='UNKNOWN_LEASE_EXPIRED'`, so the next attempt runs a lookup first. This keeps filing exactly-once even when a process dies mid-HTTP.

**Sync budget.** The driver call is bounded by `AbortSignal.timeout(budgetMs)` and also by `withTimeout` (moved to `connectors/util.ts`). On timeout the outcome is `unknown` and the worker resumes with a lookup first.

### 6.5 Statuses visible to people (`FiscalView.status`)

| Raw status | View status |
|---|---|
| `filed`, `manual_filed` | `filed` |
| `pending`, `submitting`, `held`, `waiting`, `manual_required` | `pending` |
| `failed`, `rejected` | `failed` (the customer receipt still prints pending) |
| `skipped` | `not_required` |
| anything with `isTest` or a test connector | `test` |

```ts
export interface FiscalView {
  documentId: string; kind: 'sale' | 'refund'
  status: 'filed' | 'pending' | 'failed' | 'not_required' | 'test'
  rawStatus: FiscalDocStatus; statusReason: string | null
  fiscalNumber: string | null; authority: string | null
  qrPayload: string | null; verifyUrl: string | null; fiscalAt: string | null
  isTest: boolean; attempts: number; lastError: string | null   // lastError only in staff responses
}
```

### 6.6 Go-live and the gap
- From the W4 deploy until the CEO goes live, every completion is `held` and **nothing is filed** (owner flag f).
- Go-live (`POST /connectors/fiscal/go-live`) sets `enabled=true` and, the first time, `liveSince=now`. Later completions file.
- Held documents are released (`held → pending`, payload rebuilt) by the CEO — ALL held documents of the company (optionally one brand at a time, when that brand's POS id is registered). There is no date-range selection and no skip: every held sale is filed (late) once released (§17.0). They are never auto-released.
- Switching off sets `enabled=false`. New sales become `held`. Pending documents found by the sender go back to `held`.

---

## 7. Card-terminal flow

Files: `connectors/terminal/service.ts` and `connectors/terminal/guard.ts` (W1). Only the admin web till is involved, because the tablet has no payment screen.

1. **Config.** `GET /pos/terminal/config?shiftId=` returns the terminals whose `locationId` equals `shift.locationId`; when the shift has no location, it returns all active terminals. When the connector is disabled, the driver is `none` or no terminal exists, the till is exactly today's manual flow. The chosen terminal is remembered per browser in `localStorage` (try/catch).
2. **Quote.** The cashier picks card. The existing `GET /pos/orders/:id/quote?method=card` returns the 8 % re-priced due. The cashier adds an optional tip. The button reads "Charge PKR {due+tip} on {terminal label}". A collapsed link, "Card machine not working? Enter the machine reference", keeps today's `gatewayRef` path when `allowManualRef` is set.
3. **Start.** The client creates an `idempotencyKey` (uuid) once per attempt and keeps it in `sessionStorage` under `charge:<orderId>:<due>:<tip>`. Then it calls `POST /pos/terminal/charges`. `startTerminalCharge` runs these steps:
   1. Find the order in scope with `scopeTenantWhere(req,'write')` through its concept. A foreign order gives 404. Then `assertShiftOf(tenantId, shiftId, true)`, which gives 422. The shift must belong to the actor or the actor must be in MANAGERS, else 403 `NOT_YOUR_SHIFT`. The terminal must be in this company's settings, active and at the shift's location, else 422 `TERMINAL_NOT_IN_COMPANY`.
   2. If a row exists for `(tenantId, idempotencyKey)`, return it (replay).
   3. In one transaction, with `lockOrderTx(tx, orderId)`:
      - The order must be open, else 409 `ORDER_NOT_OPEN`.
      - Call `quoteOrderForTender(orderId,'card')`. A due of 0 gives 409 `ALREADY_PAID`. When `paymentId` is given, the due is that pending Payment row's amount instead.
      - `|expectedDueCents − due| > 2` gives 409 `AMOUNT_MISMATCH`, and nothing is pushed.
      - Tip bounds are the same as processPayment.
      - Insert `TerminalCharge` with status `pending`, `amountCents = due + tip`, `quoteDueCents = due` and `expiresAt = now + chargeTimeoutSec`.
      - The partial unique index rejects a second active charge on the same order. That gives 409 `CHARGE_IN_PROGRESS {chargeId}`, and the modal resumes that charge.
   4. **After commit**, call `driver.startCharge` with an 8 s budget:
      - ok → `sent` with providerRef.
      - transient → the row stays `pending` with `message='TERMINAL_UNREACHABLE'`, then becomes `cancelled`. The vendor never received it. The modal offers Retry (new key) or Manual.
      - unknown → `unknown`.
      - rejected → `declined`.
4. **Wait.** The modal polls `GET /pos/terminal/charges/:id` every `pollMs`, slowing to 2 s after 30 s. It shows "Insert / tap card on {label}…", a countdown and Cancel.
   - Server refresh is single-flight. When the status is non-final and `lastPolledAt` is older than 1 s, the server takes `pollLeaseUntil` with a conditional updateMany and calls `getChargeStatus` (4 s budget).
   - Webhooks call the same `applyChargeState`.
5. **`applyChargeState(chargeId, state, via)`** is the one state machine. It runs in a transaction with `SELECT … FOR UPDATE` on the charge and only moves forward:
   - `approved`, from `pending`/`sent`/`cancel_requested`/`unknown`/`unverified`/`expired`: store providerRef, approvalRef, authCode, brand and last4, and set `approved`. If `state.amountCents ≠ amountCents`, set `refusalCode='TERMINAL_AMOUNT_MISMATCH'` and go to reversal. Otherwise, after commit, call `recordApprovedCharge`.
   - `declined` → `declined`. `cancelled` → `cancelled`. `expired` → `expired`.
   - `not_found` after start returned ok → `unknown`.
   - A late `approved` on a charge the cashier released (`unverified`) follows the approved branch. recordApprovedCharge then records the charge if the order still takes exactly that due, otherwise it reverses the charge and raises an alert.
6. **`recordApprovedCharge(chargeId)`** is idempotent:
   - Without `targetPaymentId`: `processPayment({ orderId, shiftId, idempotencyKey: 'term:'+chargeId, terminalChargeId: chargeId, payments:[{ method:'card', amountCents, tipCents, gateway:'card_terminal', gatewayRef: approvalRef, terminalChargeId: chargeId }] })`, run as the charge's `createdById` (W4 confirms the actor plumbing).
   - With `targetPaymentId`: `settlePayment({ paymentId: targetPaymentId, via:'till', shiftId, gatewayRef: approvalRef, gateway:'card_terminal', terminalChargeId: chargeId })`.
   - Success → `recorded`, with `paymentId` and `resolvedAt` set. The poll view now carries `{payment, fiscal}`, where fiscal is the till sync result from completeOrder.
   - Replays (webhook racing poll, reconciler) return the same Payment through processPayment's idempotency.
   - Refusal (`AMOUNT_MISMATCH`, `ALREADY_PAID`, `ORDER_NOT_OPEN`, `NOT_YOUR_SHIFT`, `SHIFT_NOT_OPEN`, …) → `void_pending` with `refusalCode` set, then `reverseCharge`.
7. **`reverseCharge(chargeId)`** uses `voidCharge` when the driver has `void` and the charge is from the same Asia/Karachi day; otherwise it uses `refund` (referenced).
   - ok → `voided`.
   - Failure → `reverseAttempts++` and `nextActionAt` backoff: 30 s, 2 m, 10 m, 30 m.
   - After 4 failures, or 1 h → `needs_attention`, plus ExceptionFlag `terminal_void_failed` (high, amountCents) and an immediate alert to the company's admin users and the outlet's foh_management.
   - The modal says either "Card was charged but the sale could not take it — reversed automatically" or "… reversal FAILED, manager alerted".
8. **Cancel.** `POST …/cancel` sets `cancel_requested` and calls `cancelCharge`, then applies the answer:
   - `approved` (too late) → recorded, not lost.
   - Unreachable → stays `cancel_requested`. The poll and the reconciler continue.
   - The modal does not allow another tender until the charge is final or explicitly resolved.
9. **Timeout.** Past `expiresAt`, the next poll or the reconciler calls `getChargeStatus`.
   - Still pending → `cancelCharge`.
   - Vendor confirms expired or cancelled → final.
   - Unreachable → `unknown`. The modal then shows "The card machine did not answer. Look at the machine:" with two choices:
     - (a) "It shows APPROVED — enter the slip reference" → `resolve {outcome:'approved_manual', gatewayRef}`. This records through processPayment with `gateway:'card_terminal'`, `gatewayMeta.manualReason='unknown_outcome'` and key `term:<chargeId>`. Status becomes `manual_resolved`.
     - (b) "Declined / nothing" → `resolve {outcome:'not_charged', note?}`. Status becomes `unverified` and the order is free for another tender.
   - The reconciler verifies both for 24 h. A vendor `approved` on an order paid by another tender leads to reverseCharge plus an alert. A vendor `declined` after `manual_resolved` leads to ExceptionFlag `terminal_unreconciled` (high), because money was recorded that was never taken.
10. **Active-charge guard.** `assertNoActiveTerminalChargeTx(tx, orderId, exceptChargeId?)` checks for active statuses `pending`, `sent`, `approved`, `cancel_requested` and `unknown`, and throws 409 `TERMINAL_CHARGE_ACTIVE {chargeId}`.
    - W4 calls it under the order lock in `processPayment`, `settlePayment('till')`, `compOrder`, `applyGiftCardTender` and `checkSplit`. processPayment and settlePayment skip it when `input.terminalChargeId` matches.
    - `assertShiftHasNoActiveCharges(shiftId)` throws 409 `SHIFT_HAS_ACTIVE_CHARGE {charges}` in the shift close handler.
11. **Refund to card.**
    - `POST /pos/terminal/refunds` applies to a Payment with `gateway='card_terminal'`, resolved in scope (404 otherwise). The amount must be ≤ the refundable amount.
    - It inserts a `TerminalCharge kind refund` with `originalChargeId = gatewayMeta.terminalChargeId` and `targetPaymentId`, then calls `driver.refund`. Polling and webhooks work as for a charge.
    - On approval it calls the existing `refundOrder({ …input, method:'card', gateway:'card_terminal', gatewayRef: approvalRef, terminalChargeId })`. The negative Payment, the ledger and the fiscal refund document all happen in the one existing place. The charge becomes `recorded` with `paymentId` = the refund Payment.
    - Declined or expired records nothing. Unknown waits for the reconciler. Legacy card rows (`gateway 'none'`) keep today's manual refund.
12. **Keenu separation.** `keenuSettle` / `applyKeenuCallback` only touch rows with `gateway 'keenu'`, or legacy `'none'` rows without `gatewayMeta.terminalChargeId`. They never touch `card_terminal` rows.
13. **Offline.**
    - Terminal or vendor API down: the poll shows "Card machine offline". The manual-reference path records `gateway:'none'` with `gatewayMeta.manualReason='terminal_offline'`, audited.
    - Browser reload: `GET /pos/terminal/charges?orderId=&active=1` resumes the charge. All state is server-side.
    - Redis down: terminal flows do not use Redis, apart from best-effort webhook dedupe.

---

## 8. API routes

All routes are under `/api/v1`. `CONNECTOR_ADMINS = ['admin','it']` is defined in a new `lib/connectorRoles.ts` (W0). Tenant scope always goes through `lib/tenantScope.ts`. Errors use the existing `{ error: { code, message } }` shape. A foreign row gives 404, a cross-company attach gives 422, and an empty scope denies.

**Module gate:** `GATED_PREFIXES += { prefix: '/connectors', anyOf: ['api_pos'] }`.

### 8.1 Connector config: plugin `modules/connectors/routes.ts`, prefix `/connectors` (W1)

| Method / path | Roles | Body (zod) | Response / errors |
|---|---|---|---|
| GET `/connectors/drivers` | CONNECTOR_ADMINS | — | `[{kind, id, label, needs}]` |
| GET `/connectors` | CONNECTOR_ADMINS + `management` | — | ACTIVE company: `{ fiscal: ConnectorView, terminal: ConnectorView, brandPosIds:[{conceptId,name,fbrPosId,srbPosId,province}], counts:{held,waiting,pending,submittingStale,failed,rejected,manualRequired,filedToday,oldestPendingAt}, terminalAttention:number }`. `ConnectorView = {id, kind, driver, enabled, isTest, liveSince, baseUrl, apiKeyHint, webhookSecretHint, webhookUrl, settings, lastTestAt, lastTestOk, lastTestDetail, lastOkAt, lastError, lastErrorAt}`. Rows are created lazily. It never contains a secret. |
| PUT `/connectors/:kind` | CONNECTOR_ADMINS | `{ driver?: string (registry key or 'none'), baseUrl?: string\|'' , apiKey?: string (omit = unchanged, '' = clear), webhookSecret?: string\|'', regenerateWebhookSecret?: boolean, enabled?: boolean /* terminal only; ignored for fiscal */, settings?: FiscalSettings\|TerminalSettings (partial merge, then full zod) }` | Upsert on `(activeTenantId, kind)`. 422 `NOT_IN_COMPANY` (a settings locationId or conceptId belongs to another company, checked against Location.tenantId and `assertConceptOwned(req,id,'write')`). 422 `URL_NOT_ALLOWED` (SSRF / not https). 503 `SECRET_KEY_MISSING` (a secret was supplied but `SERVD_SECRET_KEY` is unset). Audit `connectors.update` with kind, driver and changed **field names** only. Calls `invalidateConnector`. The response is the ConnectorView, plus `newWebhookSecret` once when regenerated. A terminal `id` in settings is generated server-side when missing. |
| POST `/connectors/:kind/rotate-webhook-token` | CONNECTOR_ADMINS | — | `{ webhookUrl }`, audited |
| POST `/connectors/:kind/test` | CONNECTOR_ADMINS | `{ dryRun?: boolean, terminalId?: string }` | Calls `health`. When `dryRun` is set on fiscal, it also submits a synthetic PKR 100 payload with `test:true` and `documentId 'test_'+cuid`, which is never stored. Stores lastTest*. Returns `{ ok, latencyMs, detail, dryRun?: {outcome, fiscalNumber?} }`. |
| POST `/connectors/fiscal/go-live` | `admin` only | `{ confirm: z.literal('GO LIVE') }` | Readiness: driver ≠ none; `lastTestOk` within 10 min; every concept of the company with orders in the last 30 days resolves at least one registration; legacy drain done. Failure gives 409 `NOT_READY {missing:[…]}`. Sets `enabled=true` and, the first time, `liveSince`. Audited `fiscal.go_live`. |
| POST `/connectors/fiscal/switch-off` | `admin` | `{ confirm: z.literal('SWITCH OFF') }` | `enabled=false`, audited |
| PUT `/connectors/fiscal/brand-pos-ids` | CONNECTOR_ADMINS | `{ items: z.array({ conceptId, fbrPosId: z.number().int().positive().nullable(), srbPosId: z.number().int().positive().nullable() }).max(100) }` | `assertConceptOwned(req, id, 'write')` per item (404 when foreign). Writes the **existing** Concept columns. Audit `concept.pos_ids.update`. |
| GET `/connectors/fiscal/documents` | CONNECTOR_ADMINS + management | query `status?, kind?, from?, to?, conceptId?, q? (order ref / fiscal no), cursor?, limit≤100` | `scopeTenantWhere(req,'read')`; conceptId through `conceptWhere`. Returns `{ items: FiscalDocRow[], nextCursor, counts }`. |
| GET `/connectors/fiscal/documents/:id` | same | — | Document + `attemptsLog` (last 50) + payload. 404 when foreign. |
| POST `/connectors/fiscal/documents/:id/retry` | CONNECTOR_ADMINS + management | — | `write` scope. Allowed from `failed`, `rejected`, or `pending` that is not leased → `pending` with `nextAttemptAt=now`, attempts kept, kicked. Otherwise 409 `NOT_RETRYABLE`. Audited `fiscal.retry`. |
| POST `/connectors/fiscal/documents/retry-failed` | CONNECTOR_ADMINS | — | ACTIVE company, max 500 → `{count}` |
| POST `/connectors/fiscal/documents/release` | `admin` | `{ from: datetime, to: datetime, conceptId?: string }` | ACTIVE company. Requires the connector to be live, else 409 `NOT_LIVE`. Moves `held` to `pending` (payload rebuilt; rows still unregistered stay held). Max 5000 → `{released, stillHeld}`. Audited. |
| POST `/connectors/fiscal/documents/:id/manual` | CONNECTOR_ADMINS | `{ fiscalNumber: z.string().min(1).max(64), authority: z.enum([...]), qrPayload?: z.string().max(1000), verifyUrl?: z.string().url().optional(), note?: z.string().max(500) }` | → `manual_filed`, driver `'manual'`. Promotes waiting refunds. Audited. |
| GET `/connectors/terminal/charges` | CONNECTOR_ADMINS + management | query `status?, from?, to?, cursor?` | Charges list (reconciliation) |
| POST `/connectors/terminal/test/simulate` | CONNECTOR_ADMINS | `{ chargeId, outcome: 'approved'\|'declined' }` | Test driver only, else 409 |

### 8.2 Till / order: plugin `modules/connectors/posRoutes.ts`, prefix `/pos` (W1)

These routes are not module-gated beyond the existing pos route roles. `CASHIERS` and `MANAGERS` come from `auth/middleware`.

| Method / path | Roles | Body | Response / errors |
|---|---|---|---|
| GET `/pos/terminal/config?shiftId=` | CASHIERS | — | `{ enabled, driver, isTest, allowManualRef, chargeTimeoutSec, pollMs, terminals:[{id,label}], online: boolean\|null }` (health cached 15 s) |
| POST `/pos/terminal/charges` | CASHIERS | `{ orderId: z.string().min(1), shiftId: z.string().min(1), terminalId: z.string().min(1).max(64), tipCents: z.number().int().min(0).default(0), expectedDueCents: z.number().int().min(0), idempotencyKey: z.string().min(8).max(100), paymentId: z.string().optional() }` | 201 (200 on replay) `TerminalChargeView`. 404 for a foreign order. 409 `AMOUNT_MISMATCH` (with `{dueCents}`), `CHARGE_IN_PROGRESS {chargeId}`, `ALREADY_PAID`, `ORDER_NOT_OPEN`. 422 `SHIFT_NOT_OPEN`, `TERMINAL_NOT_IN_COMPANY`. 403 `NOT_YOUR_SHIFT`. 503 `TERMINAL_NOT_CONFIGURED`. |
| GET `/pos/terminal/charges/:id` | CASHIERS | — | `TerminalChargeView` (refreshes from the driver when stale) |
| GET `/pos/terminal/charges?orderId=&active=1` | CASHIERS | — | `TerminalChargeView[]` |
| POST `/pos/terminal/charges/:id/cancel` | CASHIERS (own charge) or MANAGERS | — | view |
| POST `/pos/terminal/charges/:id/resolve` | CASHIERS (own) or MANAGERS | `z.discriminatedUnion('outcome',[{outcome:'approved_manual', gatewayRef: z.string().min(3).max(64)}, {outcome:'not_charged', note: z.string().max(300).optional()}])` | From `unknown`, `cancel_requested` past `expiresAt`, or `needs_attention` (managers only). Otherwise 409 `NOT_RESOLVABLE`. Audited `terminal.resolve`. |
| POST `/pos/terminal/charges/:id/reverse` | MANAGERS | `{ markRefundedOnMachine?: boolean, note?: string }` | From `needs_attention`: retries reverseCharge, or marks `voided` manually (audited) |
| POST `/pos/terminal/refunds` | MANAGERS | `{ paymentId, amountCents: int>0, terminalId, idempotencyKey: min 8, reason: z.string().min(3).max(300) }` | `TerminalChargeView` (kind refund). 404 for a foreign payment. 409 `NOT_A_TERMINAL_PAYMENT`, `AMOUNT_EXCEEDS_REFUNDABLE`. |
| GET `/pos/orders/:orderId/fiscal` | CASHIERS | — | `FiscalView[]` (sale + refunds; `lastError` only for MANAGERS) |
| POST `/pos/orders/:orderId/fiscal/retry` | MANAGERS | — | Retries the order's failed or rejected documents |

```ts
interface TerminalChargeView {
  id: string; kind: 'charge' | 'refund'; status: TerminalChargeStatus; final: boolean
  orderId: string; terminalId: string; terminalLabel: string
  amountCents: number; tipCents: number; quoteDueCents: number
  approvalRef: string | null; cardBrand: string | null; cardLast4: string | null
  message: string | null; refusalCode: string | null; expiresAt: string; createdAt: string
  payment: { id: string; method: string; amountCents: number } | null
  fiscal: FiscalView | null
}
```

### 8.3 Inbound webhook: plugin `modules/connectors/webhookRoutes.ts`, prefix `/webhooks/pos` (W1)

`POST /webhooks/pos/:token` registers its own encapsulated raw-body parser (`parseAs:'string'`). `webhooks/routes.ts` is not edited. Behaviour is as in §5.

### 8.4 Changed existing routes (W4)
- `POST /pos/payments`, `/pos/payments/:id/settle`, comp, the gift-card tender and check-split return `fiscal: FiscalView | null`. They keep the deprecated `srb` for one release, computed as `fiscal?.status==='filed' && fiscal.authority==='srb' ? { srbInvoiceId: fiscal.fiscalNumber, qrCodeLink: fiscal.verifyUrl ?? fiscal.qrPayload } : null`. New error: 409 `TERMINAL_CHARGE_ACTIVE`.
- `POST /pos/orders/:orderId/refund` returns `fiscalRefund: FiscalView | null` and keeps `srbReturnInvoiceNo` (always null now, deprecated). Audit metadata changes from `srbReturn`/`srbReturnInvoiceNo` to `fiscalRefund: {documentId, status}`.
- `GET /pos/orders/:orderId/receipt-data` and `GET /pos/receipt/:orderId`: see §11.
- The shift close handler (`POST /pos/shifts/:id/close` in pos/routes.ts): 409 `SHIFT_HAS_ACTIVE_CHARGE`.
- `GET /health` adds `fiscalConnector`, `cardTerminal` and `connectorSecretKey` from `connectors/health.ts`. Each is `ok`, `warn` or `off`, and never `fail`.
  - fiscal warn: a live company has held > 0, pending older than 15 min, any failed or rejected, manual_required > 0, AUTH lastError within the last hour, or a company left on `test` with `enabled`.
  - terminal warn: `needs_attention`, or `unknown` older than 10 min.
  - secretKey warn: encrypted values exist but the key is missing.
- **Removed:** `GET /integrations/tax/status`.

### 8.5 WhatsApp (W2)

`GET`/`PUT /auth/integrations/whatsapp`, `POST /auth/integrations/whatsapp/test` and the delivery-status routes keep their paths and change role to `CONNECTOR_ADMINS`. PUT stores the key through secretBox. GET still returns only `apiKeyHint`, plus `scope:'platform'`. No second API.

---

## 9. Workers

All start in `index.ts` under `ENABLE_WORKERS`, after `drainLegacyTaxQueues()`. Each loops per company where it touches rows. W1 writes them; W4 wires them.

1. **`workers/fiscalConnector.ts`** exports `startFiscalConnectorWorker()`.
   - BullMQ queue `fiscal-connector` via `getFiscalQueue()`, which W0 adds to `lib/queue.ts`. Concurrency 3. Jobs are `{documentId}` with `attempts:1`, `removeOnComplete:500` and `removeOnFail:1000`. Retries are DB-driven.
   - The handler is `sendFiscalDocument(id,'worker',15000)`.
   - Sweeper: `node-cron` `'*/30 * * * * *'`, with an in-process re-entrancy guard. No global lock is needed, because the leases are the guarantee.
     - (a) Expired `submitting` leases become `pending` with `UNKNOWN_LEASE_EXPIRED`.
     - (b) `waiting` refunds whose sale is `filed` or `manual_filed` become `pending`.
     - (c) Due `pending` rows: up to 200 per tenant per tick. Kick each through BullMQ, or call `sendFiscalDocument` inline and sequentially when the queue add throws (Redis down).
     - (d) Rows older than `maxAgeHours` become `failed` with an alert.
     - (e) Digest alert per company, at most once per 15 min (redisFast key; if Redis is down, use `alertedAt`): "N sales not filed for M min — fiscal POS unreachable; nothing lost, retrying."
2. **`workers/terminalConnector.ts`** exports `startTerminalConnectorWorker()`. It runs `node-cron` `'*/10 * * * * *'`, per company with an enabled terminal connector:
   - `sent`/`pending` rows older than 10 s, past `expiresAt`, `cancel_requested`, `unknown` and `unverified` rows younger than 24 h, and `manual_resolved` rows younger than 24 h (verify only) → `getChargeStatus` → `applyChargeState`.
   - `approved` with no `paymentId`, older than 5 s → `recordApprovedCharge`.
   - `void_pending` with `nextActionAt <= now` → `reverseCharge`.
   - `unknown` older than 24 h → `needs_attention` + ExceptionFlag `terminal_unreconciled`.
3. **Alerts** (`connectors/alerts.ts`):
   - `flagException({ tenantId, kind, severity, title, description, entityType:'FiscalDocument'|'TerminalCharge', entityId, amountCents })`, deduped per entity through `alertedAt`.
   - Best-effort `sendText` through `lib/whatsapp` to active users of that tenant with phones, with role `admin`/`it` for fiscal and `admin`/`foh_management` for terminal.
   - Messages name the cause and the fix. AUTH: "paste the current key in Dev → API → POS connector". not_registered: "add the POS id for <brand>/<outlet>".
   - W1 adds these kinds to `ExceptionKind` in `lib/exceptions.ts`: `fiscal_failed`, `fiscal_rejected`, `fiscal_auth`, `fiscal_manual_refund`, `terminal_void_failed`, `terminal_unreconciled`.
4. **`connectors/legacyDrain.ts` `drainLegacyTaxQueues()`** is one-off and removed one release later.
   - It is idempotent through the global Setting `fiscal.legacyDrainedAt`, a deliberate platform row (commented).
   - For each of `fbr-submission` and `srb-submission`: open the Queue, pause it, collect `orderId`s of waiting, delayed, active and failed jobs, then `obliterate({force:true})`.
   - Delete the Redis key `fbr:auth_token`.
   - For collected orders with no `fbrInvoiceNumber`/`srbInvoiceNumber` and no sale document, create a sale document forced to `held / legacy_unfiled`. These orders are visible, and the CEO decides.
   - Write an audit row `fiscal.legacy_drain` (category system) with counts and up to 500 orderIds.
   - Every step is in try/catch. A drain failure logs and never blocks boot.

Removed: `workers/fbrSubmission.ts`, `workers/srbSubmission.ts`, `getFbrQueue`, `getSrbQueue` and their job types.

---

## 10. Admin API section (pages, components, sidebar)

**Backend sidebar definition (W2)**
- `lib/moduleAccess.ts`:
  - `MODULE_IDS += 'api_whatsapp', 'api_pos'`.
  - `it` defaults become `['api_whatsapp','api_pos','integrations','audit_log','notifications','help']`.
  - admin and management get all modules, as today.
  - `foh_management` gets nothing new.
  - `GATED_PREFIXES += { prefix:'/connectors', anyOf:['api_pos'] }`.
- `lib/workspaces.ts`, Dev workspace: the first section is `{ key:'api', title:'API', modules:['api_whatsapp','api_pos'] }`. `systems` keeps `['integrations','notifications']`.

**Frontend (W3)**
- `lib/moduleCatalog.ts` `MODULE_PAGES`:
  - `api_whatsapp: [{ label:'WhatsApp connector', href:'/connectors/whatsapp', hint:"Hasham's gateway — OTPs, staff codes, order messages" }]`
  - `api_pos: [{ label:'POS connector', href:'/connectors/pos', hint:'Fiscal POS (FBR / SRB) and card machine' }]`
  - `integrations` loses the WhatsApp sub-link. Its hint becomes "Meta, email, webhooks, supplier portal".
  - `MODULE_GAPS.integrations` and `.orders` lose the FBR/SRB wording.
  - `lib/appRoles.ts` gets labels for both ids.
- Pages use tokens only, with no hard-coded colours and no emoji icons. Fetches go through the existing admin API client.
  1. `app/connectors/page.tsx`: two cards.
     - WhatsApp: configured/unset, source, delivery watchdog state.
     - POS: fiscal mode Off/Live/TEST, terminal enabled, health dot, backlog counts.
  2. `app/connectors/whatsapp/page.tsx`: **`git mv` of `app/configuration/whatsapp/page.tsx`**, with the same endpoints. Adds the note "Platform-wide: one gateway for every company" and the /health WhatsApp checks. `next.config.js` gets a permanent redirect from `/configuration/whatsapp` to `/connectors/whatsapp`.
  3. `app/connectors/pos/page.tsx` with tabs. Components live in `components/connectors/`. The API client is `lib/connectorsApi.ts`.
     - **Status** (`PosStatus.tsx`):
       - Mode badge: Off, "Live since …" or TEST.
       - Fiscal health: lastOkAt, lastError.
       - Backlog counters (held, waiting, pending with oldest age, failed, rejected, manual required, filed today). Each is clickable through to Submissions with a filter.
       - Card-machine attention list (needs_attention / unknown / unverified) with Reverse and Resolve.
       - Polls every 10 s and listens to socket `fiscal.filed`.
     - **Fiscal setup** (`FiscalSetup.tsx`):
       - Driver select from `/connectors/drivers`, base URL, API key (hint plus "Replace"), webhook secret (hint plus Regenerate, which shows it once), webhook URL with copy and rotate.
       - Sync timeout, file at till, file zero-value, max age.
       - "Test connection" and "Dry-run sale".
       - **Go live** (CEO only): typed `GO LIVE` and a readiness checklist. **Switch off** (CEO only).
       - "Release all held" (CEO; optionally per brand) — no date range, no skip (§17.0).
     - **POS IDs** (`PosIdsTable.tsx`): brand rows with FBR POS ID and SRB POS ID, written through `PUT /connectors/fiscal/brand-pos-ids`, plus outlet override rows (location, brand or "all brands", authority, POS id, store id).
     - **Card machine** (`TerminalSetup.tsx`): driver, enabled, base URL, key, secret, charge timeout, poll, allow manual reference, terminals list (label, outlet, vendor terminal id, active), "Test card machine".
     - **Submissions** (`FiscalSubmissions.tsx`):
       - FiscalDocument list: time, order link, brand, kind, amount, status chip, fiscal no, attempts, last error.
       - Filters: status, kind, date, brand, search.
       - Row drawer with payload and the attempts log.
       - Actions: Retry, Record manual filing (an out-of-band fiscal number), "Retry all failed". No Skip action (§17.0).
     - **Card charges** (`TerminalCharges.tsx`): the charges list for reconciliation.
- Other admin edits (W3):
  - `components/pos/PaymentModal.tsx` and `tillApi.ts` get the §7 UI:
    - terminal picker, "Charge on card machine", waiting state with countdown and Cancel;
    - approved, declined and reversed messages; unknown-outcome resolver; resume on open;
    - manual-reference link;
    - a fiscal line after pay: "Fiscal: SRB TEST-… / pending — will file automatically";
    - "Reprint when filed", enabled on socket `fiscal.filed` or a 5 s poll of `/pos/orders/:id/fiscal` for 60 s.
  - `app/orders/[id]/page.tsx`: a `FiscalPanel` (`components/connectors/FiscalPanel.tsx`) showing documents, status, number, QR (admin `qrcode`), lastError, Retry (managers) and Reprint.
  - `app/refunds/refundEngine.ts` and the refund UI: types `fiscalRefund`, and `srbReturnInvoiceNo?` deprecated. "Refund on card machine" appears when the original Payment is `card_terminal` and polls the charge.
  - `app/settings/integrations/page.tsx`: remove the TaxAuthorityCards, the `/integrations/tax/status` fetch and the WhatsApp card. Add one link card: "WhatsApp and POS are in Dev → API".
  - `app/configuration/tax/page.tsx`: redirect to `/connectors/pos`.
  - `app/configuration/page.tsx`: the "WhatsApp" and "Tax Rates & FBR" tiles become one "API connectors" tile pointing to `/connectors`. The Integrations tile copy drops FBR/SRB.
  - `app/configuration/receipts/page.tsx`: the label becomes "Show fiscal invoice number and QR" (same `showFbrInvoice`).
  - `app/marketing/brands/page.tsx`: the tab "Tax & FBR" is renamed "Tax registration". Remove the FBR/SRB POS ID inputs and stop sending them. Add the line "POS IDs are set in Dev → API → POS connector" with a link. The province field is labelled "required for Sindh tax routing" (ledger).
  - `app/help/page.tsx` and `app/onboarding/page.tsx`: copy changes from "FBR worker / submission" to the POS connector.

---

## 11. Receipt

**Backend `pos/receipt.ts` (W4)**
- `buildReceiptData(orderId)` adds:
  - `fiscal: FiscalView | { status:'legacy', … } | null`. This is the order's **sale** document via `fiscalViewForOrder(orderId, 'sale')` (W1, `connectors/fiscal/view.ts`). When there is no document but legacy columns exist, it is `{ status:'legacy', authority, fiscalNumber, qrPayload: srbQrCodeLink }`.
  - `card?: { brand, last4, authCode }` from a `card_terminal` Payment's gatewayMeta.
  - `servdRef`: the TaxInvoice number.
- Legacy keys stay for installed tablets:
  - `fbrInvoiceNo` = the fiscal number when authority is `fbr`, else `Order.fbrInvoiceNumber`.
  - `srbInvoiceNo` = the fiscal number when authority is `srb` (or from `extraNumbers`), else `Order.srbInvoiceNumber`.
  - `srbQrLink` = `verifyUrl ?? qrPayload` for srb, else `Order.srbQrCodeLink`.
- `number` ("Invoice #") is the fiscal number when the status is `filed` and not a test. Otherwise it follows the existing rule: the TaxInvoice number, else the order ref. When the fiscal number is the headline, `servdRef` prints as "Ref" (owner flag a).

**`buildReceiptHtml()`** (admin print). The fiscal block is gated by `ReceiptConfig.showFbrInvoice`.
- filed: "{AUTHORITY} Fiscal Invoice: {number}", then a **real QR** as inline SVG from `renderQrSvg(qrPayload ?? verifyUrl)` (W1 `connectors/fiscal/qr.ts`, using the `qrcode` package that W0 adds to the backend), then "Scan to verify with {AUTHORITY}" and fiscalAt. Extra numbers print one line each.
- pending or failed: "Fiscal invoice: pending — filed automatically. Ask for a reprint for the verification QR." There is no QR, and a servd number is never presented as a fiscal number.
- test: "TEST — NOT A FISCAL INVOICE".
- not_required: no block.
- legacy: the old lines, now with a QR rendered from `srbQrCodeLink`.
- Card terminal payments add the line "Card {brand} •{last4}  Auth {authCode}".

**Tablet `tablet/src/lib/printer.ts` (W3)**
- `ReceiptOrder` gains `fiscal?: { status, authority, fiscalNumber, qrPayload, verifyUrl }`.
- Print rules:
  - filed: `${AUTH} Fiscal Invoice ${number}`, then the ESC/POS native QR (GS ( k, model 2, size 6, EC M) of `qrPayload ?? verifyUrl`, captioned "Scan to verify with ${AUTH}".
  - pending: the pending line.
  - test: the TEST banner.
- When `fiscal` is absent (older API), it falls back to `fbrInvoiceNo`, `srbInvoiceNo` and `srbQrLink`.

**Reprints** always re-read the receipt from the server, so a late filing appears on the next print.

**TaxInvoice HTML** (`/invoices/:id/html`) is unchanged tonight. Linking the fiscal number into it waits on owner flag (a).

---

## 12. Removal of direct FBR/SRB

Every touchpoint from the map, with its fate and owner. Nothing in the database is dropped.

| Touchpoint | Fate | WS |
|---|---|---|
| `backend/src/adapters/fbr/index.ts`, `README.md` | **Delete**, after its rules are ported into `connectors/fiscal/payload.ts` and covered by `fiscalPayload.test.ts` | W1 ports / W4 deletes |
| `backend/src/adapters/srb/index.ts` (+ README) | **Delete** (sale and return rules ported) | W1 / W4 |
| `backend/src/workers/fbrSubmission.ts`, `srbSubmission.ts` | **Delete**; replaced by `fiscalConnector.ts` | W4 |
| `backend/src/lib/queue.ts` | Add `getFiscalQueue` (W0). Remove `getFbrQueue`, `getSrbQueue`, `FbrSubmissionJob` and `SrbSubmissionJob` (W4) | W0/W4 |
| `backend/src/index.ts` | Remove the FBR/SRB imports, the starts and `/integrations/tax/status`. Register the 3 connector plugins. Call `drainLegacyTaxQueues()`, then start the 2 new workers. Merge the health checks. | W4 |
| `orders/service.ts` `completeOrder` | `enqueueFiscalSaleTx` inside the claim tx. Remove the FBR/SRB enqueue, `submitSrbForReceipt` and `SrbReceipt`. `opts.syncSrb` becomes `syncFiscal`. Return `{ ran, fiscal: FiscalView \| null }`. `updateOrderStatus` refunded/cancelled after completion calls `enqueueFiscalRefundTx('void:<orderId>', amount = sale total − prior refund docs)` next to `issueCreditNoteForOrder`. | W4 |
| `pos/service.ts` | `afterTillSale` uses `syncFiscal:true` and returns fiscal. processPayment, settlePayment, compOrder and applyGiftCardTender return `{fiscal, srb: legacyAlias}`. Delete `submitSrbReturnForRefund`, the 5-min delayed return and the `getSrbQueue` import. `refundOrder` calls `enqueueFiscalRefundTx` in its tx and kicks after commit. Add `terminalChargeId?` and `gateway?` to the ProcessPaymentInput tenders, SettleInput and RefundInput. Persist `gatewayMeta.terminalChargeId` etc. Add active-charge guards. | W4 |
| `pos/routes.ts` | Response fields; shift-close guard | W4 |
| `pos/receipt.ts` | §11 | W4 |
| `checkSplit/routes.ts` | Guard; `fiscal` + alias if it echoes srb | W4 |
| `paymentGateways/keenuSettle.ts` | Skip `card_terminal` rows and rows with `gatewayMeta.terminalChargeId` | W4 |
| `tablet/src/lib/printer.ts` | §11 | W3 |
| `PaymentModal.tsx`, `tillApi.ts` | Terminal step + fiscal line | W3 |
| `invoices/*` (TaxInvoice) | **Keep as-is.** Owner flag (a). Pre-existing debt: no tenantId, global unique number, raw tenantFilter. Flagged, not fixed here. | — |
| `concepts/routes.ts` + `marketing/brands/page.tsx` | Backend **unchanged** (still accepts fbrPosId/srbPosId). The admin stops sending them; the POS page is the editor. | W3 |
| `accounting/orderPosting.ts`, `shiftPosting.ts`, `salesTaxReturn.ts`, `journal.ts`, `chartOfAccounts.ts` | **Unchanged.** srbPosId still routes to 2032. | — |
| `settings/integrations/page.tsx`, `configuration/tax/page.tsx`, `configuration/page.tsx`, `configuration/receipts/page.tsx`, `refunds/refundEngine.ts`, `orders/[id]/page.tsx`, `help`, `onboarding`, `moduleCatalog.ts`, `appRoles.ts` | §10 | W3 |
| `lib/workspaces.ts`, `lib/moduleAccess.ts` | API section | W2 |
| `lib/whatsapp.ts`, `auth/routes.ts` WhatsApp handlers, `configuration/whatsapp/page.tsx` | Encrypt the key, roles admin+it, add a platform comment. The page is moved (W3). | W2/W3 |
| `webhooks/routes.ts`, `adapters/whatsapp/conversation.ts` | **Unchanged** (inbound Meta; out of scope; noted on the WhatsApp page) | — |
| `adapters/payment/*`, `storefront/paymentMethods.ts`, `paymentGateways/*` (except keenuSettle) | **Unchanged** (owner flag b) | — |
| `tests/receipt.test.ts` | Update to fiscal fields + legacy | W4 |
| `tests/auditOrdersRefund.test.ts` | Keep | — |
| `tests/brandReconcile`, `auditLedgerSales`, `auditTillUi` | Keep; must pass | — |
| `tests/whatsappConfig.test.ts` | Extend (it role, encryption) | W2 |
| `.env.example`, `infra/main.tf`, `infra/prod.tfvars.example`, `docs/TAX_SETUP.md`, `scripts/generate-readmes.ts`, `src/*/README.md` | Remove `FBR_*` and `SRB_*` plus the SSM params. Add `SERVD_SECRET_KEY`. Rewrite TAX_SETUP as "Fiscal POS connector". Regenerate the READMEs **after W4**, as part of the orchestrator's final pass. | W2 (+orchestrator) |
| `backend/scripts/wipe-orders.ts`, `wipe-and-reset.ts` | Delete `fiscal_attempts`, `fiscal_documents` and `terminal_charges` before payments and orders | W2 |
| `CLAUDE.md` | New section: "POS connector — FBR/SRB filing ONLY through `connectors/`; never add a direct authority client; any completion path goes through completeOrder (outbox); srbPosId still routes Sindh tax; API section = WhatsApp + POS" | W2 |

**Ordered landing** (the same push to main releases steps 3–5 together, so a deployed image never has both filers):
1. W0 foundation: additive schema, secretBox, types, queue add. Harmless if deployed alone.
2. W1, W2 and W3 land. The connector exists but nothing calls it, and the old path still files. Harmless if deployed alone.
3. W4 switches completeOrder, refundOrder and the till to the connector.
4. W4 deletes the adapters, workers, queues and route, and wires the drain plus the new workers.
5. The orchestrator verifies (typecheck backend + admin + tablet, vitest, admin build), regenerates the READMEs, then pushes steps 3–5 in one push.
6. Deploy: the box pulls the new api image. Confirm a **single** api container (`docker compose ps`), check the `fiscal.legacy_drain` audit row, and confirm no `bull:fbr-submission*` or `bull:srb-submission*` keys remain.
7. Later, per company (CEO): configure, test, register POS ids, go live, then release ALL held documents (no skip).
8. One release later: remove the `srb` and `srbReturnInvoiceNo` aliases and `legacyDrain.ts`. Keep the receipt legacy keys until the tablet ships the new printer.

**Rollback:** roll back to a pre-W4 image only while no company has `liveSince`. After that, rolling back restarts direct filing and both paths would file.

---

## 13. Migration

W0 generates the migrations with `prisma migrate dev --create-only` **after** the other agents' schema edits are committed, then reviews them.
1. `backend/prisma/migrations/20261010120000_payment_gateway_card_terminal/migration.sql`:
   ```sql
   ALTER TYPE "PaymentGateway" ADD VALUE IF NOT EXISTS 'card_terminal';
   ```
   This is a migration of its own, because a new enum value cannot be used in the same transaction.
2. `backend/prisma/migrations/20261010120100_pos_connector/migration.sql`:
   - Create the 5 new enum types.
   - Create the tables `pos_connectors`, `fiscal_documents`, `fiscal_attempts` and `terminal_charges`, with the FKs Prisma generates. Orders and tenants are RESTRICT, and attempts → documents is CASCADE.
   - Create all indexes, plus this raw SQL:
   ```sql
   CREATE UNIQUE INDEX "terminal_charges_one_active_per_order" ON "terminal_charges" ("orderId")
     WHERE "kind" = 'charge' AND "status" IN ('pending','sent','approved','cancel_requested','unknown');
   ```
   - Do **not** seed connector rows, because they are created lazily. Do not backfill fiscal documents, because historical orders keep their Order columns.
3. Nothing is dropped, renamed or nulled. `Concept.fbrPosId` and `srbPosId`, the `Order.fbr*`/`srb*` columns and `ReceiptConfig.showFbrInvoice` are all untouched.
4. Runtime steps:
   - Add `SERVD_SECRET_KEY` (`openssl rand -base64 32`) to the box's api env and to the deploy secret list in CLAUDE.md, never to the repo.
   - `lib/whatsapp.ts` re-encrypts a plaintext key on first read when the key env is present. This is idempotent; without the env it stays readable and /health warns.
   - `prisma migrate deploy` runs on boot as today, followed by the drain and then the workers.

---

## 14. Tests

vitest against local Postgres and Redis. Tests use the test driver with an injected clock (`ctx.now`). Every route suite has two companies, A and B, each with an admin, an it user and a cashier.

| File | Owner | Asserts |
|---|---|---|
| `tests/secretBox.test.ts` | W0 | Round trip; GCM tamper is detected; a wrong key fails; hint format; plaintext passthrough via `isEncrypted` |
| `tests/fiscalPayload.test.ts` | W1 | Stored taxCents and taxRatePct are used (cash 15 and card 8 give different payloads); line tax sums exactly; discount = discount + promo; mode is cash/card/mixed; `concept.taxRate` is never read (set it to 17 and assert it is absent); the outlet override beats the brand id; no registration gives an empty list; refund pro rata sums exactly; payloadHash is stable; ported FBR/SRB adapter expectations |
| `tests/fiscalOutbox.test.ts` | W1 | `enqueueFiscalSaleTx` is idempotent (5 concurrent calls in separate txs give 1 row); a rolled-back tx gives no row; held/no_connector; held/not_registered; prefiled gives skipped; zero_value rules; refund states (filed → pending, pending sale → waiting, then promoted when the sale files; prefiled → manual_required + ExceptionFlag; skipped sale → skipped; two partial refunds give two documents) |
| `tests/fiscalSend.test.ts` | W1 | ok → filed with the number and QR; transient → backoff schedule (fake clock); `slow` with the sync budget gives unknown, then a worker lookup gives filed with **1 submit**; `unknown_then_filed` gives submit count 1; `processing_then_ok`; reject → rejected + one alert (dedupe); auth → stays pending + `fiscal_auth` once; past maxAge → failed; lease expiry → sweeper → lookup; two racing senders → one driver call; queue add throws → sweeper sends inline; manual retry/skip/manual_filed promote refunds |
| `tests/connectorsRoutes.test.ts` | W1 | B gets 404 on A's documents, retry, manual, charges (and there is NO skip route — 404) and brand ids; PUT binds the active company; a foreign locationId or conceptId gives 422; secrets never appear in any response (deep substring scan); audit has field names only; cashier gets 403 on `/connectors/*`; it and admin get 200; management is read-only; go-live and release are admin-only; NOT_READY reasons; SSRF (http, localhost, 10.x) gives 422; empty scope gives `[]` |
| `tests/posWebhook.test.ts` | W1 | Valid signature applies; bad signature gives 401; stale timestamp gives 401; no secret gives 503; unknown token gives 404; a replayed event id is applied once; B's charge id on A's token is ignored and B's row is untouched |
| `tests/terminalCharge.test.ts` | W1 | Happy path: one Payment (method card, gateway card_terminal, gatewayRef = approvalRef, amount = 8 % due + tip) and an order completed with a fiscal document; a double tap with the same key gives one charge and one start; a different key while active gives 409 CHARGE_IN_PROGRESS; stale expectedDueCents gives 409 with nothing pushed; webhook racing poll gives one Payment; a foreign order gives 404; a foreign shift gives 422 |
| `tests/terminalTimeout.test.ts` | W1 | `never` → expired; `unknown_start` → reconciler auto-records; `unknown_start` plus cash taken meanwhile → reversed (voided) + alert; `late_approve` cancel → recorded; `void_fails` → needs_attention + `terminal_void_failed`; `offline` → TERMINAL_UNREACHABLE and the manual path still records with manualReason; resolve approved_manual then vendor declined → `terminal_unreconciled`; unknown > 24 h → needs_attention; split portion settles via settlePayment |
| `tests/terminalRefund.test.ts` | W1 | Referenced refund approved gives one negative Payment via refundOrder plus a fiscal refund document; unknown gives no Payment until the reconciler; legacy `none` rows use the manual refund |
| `tests/whatsappConfig.test.ts` (extend), `tests/connectorsWhatsapp.test.ts` | W2 | `it` can GET/PUT (was 403); cashier gets 403; the key is stored as `enc:v1:`; legacy plaintext is read and re-encrypted; DB-over-env precedence is unchanged |
| `tests/workspaces.test.ts` | W2 | Dev `api` section is exactly `['api_whatsapp','api_pos']`; each id appears in exactly one workspace |
| `tests/receipt.test.ts` (update) | W4 | Filed gives "SRB Fiscal Invoice: TEST-SRB-…" and `<svg`; pending gives the pending line with no number; test gives the banner; a legacy order still prints the old lines plus a QR; JSON keeps fbrInvoiceNo/srbInvoiceNo/srbQrLink; `showFbrInvoice=false` hides the block |
| `tests/fiscalTill.test.ts` | W4 | POST /pos/payments with `slow` returns within syncTimeoutMs + 500 ms with fiscal pending and the payment committed; `ok` returns the number and the `srb` alias; a driver throw never fails the payment; every completion door creates exactly one sale document (till, expo, rider, otp, status_update, keenu, group, comp) |
| `tests/terminalGuards.test.ts` | W4 | With an active charge, cash/settle/comp/gift card/check split all give 409 TERMINAL_CHARGE_ACTIVE; shift close gives SHIFT_HAS_ACTIVE_CHARGE; bill changed after start → approval → AMOUNT_MISMATCH → auto-void |
| `tests/keenuSeparation.test.ts` | W4 | A Keenu callback with transaction_id equal to a terminal approvalRef does not settle or fail the card_terminal Payment |
| `tests/legacyDrain.test.ts` | W1 | Seeded jobs are obliterated; audit row written; unfiled orders become held/legacy_unfiled; a second run is a no-op |
| `tests/removedTaxPath.test.ts` | W4 | Static grep of `backend/src` finds none of `adapters/fbr`, `adapters/srb`, `getFbrQueue`, `getSrbQueue`, `fbr-submission` (outside legacyDrain.ts), `srb-submission` (outside legacyDrain.ts), `submitSrb`, `FBR_USERNAME`, `/integrations/tax/status` |
| `tests/healthConnectors.test.ts` | W1 | Warn conditions; never fail |
| Unchanged, must pass | — | brandReconcile, auditLedgerSales (srbPosId → 2032), auditTillUi, auditTillMoney, auditOrdersRefund |

---

## 15. Build split

Workstreams own disjoint files. Agents do not run builds or dev servers. The orchestrator runs the single verification pass.

**Hot files** are edited only by the orchestrator, in W4, after the other agents' uncommitted edits to them are committed: `orders/service.ts`, `pos/service.ts`, `pos/routes.ts`, `pos/receipt.ts`, `checkSplit/routes.ts`, `index.ts` and `schema.prisma` (W0). If `auth/routes.ts` still has foreign uncommitted edits when W2 starts, W2 leaves its two-line role and encryption change to the orchestrator.

### W0 — Foundation (orchestrator; lands first, about 45 min)
- Owns:
  - `backend/prisma/schema.prisma` and both migrations;
  - `backend/src/lib/secretBox.ts`, which exports `encryptSecret(plain)`, `decryptSecret(enc)`, `isEncrypted(v)`, `secretHint(plain)` and `secretKeyConfigured()`. When the key is missing, encrypt throws `AppError('SECRET_KEY_MISSING',…,503)`;
  - `backend/src/lib/connectorRoles.ts` (`CONNECTOR_ADMINS`);
  - `backend/src/connectors/types.ts` (verbatim from §3);
  - `backend/src/lib/queue.ts` (add `getFiscalQueue` only);
  - `backend/package.json` (+`qrcode`, +`@types/qrcode`);
  - `tests/secretBox.test.ts`.
- Done when `prisma generate` and a typecheck pass, and it is committed.

### W1 — Connector core (agent, Opus; after W0)
- Owns:
  - `backend/src/connectors/**` except `types.ts`: `registry.ts`, `config.ts` (zod settings, SSRF guard, ctx builder), `util.ts` (withTimeout, backoff, hmac sign/verify, jitter), `drivers/test.ts`, `drivers/http.ts`, `fiscal/payload.ts`, `fiscal/outbox.ts`, `fiscal/view.ts`, `fiscal/qr.ts`, `terminal/service.ts`, `terminal/guard.ts`, `alerts.ts`, `health.ts`, `legacyDrain.ts`, `README.md`;
  - `backend/src/modules/connectors/{routes.ts,posRoutes.ts,webhookRoutes.ts,index.ts}`. `index.ts` exports `registerConnectorPlugins(app)`, which registers the three plugins with their prefixes;
  - `backend/src/workers/fiscalConnector.ts` and `terminalConnector.ts`;
  - `backend/src/lib/exceptions.ts` (kinds only);
  - `docs/pos-connector-api.md`;
  - the W1 tests in §14.
- Exports that W4 and W3 rely on (names are fixed):
  - `enqueueFiscalSaleTx`, `enqueueFiscalRefundTx`, `submitFiscalNow`, `kickFiscal`, `fiscalViewForOrder`, `legacySrbAlias(fiscal)`;
  - `renderQrSvg`;
  - `assertNoActiveTerminalChargeTx`, `assertShiftHasNoActiveCharges`;
  - `drainLegacyTaxQueues`, `connectorHealthChecks`;
  - `startFiscalConnectorWorker`, `startTerminalConnectorWorker`, `registerConnectorPlugins`.
- W1 calls `processPayment`, `settlePayment`, `refundOrder`, `lockOrderTx` and `quoteOrderForTender` from `pos/service.ts` with the **new** optional fields (`terminalChargeId`, `gateway`). Until W4 lands, those fields are declared locally with a `// W4 adds` cast. **No `as never`.** Use a typed local interface that extends the input.
- Ports: read `adapters/fbr/index.ts` and `adapters/srb/index.ts` before writing `payload.ts`, and encode their figures in `fiscalPayload.test.ts`. W1 does not delete them.

### W2 — Platform, WhatsApp, sidebar, docs (agent, Opus; parallel with W1)
- Owns:
  - `backend/src/lib/whatsapp.ts` (decrypt and re-encrypt, platform comment);
  - `backend/src/modules/auth/routes.ts` (only the WhatsApp and delivery-status handlers: roles become `CONNECTOR_ADMINS`, PUT encrypts, GET adds `scope:'platform'`);
  - `backend/src/lib/moduleAccess.ts`, `backend/src/lib/workspaces.ts`;
  - `backend/scripts/wipe-orders.ts`, `wipe-and-reset.ts`;
  - `.env.example`, `infra/main.tf`, `infra/prod.tfvars.example`, `docs/TAX_SETUP.md`, `scripts/generate-readmes.ts` (inputs only), `CLAUDE.md` (new section + deploy secret row);
  - `tests/whatsappConfig.test.ts`, `tests/connectorsWhatsapp.test.ts`, `tests/workspaces.test.ts`.

### W3 — Admin UI + tablet (agent, Opus; parallel with W1, coded against §8 shapes)
- Owns:
  - `frontend/admin/src/app/connectors/**` (page.tsx, whatsapp/page.tsx via `git mv`, pos/page.tsx);
  - `frontend/admin/src/components/connectors/**`;
  - `frontend/admin/src/lib/connectorsApi.ts`;
  - `components/pos/PaymentModal.tsx`, `components/pos/tillApi.ts`;
  - `app/orders/[id]/page.tsx`, `app/refunds/refundEngine.ts` (+ the refund screen file that renders it);
  - `app/settings/integrations/page.tsx`, `app/configuration/{tax,page,receipts}` pages, `app/marketing/brands/page.tsx`, `app/help/page.tsx`, `app/onboarding/page.tsx`;
  - `lib/moduleCatalog.ts`, `lib/appRoles.ts`, `next.config.js` (redirect);
  - `tablet/src/lib/printer.ts`.
- If `PaymentModal.tsx` or `refundEngine.ts` carry foreign uncommitted edits, W3 waits for them or hands the patch to the orchestrator.

### W4 — Hot-path cutover + deletion (orchestrator; after W1 and after foreign edits land)
- Owns:
  - `backend/src/modules/orders/service.ts`;
  - `backend/src/modules/pos/{service,routes,receipt}.ts`;
  - `backend/src/modules/checkSplit/routes.ts`;
  - `backend/src/modules/paymentGateways/keenuSettle.ts`;
  - `backend/src/index.ts`;
  - `backend/src/lib/queue.ts` (removals);
  - deletions of `adapters/fbr`, `adapters/srb`, `workers/fbrSubmission.ts` and `workers/srbSubmission.ts`;
  - `tests/receipt.test.ts`, `fiscalTill.test.ts`, `terminalGuards.test.ts`, `keenuSeparation.test.ts`, `removedTaxPath.test.ts`;
  - the final regenerated `src/*/README.md`.
- This is money, tax and auth code, so it is verified at the Opus level or above.

**Landing order:** W0 → (W1 ‖ W2 ‖ W3) → W4 → orchestrator verification (backend `tsc` + vitest; admin `tsc` + `next build`; tablet `tsc`; screenshots of `/connectors`, `/connectors/pos` and the till card flow on the test driver) → one push to main containing W4.

---

## 16. Owner checklist (what the owner or vendors must provide)

1. **Confirm the gap (flag f).** Is direct FBR PRAL / SRB filing live in prod today (are `FBR_USERNAME` and `SRB_USERNAME` set on the box)? If yes, shipping W4 stops all filing until a vendor goes live. The choice is to accept that gap, or to hold the W4 push until a vendor driver is ready (W0–W3 can ship now).
2. **Fiscal POS vendor.** Name, API docs or agreement to implement "servd connector API v1", base URL, API key, which authorities it files (FBR, SRB, or both for Sindh brands), idempotency support (`Idempotency-Key`), document lookup, refunds/credit notes, zero-value invoices, whether it needs PCT/HS codes per item (not modelled yet), and certification or test environment.
3. **Card processor / terminal vendor.** Name, API (push-to-terminal or cloud), terminal ids per outlet, cancel, same-day void, referenced refund, webhooks, settlement report (for the deferred nightly match), and whether it is Keenu (the double-settlement rule is already handled).
4. **POS registration ids** per brand, and per outlet where FBR/SRB registered per outlet. Province on every brand (Sindh tax routing).
5. **`SERVD_SECRET_KEY`** generated and added to the box env (`openssl rand -base64 32`), kept outside the repo.
6. **Decisions:**
   - (a) TaxInvoice vs the fiscal number. Default: fiscal number is the headline, TaxInvoice prints as "Ref". The alternative is to retire the auto-issued TaxInvoice. Separately, TaxInvoice has no tenantId and a global unique number, which is pre-existing debt.
   - (b) Keep TerminalDriver separate from the online PaymentAdapter (default yes).
   - (c) WhatsApp stays one GS Foods gateway for every company (default yes; per-company sender numbers later).
   - (d) File zero-value comps and staff meals (default yes).
   - (e) Refunds of sales filed directly before cutover go to "file manually" (default).
   - Held window at go-live: every held sale is released and filed late (no skip option — owner amendment §17.0).
7. **Go-live per company (CEO):** Dev → API → POS connector → driver + keys → Test → POS IDs → Go live → release all held.
8. **Training:** never re-key a charge on the machine while servd shows "Check the card machine"; use Resolve. Use the manual reference only when the machine is offline.
9. **Inbound WhatsApp ordering bot** still uses env `WHATSAPP_DEFAULT_CONCEPT`, which is not company-scoped. It is out of scope here and should be scheduled separately.


---

## 17. Owner amendments (2026-10-10, after the design) — BINDING, override anything above

### 17.0 No skipping real sales
Owner context: the business is not trading yet, so nothing is filed today and there is no gap to protect; W4 removes direct FBR/SRB filing outright. A real sale is never excluded from fiscal filing by an operator: there is no per-document Skip, no date-range skip, and no "skip held" at go-live. `skipped` is automatic only (prefiled_direct, zero_value per the zero-value setting, zero_value_unsupported, no_sale_document). "Record manual filing" (an out-of-band fiscal number with who/when) stays. Every held document is filed when released.

### 17.1 Pre-bills vs the full & final (FnF) bill
Owner: "Making a prebill shouldn't report the sale to POS. Only a fnf (full and final) bill will report/push the sale. Pre bills that are created must go to a special section in ERP finance called 'voided pre bills'." Owner: "This void is not a void that cashier or server can do. It must be manager that voids."

- **Pre-bill** = the bill printed for an OPEN order before payment (till, waiter screen). It prints `PRE-BILL — NOT A TAX INVOICE`, a pre-bill number `PB-<n>` (per company), the lines and the server-quoted totals (cash total, and the card total line), and NO fiscal number/QR. It NEVER creates or touches a FiscalDocument and is never sent to the POS. Every pre-bill print (including reprints) is a permanent record.
- **FnF bill** = the bill of a fully paid / completed order: heading `FULL & FINAL BILL` + the fiscal block (number + QR from the POS, or `Fiscal invoice: pending`). The fiscal sale document is created ONLY in completeOrder (D4) — completion is the FnF event, exactly once per order. Online/storefront orders (no pre-bill) file once on completion. Refund after FnF → fiscal refund document. Cancel/void before FnF → nothing goes to the POS.
- An order that is not final can no longer print something that looks like a final bill: `GET /pos/receipt/:orderId` and `GET /pos/orders/:orderId/receipt-data` for a non-final order return 409 `PRE_BILL_REQUIRED` ("This order isn't paid yet — print a pre-bill"). Reprints of the FnF bill keep the existing DUPLICATE banner.

### 17.2 Data model (W0, exact)
```prisma
enum PreBillStatus {
  open        // latest pre-bill of an order that is not final yet
  superseded  // a later pre-bill was printed for the same order
  converted   // the order reached its FnF bill (completeOrder)
  cancelled   // the order was cancelled / voided / rejected before FnF
}

/// A pre-bill (guest check printed before payment). NEVER a fiscal document, never sent to the POS, never revenue.
/// Permanent audit trail: rows are never deleted or hidden (Finance -> Voided pre bills).
model PreBill {
  id                 String        @id @default(cuid())
  tenantId           String
  conceptId          String
  locationId         String?
  orderId            String
  shiftId            String?
  number             Int           // per company, gap-free (PreBillCounter)
  tableLabel         String?
  printedById        String
  printedAt          DateTime      @default(now())
  tender             String        // quote basis shown as the headline total: 'cash' | 'card'
  lines              Json          // [{orderItemId, name, qty, unitPriceCents, modifiers:[{name, priceDeltaCents}], lineCents}]
  subtotalCents      Int
  discountCents      Int
  serviceChargeCents Int
  taxCents           Int
  totalCents         Int           // headline total at `tender`
  cardTotalCents     Int?          // the card-tender total shown alongside a cash headline
  status             PreBillStatus @default(open)
  statusAt           DateTime?
  finalTotalCents    Int?          // order.totalCents at FnF (converted, and copied onto superseded rows of that order)
  finalAt            DateTime?
  cancelledById      String?       // the MANAGER who approved the cancel/void of the order
  cancelReason       String?
  createdAt          DateTime      @default(now())

  tenant Tenant @relation("TenantPreBills", fields: [tenantId], references: [id])
  order  Order  @relation(fields: [orderId], references: [id])

  @@unique([tenantId, number])
  @@index([tenantId, printedAt(sort: Desc)])
  @@index([tenantId, status])
  @@index([orderId])
  @@map("pre_bills")
}

/// Per-company pre-bill number sequence (one row per company, locked FOR UPDATE when issuing).
model PreBillCounter {
  tenantId String @id
  next     Int    @default(1)
  @@map("pre_bill_counters")
}
```
Back-relations: `Order.preBills PreBill[]`, `Tenant.preBills PreBill[] @relation("TenantPreBills")`. Migration `20261010220000_pre_bills` (create enum + 2 tables, no backfill).

### 17.3 Backend (W5 owns `backend/src/modules/prebills/**`; hooks are called by W4)
- `service.ts` exports:
  - `createPreBill({ orderId, actor, tender, req })` — company check via scopeTenantWhere(req,'write') (foreign → 404); order must be open and not final (completed/fully paid → 409 `ALREADY_FINAL`; cancelled/rejected/refunded → 409 `ORDER_NOT_OPEN`); totals come from the server quote (`quoteOrderForTender` from pos/service.ts — the same pricing the payment demands; never computed here); in ONE transaction: lock the order row, take the next number from PreBillCounter (SELECT … FOR UPDATE / upsert), mark the order's `open` pre-bills `superseded`, insert the PreBill, write audit `prebill.print`. Returns `{ preBill, receipt }` where `receipt` is the receipt-data shape with `kind:'pre_bill'`, `banner:'PRE-BILL — NOT A TAX INVOICE'`, `number:'PB-<n>'` and no fiscal fields.
  - `markPreBillsConvertedTx(tx, orderId, finalTotalCents, at)` — open → converted; superseded rows get finalTotalCents/finalAt too (status unchanged). Called by W4 inside completeOrder's claim transaction.
  - `markPreBillsCancelledTx(tx, orderId, approverId, reason, at)` — open/superseded → cancelled with cancelledById. Called by W4 in every cancel/void-whole-order path.
  - `renderPreBillHtml(preBillId, req)` (same company) using the receipt look.
- `routes.ts` (plugin registered by W4 in index.ts):
  - `POST /pos/orders/:orderId/pre-bill` — CASHIERS + waiter roles (the roles that can take payment / ring orders). Body `{ tender?: 'cash'|'card' }` (default cash).
  - `GET /pos/pre-bills/:id/html` — printable; same roles; foreign → 404.
  - `GET /pre-bills` — Finance list: roles admin, owner, management, finance (module `voided_prebills`); `resolveTenantScope(req)` read (empty scope → nothing); query `from,to` (PKT days via the reports' `reportDateRange` helper), `conceptId`, `printedById`, `status`, `flagged=1`, `format=csv`. Rows: number, printedAt, brand, table, order number, printed by (name), headline total, status, final total, difference (final − pre-bill), cancelledBy (manager name) + reason, lineVoidsAfter {count, cents} (OrderItem.voidedAt > printedAt, with the voiding approver), and `flags`: `ORPHANED` (order cancelled/rejected, or still not final and (its shift is closed or printedAt older than 12 h)), `FINAL_LOWER` (finalTotalCents < totalCents on the converted row), `LINE_VOIDS_AFTER`. Summary: count, value, orphaned {count, cents}, finalLower {count, diffCents}, lineVoidsAfter {count, cents}. CSV with the same columns.
  - There is NO delete, hide, edit or exclude endpoint for pre-bills. Pre-bills never post to the ledger and never feed revenue or tax reports.
- Tests `backend/tests/preBills.test.ts` (W5): two companies (B gets 404 on A's order/pre-bill, B's finance list never shows A); numbering per company gap-free under 5 concurrent prints; reprint supersedes; a pre-bill creates ZERO FiscalDocument rows; totals equal `GET /pos/orders/:id/quote`; ALREADY_FINAL / ORDER_NOT_OPEN; list flags (orphaned via cancel, orphaned via shift closed, final lower, line voids after) with the hooks called directly; CSV.

### 17.4 Manager-only voids (W4, in pos/service.ts + order cancel paths)
- `voidOrderItem`: EVERY void needs a manager — the actor is an override approver (isOverrideApprover) or a valid same-company manager PIN is supplied; the cashier void cap is treated as 0 for voids (manager cap unchanged). `approverId` is always recorded (the actor's own id when the actor is the manager).
- Cancelling / voiding a whole rung-up order (POS and the admin order-status change to cancelled/rejected for in-house orders) by a non-manager needs a manager PIN; approverId recorded; `markPreBillsCancelledTx` is called with it.
- Errors: `MANAGER_OVERRIDE_REQUIRED` (403) without PIN; `INVALID_MANAGER_PIN` (403) for a wrong or other-company PIN.
- Tests `backend/tests/managerVoids.test.ts` (W4): cashier and waiter void without PIN → 403; with company B's manager PIN → 403; with own manager PIN → 200 + approverId; manager login → 200; cancel paths likewise.

### 17.5 Admin (W3 + W5)
- W3 (till): `PaymentModal.tsx` / till screens get "Print pre-bill" (POST pre-bill → open `/pos/pre-bills/:id/html`), handle 409 `PRE_BILL_REQUIRED` from the old print button, the FnF print after payment; the void dialog always asks for a manager PIN unless the signed-in user is a manager; refund-policy page (`frontend/admin/src/app/configuration/refund-policy/**`) says "Voids always need a manager" and hides the cashier void limit for voids. `lib/moduleCatalog.ts`: add `voided_prebills: [{ label: 'Voided pre bills', href: '/finance/voided-pre-bills', hint: 'Every pre-bill printed — flagged when it never became a full & final bill or the final bill came out lower' }]`. Tablet `printer.ts`: handle 409 PRE_BILL_REQUIRED and the `kind:'pre_bill'` banner.
- W2: module id `voided_prebills` in `lib/workspaces.ts` (Finance workspace — the section with the controls/reconciliation modules) and `lib/moduleAccess.ts` defaults (admin, owner, management, finance); `tests/workspaces.test.ts` stays green (every module id in exactly one workspace).
- W5: page `frontend/admin/src/app/finance/voided-pre-bills/page.tsx` (+ README): filters (date range, brand, cashier, status, "Flagged only"), summary tiles, table with red flag chips, a row drawer (lines, who printed, final bill, manager who cancelled, line voids after), CSV download. Read-only. Admin colour tokens only.

### 17.6 Ownership additions
- W0 adds §17.2 to the schema + migration.
- W5 (new agent, parallel with W1–W3): `backend/src/modules/prebills/**`, `backend/tests/preBills.test.ts`, `frontend/admin/src/app/finance/voided-pre-bills/**`.
- W4 adds: registering the prebills plugin in index.ts; calling markPreBillsConvertedTx in completeOrder's claim tx and markPreBillsCancelledTx in every cancel/void-whole-order path; receipt 409 for non-final orders + FnF heading; manager-only voids; `tests/managerVoids.test.ts`.

### 17.7 Per-company "Fiscal reporting required" setting (owner, 2026-10-10)
Owner: a test company, or the owner's home kitchen (cooks for ~150 — joint family and staff), must be able to run on servd without the POS connector. Each company already has its own fiscal + terminal PosConnector (driver 'none', off by default), but an off fiscal connector makes sales `held` and alerts — wrong for a non-commercial company.
- Add a COMPANY-LEVEL setting `fiscalReportingRequired` (default TRUE) — store it on the company's fiscal PosConnector row's settings (no schema change) or a Tenant column if one fits; read through one helper `fiscalReportingRequired(tenantId)`.
- When FALSE: completeOrder creates NO FiscalDocument for that company's orders (no held backlog, no /health warning, no alerts); receipts print "Not a tax invoice"; the POS connector page shows a clear banner "Fiscal reporting: not required for <company> (non-commercial / test)". The terminal (card machine) connector is independent and still usable.
- Only the CEO (role admin) can change it; every change writes an audit row (who, when, old -> new, reason required). It applies to the WHOLE company — never per sale, per brand, per order or per date range. Switching it back to TRUE applies to sales completed from then on.
- Tests: two companies, A required / B not required — A's completed sale creates a held/pending document, B's creates none; non-admin gets 403 on the toggle; audit row written.
- Ownership: W1 (connectors/config.ts + routes + outbox check) and W3 (POS connector page toggle + banner); W4 calls the helper in completeOrder.
