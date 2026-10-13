# Wave 3 cross-file needs (apply after all streams finish)

## From C (IT + HR)  — report .handoff/fixreports/wave3-CD.json
1. backend/src/index.ts (~433, W4-owned): GET /integrations/social/status guard MANAGERS -> [...MANAGERS, ...CONNECTOR_ADMINS]
   (import CONNECTOR_ADMINS from './lib/connectorRoles.js'). Leave /integrations/social/connect at MANAGERS (owner call: may IT connect the
   Meta page token?) — and hide Connect for it on frontend/admin/src/app/settings/integrations/page.tsx if left.
2. backend/src/lib/moduleAccess.ts GATED_PREFIXES (stream E owns): optional central gates
   /auth/integrations/email -> api_whatsapp; /webhooks/endpoints|deliveries|events -> integrations; /notifications/broadcast|tokens -> notifications.
   Then drop local requireModule preHandlers (notifications/requireModule.ts) to keep one gate. NEVER gate '/webhooks' whole (inbound receivers).
3. frontend/admin/src/app/configuration/page.tsx:147 Email card: show only when me.role==='admin' || (me.role==='it' && modules has api_whatsapp).

## From D (kitchen)
4. backend/src/modules/crosschecks/routes.ts (stream B owns): GET+POST /physical-counts -> STOCK_COUNTERS = [...MANAGERS, 'boh'] (NOT procurement).
   Two-company test: boh B 404 posting a count line for A's item.
5. frontend/admin/src/app/accounting/recipes/page.tsx (+ [id]/page.tsx, RecipeForm.tsx): useKitchenView from '../../inventory/kitchenView' ->
   hide New/Edit/Delete/Submit, cost tiles/columns, steps editor writes; [id] read-only without costing-preview for kitchen view.
6. frontend/admin/src/app/food-safety/page.tsx: hide '+ Add standard units' (~61) and '+ Add standard schedule' (~94) unless manager tier.
7. GET /concepts 403 for boh/kitchen/expediter/finance/it/hr — stream E (UI-13).
8. Optional: moduleCatalog ModulePage.hideForRoles for /sourcing + /menu-engineering (['boh','kitchen','expediter']).

## From A (marketing) — report .handoff/fixreports/wave3-AB.json
9. concepts/routes.ts: do NOT open the full row to marketing. Marketing pages now use GET /concepts?view=picker (any staff role, scoped).
   The /marketing/brands editor (full GET + PATCH /concepts/:id) for marketing roles = OWNER DECISION (field allow-list excluding tax/strn/ntn/POS ids).
10. Optional: move marketing requireModule gates into GATED_PREFIXES (promos; promos; promos+configuration; crm+configuration; analytics; marketing_workspace).
11. Owner follow-up: GET /crm/customers/:id/context still returns global rollups (judgement 8).

## From B (finance)
12. moduleAccess.ts GATED_PREFIXES: finance AP reads. PREFER method-aware: readAnyOf for GET/HEAD on /procurement/bills|payments|purchase-orders|suppliers
    = ['procurement','accounting'] (writes stay ['procurement']) — pass req.method from middleware.ts attachStaffPrincipal into enforceModuleAccess.
    (Plain anyOf would let fnb_manager write procurement by URL — open owner question "F&B manager gets buying?")
13. frontend/admin/src/app/workforce/positions/view.tsx: seat/shift-band edit buttons only for MANAGERS + hr; contribution edits MANAGERS only (useAuthStore isRole).
14. concepts: finance + hr need the narrow picker view (stream E UI-13 / ?view=picker).
15. accounting/page.tsx (stream E HR-R8): also filter procurement card (procurement|accounting) and food-cost card (recipes|accounting); meta { background: true } on those queries.
16. Optional: GET /auth/users admit finance (petty-cash custodian picker) — page works without it.
17. Owner: manager tiers still reach /opex, /positions, /trustops, /crosschecks by URL w/o module (pre-existing); central gates would narrow fnb_manager (/opex) and foh_management (petty cash, deposit drops) — owner call.
