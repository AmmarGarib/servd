# frontend/admin/src/app

Next.js App Router. Each subdirectory is a URL segment.

## Top-level routes

- [`dashboard/`](./dashboard/) — Live operations cockpit (loaded for any signed-in user).
- [`kds/`](./kds/) — Kitchen Display System (per-station + expediter).
- [`pos/`](./pos/) — Point of Sale (cashier + waiter modes).
- [`orders/`](./orders/) — Order list + detail + courses + bill split.
- [`menu/`](./menu/) — Menu editor (categories, items, photos, instructions).
- [`inventory/`](./inventory/) — Stock + low-stock alerts.
- [`procurement/`](./procurement/) — Suppliers, POs, bills, payments, supplier chat.
- [`accounting/`](./accounting/) — P&L, food cost, recipe costing, sales tax return, audit log.
- [`crm/`](./crm/) — Customer list, segments, campaigns.
- [`reports/`](./reports/) — Sales reports, demand forecast, menu engineering.
- [`finance/`](./finance/) — Financial summaries.
- [`riders/`](./riders/) — Delivery rider management.
- [`scheduling/`](./scheduling/) — Weekly staff roster.
- [`tables/`](./tables/) — Floor plan + table assignments.
- [`reservations/`](./reservations/) — Bookings.
- [`storefront/`](./storefront/) — Storefront layout editor.
- [`media/`](./media/) — Image library (R2-backed).
- [`promos/`](./promos/), [`discounts/`](./discounts/), [`gift-cards/`](./gift-cards/), [`qrcodes/`](./qrcodes/) — Marketing/incentives.
- [`reviews/`](./reviews/), [`complaints/`](./complaints/) — Customer feedback.
- [`payroll/`](./payroll/), [`tip-pools/`](./tip-pools/) — People + comp.
- [`reconciliation/`](./reconciliation/), [`refunds/`](./refunds/) — Money operations.
- [`dispatch/`](./dispatch/) — Order → rider routing.
- [`floorplan/`](./floorplan/) — Visual floor plan editor.
- [`allocations/`](./allocations/) — Cost allocation across concepts.
- [`live/`](./live/) — Real-time event stream debug page.
- [`chain/`](./chain/) — Multi-brand chain rollup.
- [`configuration/`](./configuration/) — Configuration Hub (single page that surfaces every editable setting).
- [`settings/`](./settings/) — Concept / station / staff editor (older settings UI).
- [`help/`](./help/) — Help centre with FAQ + WhatsApp support shortcut.
- [`supplier/`](./supplier/) — Public supplier portal (token-auth, no login).
- [`login/`](./login/) — Staff sign-in.
- [`calendar/`](./calendar/) — Content calendar.
- [`content/`](./content/) — CMS-ish content blocks.
- [`analytics/`](./analytics/) — Storefront analytics dashboard.
- [`customers/`](./customers/) — Customer detail pages.
