# Owner decisions 2026-10-13 (AskUserQuestion rounds) — BINDING for Wave B
- F1/K1: UPGRADE both existing fixed assets register and food cost (no duplicates; food cost -> one variance report under Reports, old link forwards).
- CASH REQUESTS (replaces voucher flow; owner confirmed rundown "Yes, exactly"): anyone who needs cash RAISES a GS Foods internal request
  -> HOD signs -> director (CEO) approves -> Jamil sb (box custodian) pays and marks paid (NO photo needed) -> requester UPLOADS RECEIPT(S)
  -> that books the expense. (Accounting default: advance until receipt; Hasnain H3/H4.)
- Petty cash funding: "for now all cash comes from the Garibsons cashier (GS Foods inactive, holds no cash)". Garibsons side = "Garibsons
  business, not servd" -> servd records cash-in from Garibsons only (account per Hasnain H1, default Due to Garibsons).
- DELIVERY/COD: delivery ONLY with the customer's code; NO manager "Delivered" override. Customer not paying -> rider returns food -> booked
  as food WASTE, logged by RGM / chef / F&B manager. New "EMERGENCY OVERRIDES" section (roles RGM, chef, F&B manager): (a) reroute the
  hand-over code to the RIDER's number when the customer can't receive it; (b) log returned food as waste.
- STRIKES: refused-at-door = strike; 3 strikes block the customer account + known email + number (per company); someone logging in/signing
  up with a blocked number can ESCALATE to the help desk (people change numbers).
- FA: depreciation AUTOMATIC monthly. NO threshold: everything with cost + lifespan tracked & depreciated; SMALLWARES (ladles, knives, bowls,
  trays) GROUPED and tracked; big things tracked individually. Disposals/scraps/write-downs: finance requests, CEO approves (F&B mgr NOT).
  NO opening/pre-servd assets ("we don't have anything purchased"). Equipment only via CAPEX.
- FOOD COST: split food / drinks / packaging. Each finished RECIPE gets a PACKAGING section (packaging-only concepts, e.g. Stackd); plate
  concepts get a small "Q factor" to pay off the plate. Costing = REAL-TIME at the PO price of the ingredients actually being cooked
  (FIFO lots) — owner rejected count-based actual. Per-outlet stock: NEXT build (tag outlet now).
- DELIVERY FEE: carries sales tax, ADDED ON TOP (customer pays more).
- ON ACCOUNT: named corporate clients with credit limit; client gets a QR code the cashier scans; NO manager approval per bill; finance
  invoices monthly.
- BAD DEBT write-off: CEO approves every one.
- RAAST "void, never booked": CEO ONLY.
- Wrong-brand Raast QR: "won't be possible" -> keep current refusal, no change.
- G15 (orders only from Procurement): not asked; do it (dead button).
- Accountant-level: "Hasnain questions" artifact https://claude.ai/artifact/7hjMzztgzMQJsZiaMUA2FW (H1-H30); build on the marked
  defaults ("In servd now"), Hasnain changes later.
- PACKAGING + MC (owner, 2026-10-13, later message): EVERY recipe ALWAYS has an optional packaging section (all brands, incl. plated
  ones like Simmer). Whether packaging counts depends on the ORDER TYPE leaving the restaurant: takeaway + delivery INCLUDE the recipe's
  packaging (stock depleted + cost booked); dine-in EXCLUDES it. A brand setting "serves in packaging on every order" (e.g. Stackd —
  packaging is the service vessel) makes packaging count for dine-in too. MC (material cost) = food + packaging; the report tracks
  ACTUAL MC vs TARGET MC (from the recipe) per order type — target MC for an order = food + (packaging if that order type uses it).
  Plate wear (Q factor) stays for plated dine-in only (pricing allowance, H18).
- PACKAGING FINAL (owner, after a back-and-forth): do the ORIGINAL plan + the brand primary setting + the button: takeaway/delivery
  include the recipe packaging; brands whose primary service vessel is packaging (Stackd) include it on every order; dine-in at plate brands
  excludes it UNLESS staff tap "box given" (leftovers) on the order/line, which depletes the box and adds its cost. Target MC per order
  type follows the same rule. MC = food + packaging.
- SERVICE VESSEL SET AT CREATION (owner): the brand's primary service vessel (plate | packaging) is a REQUIRED choice when a brand is
  created (create-brand form + API), editable later in Marketing → Brands; it is per BRAND (Concept), not per company. Existing brands
  backfilled: stackd = packaging, others = plate. A change applies to orders from then on (snapshot on the order line), never restates past cost.
