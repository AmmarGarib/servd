# Fixed assets (v2, wave B) — the contract

The ONE fixed-asset register of servd (`FixedAsset` + `FixedAssetDepreciation`
+ `FixedAssetEvent`), per company. Owner rules (2026-10-13): depreciation is
**automatic** every month (no switch, no threshold); smallwares are pooled per
outlet / brand / type, big items are individual; disposals, scraps and
write-downs — finance requests, the CEO approves (the F&B manager does not).
Bought equipment reaches the register through CapEx (Finance → Project
tracker, or Quick buy). **Existing assets (owner, 2026-10-21 — REVERSES the
old "no opening / pre-servd assets" rule):** "It only showing buy equipment,
give an option to add asset also, so we can add previously bought /
Transferred from related party assets" — see "Add existing asset" below.

## Add existing asset (owner, 2026-10-21)

`POST /accounting/fixed-assets/existing` (FA_WRITER_ROLES; admin page:
Register → "Add existing asset") raises a request of kind **`add_existing`**
on the ONE request queue (events.ts) in the ACTIVE company (create mode). It
is a new request KIND, not a new source on `capitalise`: a capitalisation is
keyed on its CapEx line (`capexLineId`, the pending-capitalise unique index,
advances on 1340, the void-the-line-group rule) and an existing asset has no
line; a kind keeps the same queue, the same `applyEvent` / `rejectEvent`, the
same `fixed_asset_request` approval type and bell, and the same posting key.

| field | rule |
|---|---|
| `source` | `pre_servd` (bought before servd) or `related_party` |
| `counterparty` | related party only: `garibsons`, `servd_company`, `owners` |
| `counterpartyTenantId` | `servd_company` only — another company the caller belongs to (else 422 `COUNTERPARTY_NOT_YOURS`) |
| `classId` | an active, NON-pooled class of the active company (another company's 422 `ASSET_CLASS_NOT_IN_COMPANY`; smallwares 422 `POOLED_CLASS_NOT_ALLOWED` — pools come through Quick buy) |
| `name`, `serial?` | the item |
| `conceptId` / `locationId` | of the active company (422 `CONCEPT_NOT_IN_COMPANY` / `LOCATION_NOT_IN_COMPANY`); shared needs an outlet (422 `LOCATION_REQUIRED_FOR_SHARED`) |
| `valueCents` | TODAY'S value (book value) > 0 — the register's cost from now on; no original cost, no carried accumulated |
| `inServiceDate` | the day it starts on this company's books; not in the future (422 `IN_SERVICE_DATE`), not in a closed month (422 `PERIOD_LOCKED`) |
| `remainingLifeMonths` | 1 … class life × 2 (422 `REMAINING_LIFE`), default the class life; land: not depreciated |
| `salvageCents?` | below the value (422 `SALVAGE_TOO_HIGH`) |
| `reason` | ≥ 10 characters |

Finance's request waits for the CEO (202); the CEO's own applies at once
(201), like every fixed-asset request. **Nothing is booked before approval;
a rejection books nothing.** On approval (one transaction) the asset is made
in the request's company and ONE entry posts:

| where it came from | `fixed_asset.acquire:<assetId>` |
|---|---|
| bought before servd | Dr class cost / Cr **3010** Owner's capital (as opening stock H19, supplier opening balances H49) |
| Garibsons paid for it | Dr class cost / Cr **2210** Due to Garibsons (the petty-cash code, H1) |
| the owners contributed it | Dr class cost / Cr **3010** |
| another servd company gave it | **not built** — 422 `RELATED_COMPANY_NOT_YET` (owner question below) |

The entry is dated the in-service date and is **never late-dated**: if the
month was closed while the request waited, the books refuse it
(`PERIOD_LOCKED`), the request stays pending with the reason, and the close
check `existing_asset_pending` (warn) lists such requests before a close.
A reopened month is the CEO's (closedBooks.ts) — the CEO is the one posting.
`FixedAsset.acquisitionCreditCode` records 3010 / 2210; the initial allowance
starts unticked (a used asset; finance may tick it). Depreciation then runs
through `chargeThrough` from the in-service month over the remaining life
(first month = value ÷ remaining months). A void reverses the acquire entry
like any other.

**Documents** ride the record-files provider `fixed_asset`: while the request
is pending the files are attached to the REQUEST id
(`/record-files/fixed_asset/<requestId>`), and on approval they move to the
asset in the same transaction. No URL fields.

**Open owner question (another servd company):** the receiving side is the
inter-company engine (pair accounts, an `ic.*` transfer), but the GIVING
company's side needs a decision: if the asset is on the giver's register, at
what value does it leave (its NBV, or the agreed today's value?) and where
does a difference go (gain / loss 8030 in the giver, or nothing — transfer at
NBV)? If it is NOT on the giver's register, what does the giver credit for
the amount owed to it (other income, or owner's capital)? There is no
cross-company asset transfer today (transfers are outlet / brand within one
company), and the register's accounts (`fixed_asset.*`) and the pair accounts
(`ic.*`) are controlled by different source prefixes, so this is a new
cross-company event either way.

## Files

| File | What it is |
|---|---|
| `classes.ts` | THE class list (`ASSET_CLASS_DEFAULTS`, seeded per company by `ensureAssetClasses`), `SMALLWARE_TYPES`, the company policy (`getFixedAssetPolicy`), the equipment guard (`assertNotEquipmentLine`) |
| `schedule.ts` | pure maths in PKT months: `planCharges`, `forecast`, `nextMonthlyCharge`, `nbvAt` |
| `service.ts` | the engine: **`chargeThrough` — the one depreciation path**, `chargeAssetThrough` (re-poster), `postAcquisition`, `reclassLegacyAccumulated`, `nextAssetTag` |
| `events.ts` | requests and their postings: `createRequest`, `applyEvent`, `rejectEvent`, `cancelEvent` |
| `pools.ts` | smallwares pools and FIFO layers |
| `tax.ts` | ITO Third Schedule tax depreciation (H23) and the CEO's freeze of a tax year |
| `closeCheck.ts` | the period-close items (`depreciation` block, `capitalisation_pending` warn) and `chargeForClose` |
| `routes.ts` | `/accounting/fixed-assets` — the register, lookups, runs, classes, policy, "charge now" |
| `requests.ts` | requests on an asset, the queue, the CEO's approve / reject, cancel |
| `pools.routes.ts` | smallwares pools, write-off / transfer-units requests, counts |
| `reports.ts` | schedule, roll-forward, NBV at a date, tie-out, 1340 advances, tax; `fixedAssetTieOut` |
| `../../workers/depreciation.ts` | the nightly run (03:20 PKT) |

## Depreciation — `chargeThrough` is the one path

Straight line, full-month convention (the in-service month is charged, the
disposal month is not), each month = remaining depreciable ÷ remaining
uncharged months, the last month takes the remainder — the lifetime total is
exactly cost − salvage. Months are charged strictly in order.

Everything that charges goes through `chargeThrough` / `chargeAssetTx`:
the worker, `POST /accounting/fixed-assets/depreciate` ("charge now / catch
up", the ACTIVE company only, completed months only — 422 `MONTH_NOT_ENDED`,
400 `BAD_PERIOD`, 409 `RUN_IN_PROGRESS`), the period close (`chargeForClose`),
the backfill re-poster (`chargeAssetThrough`) and every event that needs the
months before it charged first. Each run writes a `FixedAssetRun` row.

The worker (`startDepreciationWorker`, node-cron `20 3 * * *`
Asia/Karachi, in-process running guard, `serviceClient`) loops every company
(`deletedAt` null): classes + the legacy 1590 reclass → `chargeThrough` the
last completed PKT month → `releasePrepaidThrough` the same month → flags
(de-duplicated: one open flag per kind and row) `capex_uncapitalised`,
`capex_advance_overdue`, `capex_orphan_advance`, `capex_prepaid_unscheduled`
(legacy rows only), `fixed_asset_gl_mismatch` (register vs ledger on CURRENT
balances only) and `depreciation_failed` → `FixedAssetRun` rows
`depreciation`, `prepaid_release`, `checks`.

## Events — who raises, who approves

| kind | raised by | approval | posting (company = the asset's / pool's) |
|---|---|---|---|
| capitalise | finance (CapEx) | CEO | `fixed_asset.acquire:<assetId>` per asset |
| disposal (sale / scrap / lost / stolen) | finance | CEO | `fixed_asset.dispose:<assetId>` |
| undispose | finance | CEO | reversal of the disposal, then catch-up charges |
| impairment (write-down) | finance | CEO | `fixed_asset.impairment:<eventId>` Dr 6155 / Cr accumulated |
| change_estimate | finance | CEO | none (prospective life / salvage) |
| void (capitalised in error) | finance | CEO | reversals of acquire + months + impairments |
| pool_write_off | finance | CEO | `fixed_asset.pool_write_off:<eventId>` (FIFO layers) |
| transfer (outlet / brand) | finance | none — at once | `fixed_asset.transfer:<eventId>` when the brand changes |
| pool_transfer (units) | finance | none — at once | `fixed_asset.transfer:<eventId>` when the brand changes |
| count | finance / F&B manager | none — at once | none (counted vs on hand) |
| add_existing | finance | CEO | `fixed_asset.acquire:<assetId>` Dr class cost / Cr 3010 or 2210 |

"Finance" = `FA_WRITER_ROLES` (admin, owner, management, finance); the
approver is the CEO (role `admin`) only. A request answers **202** (pending)
for everyone but the CEO, whose own request applies at once (**201**). The
approvals inbox reads `GET /accounting/fixed-assets/requests?status=pending`
(type `fixed_asset_request`) and its buttons call
`POST /requests/:id/approve` / `reject {note}` — never a second approval
engine. An approval runs in ONE transaction; a refusal rolls it back, keeps
the reason on the request (`errorMessage`) and leaves it pending.

### Money received and where shared equipment is (owner, 2026-10-14)

- **Asset-sale proceeds** (a `disposal` with `proceedsCents > 0`, raised on
  `POST /:id/requests` or `POST /:id/dispose`): `payload.method` is one of
  `DISPOSAL_METHODS` — the receipt list of `lib/bankAccounts.ts`
  (`cash`, `card`, `bank_transfer`, `bank_deposit`, `cheque`) plus the old
  `bank` / `online` a request raised earlier may carry — and
  `payload.reference`, the payment reference #, is **required on every
  method, cash included** (422 `PAYMENT_REFERENCE_REQUIRED`). It is checked
  when the request is RAISED, never when the CEO approves (a pending request
  raised before the rule has none and still approves). The money account is
  `moneyAccountCode` of the asset's company; the entry's description and the
  money line's memo carry `receiptText` ("bank deposit, ref 4471"). A
  reference this company used before answers `referenceUsedBefore`
  (`lib/paymentRefs.ts`, kind `asset_disposal`) — a warning, never a block.
- **Shared equipment needs its location.** An asset with no brand (shared
  across brands) and no outlet is refused when the request is raised — 422
  `LOCATION_REQUIRED_FOR_SHARED`: a `capitalise` (the payload's `conceptId`
  for an individual asset — omitted = the project's brand, null = shared —
  and `locationId`, omitted = the project's outlet, which counts) and a
  `transfer` that would leave the asset shared with no outlet. A pending
  capitalisation approves as before. Pooled smallwares always need an outlet
  (`POOL_NEEDS_LOCATION`). The rule lives in `events.ts`
  (`assertSharedHasLocation`, `capitaliseTarget`), used by
  `financePlanning/capexPosting.ts checkCapitalisable` too.

## Postings and the late-dating rule

| key | lines |
|---|---|
| `fixed_asset.acquire:<assetId>` | Dr class cost (+ Dr input tax 132x) / Cr 1340 advanced, Cr 2012 still owed; an existing asset: Dr class cost / Cr 3010 or 2210, dated the in-service date, never late |
| `fixed_asset.depreciation:<assetId>:<YYYY-MM>` | Dr 6150 / Cr the class's accumulated code (1591–1599), both on the brand charged that month (revisions `@n`) |
| `fixed_asset.dispose:<assetId>` | Dr accumulated (per code) + Dr money (`moneyAccountCode`; memo "Disposal proceeds (bank deposit, ref …)") / Cr cost, gain Cr / loss Dr 8030 |
| `fixed_asset.impairment:<eventId>` | Dr 6155 / Cr accumulated |
| `fixed_asset.pool_write_off:<eventId>` | Dr accumulated + Dr 8030 (NBV lost) / Cr 1560 |
| `fixed_asset.transfer:<eventId>` | cost and accumulated moved brand to brand (zero net per code) |
| `fixed_asset.acc_dep_reclass:<tenantId>` | Dr 1590 / Cr 159x — the one-off H27 move of legacy accumulated |

Owner decision 6: a system / approval posting whose natural date is inside a
closed month posts into the open month TODAY with a note naming the original
date (`journal.ts lateDatingFor`), under the same reference;
`FixedAssetDepreciation.postedPeriod` records where a late month landed.
Nothing is refused for a closed month and nothing lands inside a lock; with
the books closed through today, 409 `BOOKS_CLOSED_TODAY` and the worker
retries the next night. The register's accounts (1500–1599, 2012) are
controlled: only `fixed_asset.*` / `capex.*` postings reach them; any other
source needs `controlledOverride` (reason ≥ 10) and is then caught by the
tie-out and the nightly `fixed_asset_gl_mismatch` flag.

## CapEx link

`FixedAsset.capexLineId` (+ `capexLineUnit`: 0 for a single unit or a pool
layer, 1..N for a line split into N ≥ 2 assets) is THE link to the CapEx line
— the old `capex-line:` notes prefix is never read. A line of N units of a
non-pooled class becomes N individual assets with their own tags (≤ 200); a
pooled class becomes one layer of its pool with a quantity.
`POST /accounting/fixed-assets` answers 422 `USE_CAPEX`; equipment that did
not come through CapEx uses `POST /existing` (above).

## Class → account map (H22 lives, H23 tax, H27 accumulated per class)

| class | cost | accumulated | life | tax rate | initial allowance |
|---|---|---|---|---|---|
| kitchen_equipment | 1510 | 1591 | 60 | 15% | 25% |
| furniture_fixtures | 1520 | 1592 | 84 | 15% | 0 |
| it_equipment | 1530 | 1593 | 36 | 30% | 0 (ticked per asset) |
| vehicles | 1540 | 1594 | 60 | 15% | 0 |
| leasehold | 1550 | 1595 | 120 (or the lease end) | 10% | 0 |
| buildings | 1505 | 1596 | 240 | 10% | 0 |
| power_equipment | 1515 | 1597 | 84 | 15% | 25% |
| office_equipment | 1525 | 1598 | 60 | 15% | 0 (ticked per asset) |
| smallwares (pooled) | 1560 | 1599 | 24 | 100% in the year bought (H35) | — |
| land | 1500 | — | not depreciated | 0 | 0 |

**Initial allowance is per asset (Hasnain H42, 2026-10-16).**
`FixedAsset.initialAllowanceEligible` decides it in the tax view
(`tax.ts initialAllowanceBpOf`): ticked → the class's initial-allowance rate,
or the statutory 25% when the class carries 0; unticked → 0. It starts ticked
for kitchen_equipment and power_equipment and unticked for every other class
(capitalisation, and the backfill in migration
`20261017090000_fa_initial_allowance_flag`; a NULL row reads as that rule).
Finance or the CEO changes it with `PUT /:id/initial-allowance {eligible,
reason?}` (audit `fixed_asset.initial_allowance`; PATCH refuses the field).
Tax view only — the books never read it. The allowance falls in the asset's
first tax year and carries through the WDV of every later one, so once the
company has frozen that year OR any later year the tick is final (409
`TAX_YEAR_FROZEN`; `GET /:id` reports it as `tax.initialAllowance
{applicable, frozenTaxYear}`, which the admin checkbox reads); re-sending the
tick an asset already has is a 200 no-op; smallwares, land, voided assets and split-off layers are
422 `INITIAL_ALLOWANCE_NOT_APPLICABLE`.

Codes are fixed per key (`PATCH /classes/:id` refuses them); the CEO may edit
the label, default life, tax rates, pooled (only while the class has no
assets) and active. 1590 is "Accumulated Depreciation (legacy)", emptied by
the reclass; any residue shows on the tie-out.

## Reports

`/reports/schedule`, `/reports/nbv` are economic (a month counts once it has
ended; brand and outlet as of the date from transfer events);
`/reports/roll-forward` and `/reports/tie-out` date every register movement
the way it hit the books (a late month by its `postedPeriod`, an acquisition
by its entry's date) and set the ledger beside it per class code. `format=csv`
answers exactly the JSON `rows`. Tax (`/reports/tax`, freeze) is per ACTIVE
company. **Accountant answers (2026-10-14):** H24 — no deferred-tax figure is
needed, so there is no deferred-tax report; H23 — the Third-Schedule rates do
not cover smallwares, so pooled classes are left out of the tax schedule and
listed as "tax treatment to confirm".

## Open owner question

**Every capitalisation goes to the CEO** (smallwares Quick buys included).
This keeps today's CEO-only capitalise control, but the owner's decision named
only disposals, scraps and write-downs; delayed approvals push depreciation
into later months (it catches up from the in-service month, late-dated). The
default built: every capitalisation waits for the CEO.
