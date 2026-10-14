# Food cost, stock and packaging — guide for the CEO, finance, the F&B manager and chefs

Dated 2026-10-14. servd now costs food **at the price actually paid for the
stock that was cooked**, in real time, split into **food, drinks and
packaging**. This page says how stock comes in, what a sale takes out, how
waste and counts are handled, and how to read **Reports -> Food cost
variance**.

## The idea

- Every delivery opens a **lot**: this much of this item, bought at this
  price, on this day. Lots are used **oldest first (FIFO, H16)**. A dish sold
  today is costed at the price of the lots it really used, not at an average.
- Every lot has a cost class: **food**, **drinks** (the `beverage` class) or
  **packaging**. Each class has its own stock account (1210, 1220, 1230) and
  its own cost-of-sales account (5010, 5020, 5030).
- Stock is **per company**. A company's dishes use only that company's items.
  Per-outlet stock (what each kitchen holds) is the **next build**: servd
  already tags every stock movement with the outlet, but the report cannot
  show an outlet's actual cost yet.

## 1. Stock comes in through receiving (and is booked on arrival)

All stock comes in through **one path**: Procurement -> **Receiving** (the
dock page) or receiving against a purchase order. Who may receive: the manager
tiers. **Whoever raised the purchase order cannot receive it** (the CEO may).
A delivery without a PO is allowed (a market run) but the **unit cost must be
typed at the dock**, because there is no PO price.

When a receipt is saved, servd, in one step:

1. opens the lot(s) at the PO price (or the price typed at the dock);
2. books **Dr stock (1210 / 1220 / 1230) / Cr 2015 "Goods received, not
   invoiced" (GRNI)** (H17) - the goods are on the books the day they arrive,
   and the debt to the supplier waits on 2015 until the bill clears it;
3. records the price in the item's price history.

### The supplier's bill clears it

Enter the bill in Procurement. Each **stock line on a bill links to its receipt
line** (use **Fill from receipt**). Booking the bill moves the amount from 2015
to the supplier (Dr 2015 / Cr 2010 payable). Rules servd enforces:

- A stock line must name the receipt line it bills (`STOCK_LINE_NEEDS_RECEIPT`)
  and cannot bill more than arrived (`OVER_BILLED`).
- A non-stock line (cleaning, a service) must name its **expense account**
  (`EXPENSE_ACCOUNT_REQUIRED`).
- **Equipment is not billed.** A bill line that looks like equipment is refused
  (`USE_CAPEX`): buy it through CapEx or Quick buy (see
  `docs/fixed-assets.md`).
- If the **bill comes before the goods**, the billed quantity is held as a
  pending match; when the goods arrive their lot is opened at the **billed**
  price.
- If the **bill price differs** from the receipt price, the lot is re-priced:
  the part still on the shelf adjusts the stock value; the part already used
  goes to **5060 price adjustments** (split across brands by what each used).
  Credit notes and returns work the same way in reverse.
- Income tax withheld from the supplier (s.153) comes off the payment to the
  supplier, at the supplier's filer rate; see `docs/TAX_SETUP.md`.

### "Received, not billed" (Procurement)

**Procurement -> Received, not billed** lists every receipt line still waiting
for a bill: quantity, value, age, and lines older than **30 days** marked
stale. If the supplier will never bill a line (a gift, a mistake), finance
asks for a **write-off** with a reason; **only the CEO approves** (Dr 2015 /
Cr 5060). The month-end check "Received, not billed" warns while stale lines
exist.

## 2. Food bought for cash goes through receiving too

Buying food with **petty cash** or with a **cash request** also comes in as a
receipt, not as an expense. On the cash request's receipts, or on a petty-cash
spend, add a **Stock item** line (the item, quantity, unit, amount). servd
makes a *settled* receipt from the system supplier "Cash purchases" (never
listed, never billed), opens the lot, and the cash document's own entry books
**Dr 12x0 stock / Cr the cash account**. Only stock keepers may add stock lines
(`STOCK_LINES_NOT_ALLOWED` otherwise). A cash request cannot be raised under a
kitchen food category - the food goes on the stock line when the receipts come
in. (`kitchen_food`, `kitchen_drinks` and `kitchen_packaging` exist only for
reading old petty-cash history.)

## 3. What a sale takes out of stock

The dish's **recipe** says what a portion uses: ingredients, sub-recipes, and
the recipe of each **add-on** the guest picked (extra cheese uses its own
add-on recipe; "no cheese" is a negative line on the add-on recipe).

A sale takes stock out when the **order is created** (so the auto-86 sees it),
and servd checks again before the order's cost is booked. If a sale needs more
than the lots hold (stock was not received yet), the sale **never fails**: the
shortfall is costed at the item's latest purchase price as a memo, a
**`stock_shortfall` flag** is raised that night, and when the delivery arrives
(up to 7 days after the sale) it **settles** the shortfall.

### The packaging rule (owner, 2026-10-13 - final)

Every finished dish recipe has an **optional Packaging section** (all brands,
plated ones too). Whether a sale actually **uses** its packaging depends on the
order and the brand:

| The order | Uses the dish's packaging? |
|---|---|
| Takeaway or delivery (till, storefront, rider, WhatsApp pickup) | **Yes**, always |
| Dine-in at a brand whose **service vessel is "packaging"** (Stackd - packaging IS the vessel) | **Yes**, always |
| Dine-in at a **plate** brand (Simmer, Flipd) | **Only if staff tapped "Box given"** on that line (leftovers boxed) |

- A brand's **service vessel** (plate or packaging) is a **required choice
  when the brand is created** and can be changed in **Marketing -> Brands**.
  A change applies from then on: each order line keeps the vessel it was
  rung up with, so past cost is never restated.
- **Box given** is a button on the till cart, the admin order page and the
  kitchen/expo screen, on dine-in lines of plate brands. Any staff of the
  order's company can tap it; it is audited. It takes the packaging out of
  stock (oldest lot first) and adds it to the line's cost. **Undo** is allowed
  until the order completes. A tap after completion is allowed (a boxed
  leftover often comes after payment); its cost is booked by its own entry.
  On a takeaway, delivery or Stackd line the button answers `BOX_NOT_NEEDED`.
- A recipe **needs no packaging lines** to be approved (a plate brand that only
  serves dine-in is valid). A recipe at a packaging-vessel brand **without**
  packaging lines gets a **warning** on the recipe and in the report - not a
  block.
- **Packaging items go only in the Packaging section**, food and drinks only in
  Ingredients; sub-recipes, add-ons and component recipes carry no Packaging
  section.
- **Material cost (MC)** has two figures:
  - **Target MC** = food + drinks + packaging *if it applies to that order
    type* (shown for dine-in, takeaway and delivery);
  - **Actual MC** = food + drinks + packaging actually used.
  The report shows MC **by order type** and **by brand**.
- **The Q factor** (`Recipe.qFactorPct`, default 10%) is the *only* pricing
  allowance: a cost uplift for salt, oil and the wear of plates (H18). It is
  used for **pricing and theoretical cost only**. It is never taken out of
  stock and never posted; plate wear reaches the books through smallwares
  depreciation. It applies to the ingredient lines, not to Packaging. The
  report labels it "in menu pricing, not stock".

### Cancels, voids and remakes

- An **unfired** line voided or an order cancelled goes **back into the very
  lots it came from**.
- A **fired** line (already in the kitchen) is **wasted**: the stock stays gone
  and the cost is booked as waste (Dr 5040), with reason "voided after firing"
  or "cancelled after firing". A manager must approve every void of a rung-up
  order (their own login or a same-company manager PIN).
- A **remake** on the kitchen screen books the dish's ingredients and add-ons
  again as waste ("remake"). Packaging is not remade.
- An order's cost of sales is booked **once**, when it completes (or, for a
  till order, when its home drawer closes). A stock event after that - a late
  give-back, a Box given, a late draw - books its **own small entry** (Dr
  12x0 / Cr 50x0, or the reverse) so the cost of sales stays right.

## 4. Waste, remakes and prep

- **Waste log** (Inventory, any kitchen login that logs waste): item,
  quantity, unit, **reason** (spoilage, over-prep, expired, damaged, other),
  optional brand and outlet, notes. It is costed from the lots (FIFO) and
  booked **Dr 5040 / Cr the stock account**. Above the company's photo
  threshold (default PKR 500) a **photo is required**; a line cook is told a
  photo is needed but not what the item cost. Waste cannot take stock below
  zero.
- **Goods lost in a transfer** between outlets: the receiver types what
  arrived and a reason (at least 3 characters); the difference is booked as
  waste "lost in transfer". Receiving more than was sent is refused.
- **Prep batches**: a sub-recipe batch is only a yield record. An **ad-hoc
  batch** (items drawn with no recipe) takes the items out as `prep_draw`; not
  enough on the lots is `INSUFFICIENT_STOCK` and nothing is drawn.
- **Issue on receipt**: an item flagged this way (a consumable that goes
  straight to use, such as bin liners) is charged to cost the moment it is
  received. Only a manager with the Inventory module can set the flag.

## 5. Counting stock

**Inventory -> Count.** There are two kinds:

- **Spot count** (the weekly habit): servd suggests a sample of items (heavier
  on high-value, fast-moving items; not ones counted in the last 7 days).
  Type what is there. A **shortage** is drawn from the lots as a count loss;
  a **surplus** opens a "count gain" lot at the latest purchase price. **Every
  line that differs from the books needs a reason of at least 3 characters**
  (`COUNT_REASON_REQUIRED`) - otherwise nothing is saved. A found item on a
  zero book gets a `stock_unrecorded` flag (higher severity if it has no
  price anywhere).
- **Opening count** (H19): counts stock servd has **never had a delivery or
  lot for**. It is allowed only for such items (`OPENING_NOT_ALLOWED`
  otherwise) and needs a cost (the line's, else the latest purchase price, else
  the item's estimate - `OPENING_COST_REQUIRED`). Only the CEO, owner,
  management or finance may run one. The stock it finds is booked **Dr stock /
  Cr 3010 Owner's Capital** (not retained earnings, per Hasnain), because it
  was in the kitchen before servd started counting.

Counts are posted on the day counted. A chronic pattern (an item that is a
little short every week) raises a `shrinkage_trend` flag from the nightly job.
Count variances are **unexplained** in the variance report - that is
deliberate: they are the number you investigate.

## 6. Who carries a cost that has no brand

Waste, count differences, ad-hoc prep, price differences on stock already
used, issue-on-receipt and write-offs usually do not belong to one brand. servd
splits each by **how much of that ingredient each brand's recipes used in the
last 30 days** (H20). The shares used are stored with the posting, so the
report shows what was posted, not a split that has since moved. If **no brand
used the item** in those 30 days the cost stays with head office (brand-less).

### Stock differences wait for the CEO (H20)

Hasnain asked that waste and count differences should not hit cost of sales
without a director's approval. The owner's answer (2026-10-14): **stock leaves
the shelves at once, but the cost waits in account 1290 "Stock Differences
Suspense", with its reason, until the CEO approves it into cost of sales.**
**Finance -> Stock differences** is the page for that: the CEO sees each
waiting waste or count difference with its reason, brand split and value, and
approves (it moves to 5040 / 5050) or sends it back with a note. **Month-end
close warns while anything is still waiting** (`stock_differences_pending`).
Each waste, sold-line waste and spot-count difference posts Dr 1290 / Cr 12x0
(a count gain the other way) at once; the CEO's approval posts one entry per
line, `stock_difference.clear:<line>`, dated the approval day, Dr 5040 (waste)
or 5050 (count) / Cr 1290 (a gain: Dr 1290 / Cr 5050). The one switch is
`stockDifferenceAccount` in `accounting/inventoryPosting.ts`. The variance
report reads these from the stock documents, so a difference still waiting
in 1290 shows as **timing** until it is approved; the Valuation tab shows the
1290 balance.

## 7. Reading Reports -> Food cost variance

**Reports -> Food cost variance** (its own module, so the CEO can grant it
separately; people with the Accounting module can read it too). Pick the dates (default: last 30 days) and
optionally a brand or outlet. One block per company; companies are never
blended. Revenue and percentages are shown only to finance and above; everyone
else sees quantities and PKR at cost.

**The sums.** For each company and brand:

> theoretical + explained + unexplained + alignment + timing = actual

| Line | What it is |
|---|---|
| **Actual** | Cost of sales in the books (5010-5060), split food / drinks / packaging. |
| **Theoretical** | What the orders sold in the period *should* have used: the lots their recipes actually relieved, with packaging where it applies, plus the shortfall memo. |
| **Explained** | Comps, staff meals, waste by reason, prep draws, issued on receipt, late receipts that settled earlier shortfalls, price adjustments (5060). |
| **Unexplained** | Spot-count variance, shortfalls "cooked before it was on the books", and any manual journal to 5010-5050. **This is the line to chase.** |
| **Alignment** | Orders placed before the FIFO cut-over, booked at the old plate cost ("pre-FIFO order") - kept apart so it is never mistaken for a loss. |
| **Timing** | Cost the ledger has not booked yet or booked in another period: open orders, till orders whose drawer is not closed, stock documents waiting for approval or a refused posting. |

The identity is checked per brand and per company; a difference is a bug to
report, not something to ignore.

**Status** per brand: *No sales*, *Incomplete data* (a dish sold with no
recipe, or stock data missing), *On target* (actual % at or under the recipe
target), *Watch* (up to 5 points over), *Over target* (more than 5 points
over). The target is the recipe's target food-cost %, weighted by revenue.

**Tabs:** Summary (the block above, plus MC by order type and by brand and the
waste reasons), Ingredients (per item: theoretical, waste, unexplained; sort by
what is unexplained), Valuation (lots against the 1210 / 1220 / 1230 accounts,
GRNI, cut-over details, failed postings, the 1290 balance), Flags. **Export**
gives the same rows as CSV. A scheduled **food cost email** uses the same
engine (Configuration -> Scheduled reports).

**By outlet:** actual cost is not available (the ledger is not per outlet yet);
the report says so rather than showing a wrong number.

## 8. The one-time cut-over and the alignment line

Before this release, stock was a quantity at a moving-average price. The first
time a company writes any stock (and at server start) servd **cuts it over**
once:

1. every item with stock gets one "FIFO cut-over" lot at its current cost;
2. old receipts are marked billed or open, so GRNI starts true (receipts the
   supplier has not billed sit on 2015; bills booked before goods become
   pending matches);
3. drinks and packaging are moved out of 1210 into 1220 and 1230;
4. the **pre-FIFO difference** per class (the ledger against the lots) is
   stored - **never posted by itself**.

The CEO then **aligns once** (Reports -> Food cost variance -> Valuation ->
Align inventory; a dry run first). The alignment posts the difference to 3020
(prior periods) - it never touches cost of sales. Anything the cut-over could
not tie (an old bill with no PO, a PO billed ahead of its goods) is listed for
the accountant on the Valuation tab. Periods before the cut-over have no lot
data, so the report cannot split them.

## 9. At month end and when something looks wrong

Period close warns (and the CEO can close over a warning with a written
reason) for: **Received, not billed** lines older than 30 days; **inventory
postings pending** (a stock posting refused and not yet re-posted); and, when
the Stock differences page ships, differences waiting for the CEO.

Flags you may see (Finance -> Exceptions): `stock_shortfall` (sold before it
was received), `stock_unrecorded` (found on a zero book), `shrinkage` /
`shrinkage_trend`, `yield_low`, `recipe_foreign_stock` (a recipe uses another
company's item - fix the recipe), `stock_restore_failed` (a stock step on an
order failed; it is retried), and `posting_failed` (the stock moved but the
entry was refused - **Reconciliation -> Backfill unposted** re-posts it).
