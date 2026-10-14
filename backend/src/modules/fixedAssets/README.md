# Fixed assets (v2, wave B) — the contract

The ONE fixed-asset register of servd (`FixedAsset` + `FixedAssetDepreciation`
+ `FixedAssetEvent`), per company. Owner rules (2026-10-13): depreciation is
**automatic** every month (no switch, no threshold); smallwares are pooled per
outlet / brand / type, big items are individual; disposals, scraps and
write-downs — finance requests, the CEO approves (the F&B manager does not);
no opening / pre-servd assets; equipment reaches the register **only through
CapEx** (Finance → Project tracker, or Quick buy).

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

"Finance" = `FA_WRITER_ROLES` (admin, owner, management, finance); the
approver is the CEO (role `admin`) only. A request answers **202** (pending)
for everyone but the CEO, whose own request applies at once (**201**). The
approvals inbox reads `GET /accounting/fixed-assets/requests?status=pending`
(type `fixed_asset_request`) and its buttons call
`POST /requests/:id/approve` / `reject {note}` — never a second approval
engine. An approval runs in ONE transaction; a refusal rolls it back, keeps
the reason on the request (`errorMessage`) and leaves it pending.

## Postings and the late-dating rule

| key | lines |
|---|---|
| `fixed_asset.acquire:<assetId>` | Dr class cost (+ Dr input tax 132x) / Cr 1340 advanced, Cr 2012 still owed |
| `fixed_asset.depreciation:<assetId>:<YYYY-MM>` | Dr 6150 / Cr the class's accumulated code (1591–1599), both on the brand charged that month (revisions `@n`) |
| `fixed_asset.dispose:<assetId>` | Dr accumulated (per code) + Dr money (`moneyAccountCode`) / Cr cost, gain Cr / loss Dr 8030 |
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
`POST /accounting/fixed-assets` answers 422 `USE_CAPEX`.

## Class → account map (H22 lives, H23 tax, H27 accumulated per class)

| class | cost | accumulated | life | tax rate | initial allowance |
|---|---|---|---|---|---|
| kitchen_equipment | 1510 | 1591 | 60 | 15% | 25% |
| furniture_fixtures | 1520 | 1592 | 84 | 15% | 0 |
| it_equipment | 1530 | 1593 | 36 | 30% | 25% |
| vehicles | 1540 | 1594 | 60 | 15% | 0 |
| leasehold | 1550 | 1595 | 120 (or the lease end) | 10% | 0 |
| buildings | 1505 | 1596 | 240 | 10% | 0 |
| power_equipment | 1515 | 1597 | 84 | 15% | 25% |
| office_equipment | 1525 | 1598 | 60 | 15% | 25% |
| smallwares (pooled) | 1560 | 1599 | 24 | — (to confirm, H23) | — |
| land | 1500 | — | not depreciated | 0 | 0 |

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
