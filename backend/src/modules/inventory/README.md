# inventory

Backend module: **inventory**. HTTP routes + business logic for the Inventory domain. Registered into Fastify by `src/index.ts` under the `/inventory` URL prefix.

Stock is **FIFO lots at the price paid** (finance wave B, H16). `lib/stockLedger.ts` is the ONE stock writer: nothing else writes `currentStock` (it is a cache of the lots), a lot, or a stock movement. See `docs/food-cost.md` for the people's version.

## Files

- `routes.ts` — Fastify route registrations (below).
- `fifoCutover.ts` — the one-time per-company cut-over (`ensureFifoCutover`, run at boot and lazily by `lib/stockLedger.ts ensureFifoReady` before a company's first lot write). One transaction under an advisory lock: one `fifo_cutover` lot per item with stock at its `unitCostCents`; receipt lines marked billed from the legacy bills (`billedQty`); billed-ahead quantity becomes a pending `GrniMatch`; `inventory.class_reclass` (drinks and packaging out of 1210) and `procurement.grni_opening` entries; the **pre-FIFO difference** per class stored in Setting `foodcost.preFifoDiff:<tenant>` (never posted; the CEO aligns it once with `postFifoAlign` → 3020); the marker `foodcost.fifoCutoverAt:<tenant>`. Step 0 (outside the transaction) is the former carried-variance catch-up: a refusal does not stop the cut-over, it is flagged `posting_failed` and kept in `foodcost.preFifoCatchupRefused:<tenant>`. Legacy bills the cut-over **ties** to receipt lines through their PO are kept in `foodcost.cutoverTies:<tenant>` (a void of the bill re-opens exactly those); what it could **not tie** (a bill naming no PO, a PO billed ahead of its goods) is kept in `foodcost.cutoverUntied:<tenant>` and one `fifo_cutover_review` flag lists it for the accountant. Items with no company are never given lots (`companyLessStockItems()`, `/health`, the Unassigned worklist).
- `cashPurchase.ts` — `recordCashPurchaseStockTx`: food bought with cash (a petty-cash spend or a cash-request settlement) comes in as a **settled receipt** from the company's system supplier "Cash purchases" (lines born billed, unique per cash document, 409 `ALREADY_RECEIVED` on a repeat). It posts **nothing**: the cash document's own entry carries Dr 12x0 / Cr its cash account. The caller calls `ensureFifoReady` first and restricts stock lines to stock keepers.
- `voidWaste.ts` — waste of a SOLD line: `wasteSoldLineTx` relabels the line's sale rows to `sale_void` + `waste` (stock does not move, the food is gone either way), one WasteLog per item at its FIFO value, and `pos.void_waste:<orderItemId>` Dr 5040 / Cr the class inventory in the order's company. `VOID_WASTE_REASONS` = `void_after_fire`, `cancelled_after_fire`, `returned_food` (the last is reserved: nothing writes it in this release).

## Routes

- `GET /` and `GET /:id` — stock readers plus finance; `onHandValueCents` only for finance viewers and managers; `costSource` is `deliveries` once the item has lots or deliveries, else `opening`.
- `POST /` and `PATCH /:id` — `category` must be one of `INVENTORY_CATEGORIES` (400). A category change that **crosses cost classes** moves the item's lot value and posts `inventory.item_reclass:<item>:<audit>` in the same transaction (a refusal rolls the edit back). The category is re-read under the item lock; each extra cost class moved gets its own key (`<audit>:<class>`), and the route checks the ledger booked every class that moved (409 `RECLASS_NOT_POSTED` otherwise). `unitCostCents` edits are 422 `COST_FROM_DELIVERIES` once the item has lots or deliveries. `issueOnReceipt` is set only by managers who hold the inventory module (audited). Assigning a company to an item **with stock** (the Unassigned worklist) needs an opening-count role (403 `OPENING_COUNT_ROLE`) and records one **opening count** in the same transaction (`{ tenantId, unitCostCents }`).
- `POST /:id/waste` — `{ quantity, unit, reason: spoilage | over_prep | expired | damaged | other, photoUrl?, notes?, conceptId?, locationId? }`. Drawn FIFO as `waste` (422 `NEGATIVE_STOCK`); the photo rule is on the FIFO value; a brand outside the active company is 404, a brand of another company than the item's is 422 `BRAND_NOT_IN_COMPANY`; an outlet of another company 422 `LOCATION_NOT_IN_COMPANY`. Posts `inventory.waste:<wasteLogId>` Dr 1290 (H20 suspense; the CEO approves it into 5040).
- `GET /waste-analytics` — managers plus finance, scoped to the waste log's company; a line cook stays 403.
- `GET /unassigned` — items with no company, now open to finance too.

Counts, prep batches and transfers live in other modules but write through the same ledger: `crosschecks/routes.ts` (`POST /crosschecks/physical-counts` spot or opening, `GET …/suggested`, `GET …/capabilities`; `POST /crosschecks/prep-batches`; `POST /crosschecks/receiving`) and `stockTransfers/routes.ts` (`PATCH /:id/receive` books a shortfall as `transit_loss` waste, 422 `SHORTFALL_REASON_REQUIRED` / `OVER_RECEIVED`).

## Postings (company from the source document, all in `accounting/inventoryPosting.ts`)

| Source | Entry |
|---|---|
| `procurement.receipt:<receiptId>` | Dr 1210/1220/1230 / Cr 2015 (a cash-settled receipt posts nothing) |
| `inventory.count:<countId>` | spot short Dr **1290** / Cr 12x0, over the reverse (H20: the CEO approves 1290 into 5050 on Finance → Stock differences); **opening count Dr 12x0 / Cr 3010 Owner's Capital** (H19; the one-off alignment stays on 3020) |
| `inventory.waste:<wasteLogId>` | Dr 1290 / Cr 12x0 at the FIFO value (staff waste and transfer transit loss); the CEO's approval moves it to 5040 |
| `inventory.prep_draw:<batchId>` | Dr cost of sales / Cr 12x0 per class (ad-hoc batch only) |
| `inventory.item_reclass:<item>:<audit>` | Dr new class inventory / Cr old |
| `pos.void_waste:<orderItemId>` | Dr 1290 / Cr 12x0 (or Cr 50x0 when the order's cost was already booked) for a fired line voided or cancelled; the CEO's approval moves it to 5040 |
| `inventory.fifo_align:<tenant>` | the CEO's one-off alignment to 3020 |

H20 (waste and count differences wait in 1290 until the CEO approves them) changes only `postWasteLog` and `postStockCount`; every waste and count-difference entry already goes through those two, nothing debits 5040 or 5050 directly.

## Rules

- **Every stock write**: `ensureFifoReady(tenantId)` BEFORE opening the transaction; items locked in id order (`lockItemsTx`); the posting behind a savepoint (`postInventoryDocInSavepoint`); a refused posting is flagged `posting_failed` after commit with `metadata.documentDate`, and a re-poster exists. The response carries `ledger { posted, entryId?, reason?, error? }`.
- **Company**: an item with no company is refused on every write (422 `ITEM_HAS_NO_COMPANY`); a lot, its item and the caller must be one company (500 `CROSS_COMPANY_STOCK` otherwise).
- **Self-check**: before a write `currentStock` must equal the sum of the lots (500 `STOCK_NOT_ON_LOTS` → the cut-over has not run, or something wrote `currentStock` directly).
- **A sale never fails for lack of stock**: the shortfall is costed as a memo at the latest purchase price, flagged `stock_shortfall` (nightly), and settled by a receipt within 7 days (`SHORTFALL_SETTLE_DAYS`).
- **An order's cost of sales is booked ONCE** (its `order.complete`, or a till order's home `shift.close` — `accounting/cogs.ts orderCostBookedAt`). A stock event on the order after that books its own COGS entry — see `modules/orders/README.md` (`ORDER_COGS_FIX`).
- **Counts**: a line that differs from the books needs a reason of 3+ characters (422 `COUNT_REASON_REQUIRED`); an opening count only for an item with no lot and no lot-carrying movement — a lot-less sale shortfall does NOT block it (422 `OPENING_NOT_ALLOWED`), at the line's cost, else the latest purchase price, else the estimate (422 `OPENING_COST_REQUIRED`); opening counts are run by admin, owner, management or finance only (403 `OPENING_COUNT_ROLE`).
- **Brand-less amounts** are split across brands by recipe use over the last 30 days (`lib/brandShare.ts`, H20), stored on the movements; nobody used it → head office.
