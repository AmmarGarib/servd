# backend/src/modules

Every module is `routes.ts` (HTTP handlers) optionally with `service.ts` (business logic). Each is registered in `src/index.ts` under a URL prefix.

| Module | URL prefix | Purpose |
|---|---|---|
| `auth` | `/auth` | Login, PIN, JWT verification, clock-in/out |
| `concepts` | `/concepts` | Brand / multi-tenant configuration |
| `menu` | `/menu` | Categories, items, modifiers, allergens |
| `orders` | `/orders`, `/order-items` | Order CRUD, status transitions, course pacing, auto-86 |
| `pos` | `/pos` | Point-of-sale: takings, shifts, payments, receipts |
| `kds` | (consumes WS) | Kitchen Display System events |
| `stations` | `/stations` | Kitchen station definitions for KDS routing |
| `storefront` | `/storefront` | Customer-facing menu/order endpoints |
| `webhooks` | `/webhooks` | Inbound webhooks from Foodpanda, Careem, WhatsApp, payment providers |
| `inventory` | `/inventory` | Stock items, par levels, alerts, waste log |
| `recipes` | `/recipes` | Recipe costing, ingredient mappings, kitchen instructions |
| `procurement` | `/procurement` | Suppliers, POs, bills, vendor payments, supplier chat |
| `reports` | `/reports` | Sales, top items, station times, menu engineering, demand forecast |
| `accounting` | `/accounting` | Journal entries, trial balance, P&L, sales tax return |
| `finance` | `/finance` | Read-only financial summaries |
| `crm` | `/crm` | Customer profiles, segments, smart segments, campaigns |
| `loyalty` | `/loyalty` | Points, tiers, redemption |
| `wallet` | `/wallet` | Customer wallet credit, transactions |
| `promos` | `/promos` | Promo codes, usage limits |
| `discounts` | `/discounts` | Discount rules + application |
| `giftCards` | `/gift-cards` | Gift card issuance + redemption |
| `reviews` | `/reviews` | Customer reviews of orders |
| `complaints` | `/complaints` | Customer complaint intake + resolution |
| `riders` | `/riders` | Delivery rider assignments + payouts |
| `dispatch` | `/dispatch` | Order → rider matching |
| `tables` | `/tables` | Floor plan tables for in-store dining |
| `floors` | `/floors` | Floor plan layout |
| `reservations` | `/reservations` | Booking + capacity management |
| `scheduling` | `/scheduling` | Staff shift scheduling |
| `payroll` | `/payroll` | Wage runs, deductions, tip distribution |
| `tipPools` | `/tip-pools` | Tip pooling rules |
| `checkSplit` | `/check-split` | Split-the-bill at POS |
| `groupOrders` | `/group-orders` | Shared cart for groups |
| `siteLayouts` | `/site-layouts` | Brand microsite layouts |
| `reconciliation` | `/reconciliation` | Cash drawer reconciliation, payment-platform settlement matching |
| `allocations` | `/allocations` | Cost allocation across concepts |
| `invoices` | `/invoices` | Tax invoice issuance (FBR-compliant) |
| `qrcodes` | `/qrcodes` | Per-table scan-to-order QR generation |
| `media` | `/media` | R2-backed media library |
| `apiTokens` | `/api-tokens` | Long-lived bearer tokens for partners + mobile app |
| `permissions` | `/permissions` | Editable role × permission matrix |
| `analytics` | `/analytics` | Storefront event analytics + funnels |
| `calendar` | `/calendar` | Content calendar (marketing) |
