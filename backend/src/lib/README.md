# backend/src/lib

Cross-cutting infrastructure used by every module.

## Files

- `prisma.ts` — Singleton Prisma clients: `prisma` (RLS session vars) and `serviceClient` (no RLS); both carry the money boundary from `money.ts`.
- `money.ts` — Money in paisa (BOOKS-06): the `moneyAsNumbers` extension that returns BIGINT money columns as JS numbers, `toCents`/`sumCents`, the ceilings (`MAX_MONEY_CENTS` PKR 900bn for BIGINT, `INT4_MAX_CENTS` for INT4) and their guards (`zMoneyCents`, `zInt4Cents`, `assertMoneyFits`, `assertInt4Fits`, `amountTooLarge`).
- `redis.ts` — Singleton Redis client.
- `ws.ts` — Socket.IO server + safe emitters (never throw if WS is uninitialised).
- `errors.ts` — `AppError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError` + Fastify error formatter.
- `storage.ts` — Cloudflare R2 presigned-URL generator.
- `moduleAccess.ts` — Role → module defaults and the server-side module gate (`RoleModuleAccess`).
- `tenantScope.ts` — Company scoping helpers (`scopeTenantWhere`, `assertConceptOwned`, `activeTenantId`, …). Empty scope denies.
- `audit.ts` — Audit log helpers (used by refunds, voids, comps, config edits).
- `notify.ts` — Email + SMS dispatchers (no-op when SMTP/Twilio aren't configured).
- `whatsapp.ts` — Meta Cloud API client.
- `reservation.ts` — Background cart-release worker for abandoned reservations.
- `secretBox.ts` — AES-256-GCM encryption at rest for integration secrets (key from `SERVD_SECRET_KEY`).
- `connectorRoles.ts` — Who may configure the API connectors (`CONNECTOR_ADMINS`).
- `conceptAccess.ts` — Multi-tenant access control (which concepts a staff user can see).
- `fleet.ts` — Fleet agreements: may this rider's company carry that order's company's orders? (the one rule — `docs/rider-app.md`).
- `deliveryOtp.ts` — The delivery hand-over code: CSPRNG generation, constant-time compare, the 5-try limit, and who may read it (admin / management).
- `stockLedger.ts` — **THE stock writer** (finance wave B, H16): FIFO `StockLot`s at the price paid and the append-only `StockMovement` ledger. `ensureFifoReady(tenantId)` before any stock transaction (runs the company's one-time cut-over), `addLotTx`, `consumeFifoTx`, `returnToLotsTx`, `relabelToWasteTx`, `lockItemsTx` (items locked in id order), `lotValuation`, `readFifoCutoverAt`. `InventoryItem.currentStock` is a cache of the lots; an item with no company is refused on every write (422 `ITEM_HAS_NO_COMPANY`). Details: `modules/inventory/README.md`.
- `inventoryClass.ts` — **the one inventory class map**: category → cost class (`food` 1210/5010, `beverage` "drinks" 1220/5020, `packaging` 1230/5030). `INVENTORY_CATEGORIES`, `costClassOf`, `CLASS_ACCOUNTS`, `CLASS_LABEL`, `zeroByClass`. Never keep a second map.
- `recipeCost.ts` — recipe costing and **what a sale consumes**: `consumptionPerLine` / `consumptionForSoldLines`, `menuItemPlateCosts`, and **`packagingApplies(order, line, concept?)`** — the owner's final packaging rule (takeaway/delivery → yes; a packaging-vessel brand → yes; dine-in at a plate brand → only after "Box given"). The Q factor (`qFactorPct`) is a pricing allowance only. `markBoxGiven` is re-exported from `modules/orders/stock.ts`.
- `brandShare.ts` — the one rule for charging a brand-less stock amount to brands (H20): recipe use over the last 30 days, stored on the movements; nobody used it → head office. `splitCents` is largest-remainder.
- `withholding.ts` — **the one income-tax-withholding resolver** (s.153/s.155, H8/H28): the four sections, the company's filer/non-filer rates (CA placeholders until saved; max 50 %), `computeWithholding` (supplier filer status, exemption certificate valid on the day, `needsAtlCheck`), `defaultSectionForCapex`. The only writer of the rates is `PUT /accounting/withholding/rates`.
- `chartOfAccounts.ts` — the canonical chart (`CHART_OF_ACCOUNTS`), `REQUIRED_ACCOUNT_CODES` (the posting engine cannot run without them), `ensureChartOfAccounts` (adds only missing codes), `assertTemplateAccounts` (422 `ACCOUNT_CODE_TAKEN` / `ACCOUNT_INACTIVE` / `ACCOUNT_NOT_FOUND` before a posting family that uses newer codes) and `REGISTER_CONTROLLED_CODES` (1500–1599, 2012). Reserved ranges are documented in its header.
- `bankAccounts.ts` — bank accounts ↔ the chart. **`moneyAccountCode(db, tenantId, { method, bankAccountId })` is the answer for every non-till payment** (cash → 1010, card → 1030, bank → the named live linked bank of the *source document's* company; none named → the only bank, 1020 if none, 422 `BANK_ACCOUNT_REQUIRED` if two or more); `bankLedgerCode` is strict; `ledgerBalancesByCode(tenantId, codes, { asOf })`.
- `exceptions.ts` — `flagException` / `kindsMatching` and every `ExceptionKind` (the Finance → Exceptions inbox). A new flag kind is added here **and** to the admin label list.
- `evidenceFile.ts` — `decodeEvidenceFile` / `sendEvidence`: base64 evidence stored as bytes (JPEG/PNG/WebP, PDF where allowed, magic bytes checked, 3 MB default). Used by cash-request receipts, petty-cash receipts and bad-debt evidence.
- `savepoint.ts` — `withSavepoint`: a secondary write (an outbox row, a stock or posting side-write) behind a SAVEPOINT so its failure never aborts the main transaction; the caller flags the failure.
- `companyPairs.ts` — `assertBothSidesOwned` / `isMemberOfBoth`: the one membership check for anything that moves between two companies (inter-company transfers, shared-fleet rates, planning contributions). 403 `NOT_IN_BOTH_COMPANIES`.
- `tenders.ts` — the one tender list (Cash, Card – Keenu, Raast QR; `keenu_qr` retired and refused for new payments).
- `pricing.ts` — `priceOrder`: GST by tender rate, item tax classes, service charge, and the **delivery fee with its GST on top** (`deliveryFeeCents`, `deliveryFeeTaxCents`; the standard tender rate, never an item class); `deliveryFeeFor` (zone fee before GST). Never `concept.taxRate`.
- `orderRef.ts` — `orderRefOf`: the last 8 characters of the order id, uppercased — the one order reference everywhere.
