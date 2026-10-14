# Fixed assets, CapEx, smallwares and prepayments — finance and CEO guide

Dated 2026-10-14. For finance staff (Hasnain) and the CEO. Everything here is
in **Accounting → Fixed assets** and **Finance → Project tracker** (CapEx).
The technical contract is `backend/src/modules/fixedAssets/README.md`.

## The short version

- There is **one** register of what the company owns, per company. Nothing is
  typed into it by hand and there is no "opening assets" list: equipment gets
  on the register **only through CapEx** (a project line, or Quick buy).
- Depreciation is **automatic**. Every night servd charges every completed
  month. There is no switch, no minimum value and no "run depreciation" job to
  remember.
- Finance **asks**, the CEO **approves**: capitalising an item, selling or
  scrapping it, writing it down, writing smallwares off, changing a life,
  voiding a mistake. The F&B manager can count smallwares but cannot ask for
  or approve any of these.
- Everything the register does reaches the books at once, in the asset's own
  company, and the register has to **tie out** to the ledger (section 9).

## 1. Who does what

| Who | What they can do |
|---|---|
| Finance, management, owner | Raise CapEx lines, Quick buy, ask for a capitalisation, a disposal, a write-down, a pool write-off, a change of life, a void; transfer an asset or smallwares between outlets or brands; count smallwares; run "charge now". |
| CEO (role `admin`) | Everything above, **and** approve or reject every request; edit asset classes (label, default life, tax rates); change the company policy; freeze a tax year. A request the CEO raises applies at once. |
| F&B manager | Count smallwares pools (a count changes nothing in the books). Nothing else. |
| Everyone else | Cannot open the register. |

A request from anyone but the CEO waits as **pending** (the screen says
"waiting for the CEO"). It appears in the CEO's approvals inbox as "Fixed
assets" and on the request list. The CEO can approve or reject (a reason is
required to reject). The person who asked, or the CEO, can cancel it while it
waits. An approval posts in one go: if the engine refuses (for example the
books are closed through today) the request stays pending with the reason
written on it, and nothing is half-booked.

## 2. How equipment gets on the register

### 2.1 CapEx project line, then capitalise

1. **Finance → Project tracker**: make the project and a CapEx line for the
   item. Name the **supplier** (this is what sets the income tax withheld, see
   section 7), say what it is, and choose the **treatment** of the line:
   - **capital** — equipment or fit-out that will be depreciated;
   - **prepaid** — a rent advance or similar, spread over the months it covers
     (section 8);
   - **deposit** — a refundable security deposit (section 8);
   - **expense** — a broker or legal fee that is simply a cost.

   Architect, design and project-management fees on a build-out are entered as
   **capital** lines of the same project, so they become part of the cost of
   the fit-out. Legal and broker fees are **expense** lines.
2. Pay the supplier instalments on the line. While the item is not yet
   capitalised, each paid instalment sits as an **advance to suppliers
   (1340)**. Income tax is withheld from the supplier at the supplier's filer
   rate (s.153), and sales tax charged on the invoice is recorded by the
   authority that charged it. A bank payment names the bank account; a cash
   payment can only come from a petty-cash box or a cash request (see
   `docs/cash-requests-and-petty-cash.md`).
3. When the item is **delivered**, finance **capitalises** it: pick the asset
   class, the outlet and (for single big items) the brand, and the in-service
   date. If the item is not yet delivered servd answers `NOT_DELIVERED`.
   A line of several units of a non-pooled class becomes that many individual
   assets with their own tags (up to 200 at once). A pooled class (smallwares)
   becomes one **layer** of a pool with a quantity.
4. Finance's capitalisation is **pending** until the CEO approves it. On
   approval the engine posts: Dr the class cost account (plus Dr input tax)
   / Cr 1340 for what was already advanced / Cr 2012 "Payables - Capital
   Suppliers" for what is still owed to the supplier. Later instalments on a
   capitalised line settle 2012 (Dr 2012 / Cr money).

If the CEO approves a capitalisation after the month it belongs to has been
closed, the cost posts **today with a note** naming the original month, and
the depreciation for the missed months is charged the same night as a
catch-up (section 5).

### 2.2 Quick buy (one step, bank only)

For a small purchase that does not need a project: **Finance → Project
tracker → Quick buy**. It creates the standing project and line, records the
bank payment and asks for the capitalisation in one go. It is **bank only**
(`QUICK_BUY_BANK_ONLY`). Quick-buy items are pooled when the class is
smallwares; a single big item booked by Quick buy is shown as shared across
brands, because the standing project has no brand (open point, section 11).

### 2.3 Equipment is refused everywhere else

servd reads the description of a spend. If it looks like equipment (a
fridge, a fryer, a gas range, a laptop...) these places refuse it with
`USE_CAPEX` and point to Quick buy:

- a **supplier bill** line with no stock item (bills do not take equipment);
- an **OpEx** payment;
- a **petty-cash** or **cash-request** *expense* line (the receipts of a cash
  request can instead carry an **Equipment** line, which goes through CapEx
  and is capitalised normally).

If the description is wrong (say "a fridge magnet"), finance or the CEO can
override with **"This is not equipment"** and a reason of at least 10
characters; the override is audited and raises an `equipment_override` flag
that the CEO sees. Nobody else can override. The F&B manager cannot add to
the register at all.

## 3. Classes, accounts and lives

Each company has the same class list. Lives are the accountant's defaults
(H22); the CEO can change a class's default life or tax rates in
the Classes list on the Fixed assets page, and a single asset's life can be
changed by a "change of estimate" request.

| Class | Cost account | Accumulated depreciation | Life | Tax rate | Initial allowance |
|---|---|---|---|---|---|
| Kitchen equipment | 1510 | 1591 | 5 years | 15% | 25% |
| Furniture and fixtures | 1520 | 1592 | 7 years | 15% | - |
| IT equipment | 1530 | 1593 | 3 years | 30% | 25% |
| Vehicles | 1540 | 1594 | 5 years | 15% | - |
| Leasehold improvements (fit-out) | 1550 | 1595 | 10 years, or the lease end | 10% | - |
| Buildings | 1505 | 1596 | 20 years | 10% | - |
| Power and generation | 1515 | 1597 | 7 years | 15% | 25% |
| Office equipment | 1525 | 1598 | 5 years | 15% | 25% |
| Smallwares (pooled) | 1560 | 1599 | 24 months | to confirm | - |
| Land | 1500 | - | not depreciated | - | - |

The old single "accumulated depreciation" account **1590** is legacy. A
one-off move spreads whatever it held onto the per-class accounts 1591-1599
(H27); anything left on 1590 shows up on the tie-out.

The register accounts (1500-1599 and 2012) are **controlled**: only the
register and CapEx can post to them. A manual journal that touches them is
refused (`REGISTER_CONTROLLED_ACCOUNT`) unless the CEO gives an override
reason; such a journal raises a `fixed_asset_gl_mismatch` flag.

## 4. Smallwares: pools, counts and write-offs

Ladles, knives, bowls, trays and plates are not worth a tag each. They live in
**pools**: one pool per outlet, brand and type (for example "Simmer - Clifton
- bowls"). Each purchase is a **layer** of the pool (quantity and cost). The
pool is written down over **24 months**.

- **Counts.** The F&B manager or finance counts a pool in the register
  ("Count"): type what is physically there. A count books nothing; it shows
  the shortfall against what the books say is on hand.
- **Write-off.** Broken, lost or stolen units are written off through a
  **pool write-off request** (units and a cause). The CEO approves. Units
  leave the oldest layers first; the accumulated depreciation of those units
  goes with them and the unrecovered rest is a loss (8030).
- **Transfer.** Moving units to another outlet or brand needs no approval and
  posts only if the brand changes.
- **Plate wear.** The wear of plates is paid for through smallwares
  depreciation, not through a stock allowance. The Q factor on recipes is
  only a pricing allowance (see `docs/food-cost.md`).
- Assets **stay in their outlet**; moving one is a transfer event on the
  register, so reports show it where it was on any date.

## 5. Depreciation: automatic, monthly, with late months

- Straight line over the life, **full-month convention**: the month the asset
  goes into service is charged, the month it is disposed of is not. Each month
  is what is left to depreciate divided by the months left; the last month
  takes the remainder, so the lifetime total is exactly cost less salvage.
- **Every night at 03:20 (Karachi)** servd charges, for every company, every
  completed month not yet charged. The same night it releases prepayments
  (section 8) and runs the register checks. Each run is written to the run
  list (the run list on the Fixed assets page).
- **Charge now / catch up** (finance): runs the same engine for the **active
  company**, completed months only (`MONTH_NOT_ENDED` for a month not over).
  It is the same code as the nightly run, never a second one.
- **Late months.** If a month is charged after its own month was closed (for
  example an asset approved late), the charge is posted into the open month
  **today, with a note naming the original month**. Nothing is refused for a
  closed month. If the books are closed right through today the run waits and
  retries the next night (`BOOKS_CLOSED_TODAY`).
- Depreciation is booked Dr 6150 / Cr the class's accumulated account, on the
  brand charged that month.
- **Period close.** Closing a month first charges depreciation through it; an
  uncharged month is a **block** on the close checklist (the CEO can close
  over it with a written reason, never silently). A capitalisation still
  waiting for the CEO is a warning.

## 6. Disposals, write-downs and corrections

All of these are **requests**: finance asks (with a reason of at least 10
characters), the CEO approves. The CEO's own request applies at once.

| Request | What it does when approved |
|---|---|
| **Disposal** (sold, scrapped, lost, stolen) | Charges depreciation up to the month before the disposal date, then Dr accumulated + Dr money received / Cr cost; the difference is a gain or a loss (8030). Proceeds go to the named bank or cash account. |
| **Impairment** (write-down) | Dr 6155 Impairment / Cr accumulated; the asset keeps depreciating on the lower value. |
| **Change of estimate** (life or salvage) | Applies to future months only; nothing is restated. |
| **Void** (capitalised by mistake) | Reverses the acquisition, every month charged and every write-down. |
| **Undispose** | Reverses a disposal and charges the months in between. |
| **Pool write-off** | Section 4. |
| **Transfer** (outlet or brand) | Moves cost and accumulated depreciation to the new brand; no approval. |

The F&B manager is not allowed to ask for any of these (decision of
2026-10-13).

## 7. Withholding and tax on the way in

- **Income tax withheld from the supplier** on a CapEx payment is worked out
  from the supplier's **filer status** (filer, non-filer, or exempt with a
  certificate valid on the payment date) and the section of the line (s.153
  goods, services, contracts; s.155 rent). A supplier with an exemption
  certificate is withheld 0; a deposit is never withheld. The rates are set in
  **Accounting → Sales tax return → Withholding rates** (see
  `docs/TAX_SETUP.md`). The withheld amount is credited to 2040 and listed on
  the **Withholding register**.
- **Sales tax on the supplier's invoice** is recorded as input tax on the
  authority that charged it (FBR, SRB, PRA, KPRA or BRA), claimed when the
  item is capitalised (for rent and fee lines, with each instalment).

## 8. Rent prepayments and deposits

- **Prepaid (rent advance, H25).** A CapEx line with treatment *prepaid* is
  entered with **covers from** and **months covered**. The payment is booked
  to **1310 Prepaid Expenses** and the nightly run releases it **monthly to
  6010 Rent**, on the project's brand, dated each month end. Releases never go
  past the last completed month and never past what the payment actually put
  into 1310. A payment whose release has begun cannot be edited
  (`PREPAID_RELEASING`). If a payment has no term the nightly run raises a
  `capex_prepaid_unscheduled` flag. Finance can also release by hand
  (**Release prepayments**, same engine).
- **Deposits (H25).** A refundable security deposit is booked to **1360** and
  is never released. When the landlord returns it, use **Return deposit**:
  money in (Dr bank), anything the landlord kept is a rent cost (Dr 6010),
  Cr 1360. A reason is required if anything was kept. A deposit that was
  wrongly booked as a prepayment can be **re-classed** to 1310 by the CEO
  (dry run first).
- There is **no IFRS 16** lease accounting. Rent is expensed as paid or spread
  as above.

## 9. Reports, the tie-out and the 1340 advances

On the Fixed assets page, under Reports (all can be downloaded as CSV with
exactly the rows shown):

- **Schedule** - depreciation by month, by class, brand, outlet, pool or asset
  (up to 120 months).
- **Roll-forward** - opening, additions, depreciation, disposals, closing, per
  class; it ties to the ledger and says if it does not.
- **NBV at a date** - net book value by class, brand, outlet, pool or company,
  with brand and outlet as they were on that date.
- **Tie-out** - the register against the ledger per class and per code: cost,
  accumulated depreciation, and the legacy 1590 balance. Also compares 2012,
  1310 and 1360 with what CapEx, capitalisation, prepaid releases and
  deposits posted there. The server health check (`/health`) warns if any company is off, or if the
  nightly run failed, or if no run has happened in 36 hours.
- **1340 advances** - money paid to suppliers for items not yet capitalised,
  with age. An advance older than the company policy allows (the CEO sets the
  number of days in the company policy on the Fixed assets page) raises
  `capex_advance_overdue`; a delivered but uncapitalised item raises
  `capex_uncapitalised`.
- **Tax** - section 10.

## 10. Tax depreciation and the tax-year freeze

- The **tax schedule** (Reports, Tax; the active company only) uses the Income Tax
  Ordinance Third Schedule rates in the class table (H23), on the **written-down
  value** of each asset, per tax year (1 July to 30 June, named by the year it
  ends in): in the year of first use a **25% initial allowance** on eligible
  plant (kitchen, IT, power, office equipment) and then the class rate on what
  is left; later years the rate on the opening value; in the year of disposal
  no depreciation, and the proceeds come off the value. Cost is net of
  claimable input tax. A partial smallwares write-off does not move the tax
  value (Hasnain to confirm).
- **Smallwares are not in the tax schedule.** The Third Schedule rates do not
  cover them; they are listed as **"tax treatment to confirm"** until
  Hasnain gives the treatment.
- The CEO can **freeze a tax year** once the return is filed
  (`POST /reports/tax/<year>/freeze`): the year's schedule stops changing even
  if a late disposal is entered. Freezing a year not yet over is refused
  (`TAX_YEAR_OPEN`), and a frozen year cannot be frozen again.
- **There is no deferred-tax report** (H24): Hasnain said deferred tax is not
  needed. Nothing in servd shows a deferred-tax figure.

## 11. Open points and things to know

- **Every capitalisation goes to the CEO**, smallwares Quick buys included.
  The owner's decision named only disposals, scraps and write-downs, so this
  is the default built to keep today's CEO-only control. If the CEO does not
  want to approve small smallwares purchases, that is a one-line change. A
  delayed approval pushes depreciation into later months (it catches up).
- A single big item bought through Quick buy is shown as shared across brands
  until a later fix lets Quick buy carry a brand.
- Smallwares tax treatment (H23) is open with Hasnain.
- Year end is **30 June** for all companies (H29). The roll-forward is virtual:
  nothing is posted at year end and nothing is reversed on a reopen.
- Closing a month with a pending capitalisation is allowed with a warning; the
  asset then depreciates from its in-service month once approved.
