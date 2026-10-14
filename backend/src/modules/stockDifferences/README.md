# stockDifferences

Waste and stock-count differences waiting for the CEO (H20 — owner decision
2026-10-14: "suspense, CEO clears"). Registered at
`/accounting/stock-differences` (under the accounting module gate).

Stock leaves the shelves at once (lots move when the waste or count is saved);
the COST waits in **1290 Stock Differences Suspense** with its reason until the
CEO approves it into cost of sales.

## Where differences come from

`accounting/inventoryPosting.ts` `stockDifferenceAccount()` is THE switch
point ("suspense or straight to cost", suspense for every company):

| kind | entry | on 1290 | approved into |
|---|---|---|---|
| waste | `inventory.waste:<wasteLogId>` (KDS remake, prep, spot waste, transit loss) | Dr | 5040 Waste |
| void_waste | `pos.void_waste:<orderItemId>` (void / cancel after fire) | Dr | 5040 Waste |
| count | `inventory.count:<countId>` (spot count; opening counts go to 3010) | Dr short / Cr over | 5050 Inventory Variance |

The credit side of a loss is unchanged (12x0 by class, or 50x0 when the
order's cost of sales was already booked — the ORDER_COGS_FIX rule in
`postVoidWaste`). Each 1290 line keeps the brand split the posting made.

## Pending and cleared

A pending difference = one journal line on 1290 from those entries with no
clearing entry. There is no table: the clearing is the entry
`stock_difference.clear:<journalLineId>` in the line's company (idempotent).

- **Approve** (CEO, `admin`): per line, dated the approval day, in the line's
  company, both lines tagged with the line's brand — loss: Dr 5040/5050 / Cr
  1290; gain: Dr 1290 / Cr 5050. One company per call (422 `ONE_COMPANY`);
  foreign or unknown ids 404; already cleared lines are skipped, all of them
  already cleared is 409 `ALREADY_CLEARED`; the books closed through today is
  422 `PERIOD_LOCKED` (nothing cleared). A closed month is never touched.
- **Send back** (CEO): a note — an `accounting` audit row (action
  `stock_difference.query`, entity `JournalLine`) and a medium flag
  `stock_difference_queried`. The difference stays pending.

## Routes (`routes.ts`)

| Method | Path | Who | Scope |
|---|---|---|---|
| GET | `/` `?status=pending\|cleared&tenantId&from&to&cursor&limit` | FINANCIALS_VIEWERS | read |
| POST | `/approve` `{ lineIds[] }` | admin | write |
| POST | `/:lineId/query` `{ note }` (3–500) | admin | write |

Every response carries `canApprove`.

## Month-end close

`stockDifferenceCloseCheck` (key `stock_differences_pending`): a WARNING,
never a block, listing the value still waiting per month up to the lock.

Admin page: `/finance/stock-differences`. Approvals inbox type
`stock_difference` (CEO).
