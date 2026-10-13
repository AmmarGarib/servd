# Fix-batch cross-file needs (apply after all four runs finish)

## From P (people) — .handoff/fixes/PO.json
1. frontend/admin/src/app/scheduling/page.tsx (U owns it now): Cell kind add 'leave' (+ source 'leave', leaveId); render 'Leave' label;
   'On approved leave' in day detail; hide Set/Add hours on a leave cell.
2. Optional: components/hr/RecordDetail.tsx list data._shiftsRemoved + data._swapsAffected on an approved leave.
3. Optional: backend/src/modules/hr/attendance.ts ~256 remark 'Punched in on an approved leave day'.
4. DONE (me): scheduling/routes.ts:173 null-role overlap filter fixed; attendanceRota + resimPeople 33/33.

## From O (online)
5. O-RV-3 pre-orders still hit kitchen/expo/dispatch immediately:
   - expo/routes.ts awaitingFire + inProgress: OR [{scheduledFor:null},{scheduledFor:{lte: now+PREP_MS}}] (+ optional 'upcoming' list) (K owns expo now)
   - workers/riderDispatch.ts runDispatchSweep: effective-time window using scheduledFor
   - orders/service.ts ingestOrder: emitOrderNew/deductInventory for pre-orders deferred (worker firing due pre-orders) or tagged
   - storefront/routes.ts ~975: is_pre_order = when.scheduled; scheduled_for only when scheduled (W owns storefront wallet parts)
   - kds routes new-ticket lists same filter
   Not Monday-critical (not trading); do as one integration task after the batch.
OWNER QUESTIONS: leave approval deletes existing shifts (not restored on cancel) — OK or flag only?; pre-order max 7 days ahead / per brand?;
   notify CEO on manager overbook?

## From T (till) — .handoff/fixes/TU.json
6. backend/src/lib/exceptions.ts ExceptionKind add 'manager_pin_failed' | 'discount_above_cap' | 'price_override'; switch managerPin.ts recordPinFailure
   'self_approval' -> 'manager_pin_failed'; pos/service.ts createPosOrder discount 'comp_above_threshold' -> 'discount_above_cap', price override
   'high_value_void' -> 'price_override' (metadata.realKind already set). Check exception list UI/labels for the new kinds.
7. backend/src/modules/orders/routes.ts: both requireManagerApproval calls (cancel ~289, refused-at-door ~408) add orderId: order.id.
8. frontend tillApi.ts paidCentsOf (order.payments ?? []) — check U did it.
9. frontend: VoidLineDialog.tsx, app/refunds/refundEngine.ts, till discount / pay-out PIN prompts handle 429 MANAGER_PIN_LOCKED (details.retryAfterSec):
   'Too many wrong PINs — a manager must sign in, or wait N minutes'; discount prompt expects INVALID_MANAGER_PIN after a wrong PIN.
10. backend/src/modules/trustops/routes.ts ~342: 403 INVALID_MANAGER_PIN when a PIN was sent but did not verify; pass actorId/action.
## From U
11. frontend/admin/src/app/menu-engineering/page.tsx ~54-57 -> ['concepts','brand-picker'] /concepts?view=picker.
OWNER Qs: PIN lockout 5/15min right?; 6-digit PINs?; marketing edit guest contact details (phone/WhatsApp/email)?

## From B (books) — .handoff/fixes/BK.json   [integration pass 2]
12. backend/src/modules/procurement/receiving.ts (RB-3, SAME RELEASE): import applyCarriedBillVarianceTx; in receiveGoods' tx loop after the
    PurchaseOrderLine quantityReceived increment: if (l.quantityReceived > 0) await applyCarriedBillVarianceTx(tx, { poLineId, quantity, supplierId: supplier.id, receiptId: receipt.id }).
13. backend/src/modules/loyalty/service.ts bookEarn (~213) / bookRedeem (~333): on refusal (not tx_not_found/not_earn_tx/not_redeem_tx/zero_value)
    call journal.flagPostingFailed({ tenantId, sourceType 'loyalty.earn'|'loyalty.redeem', sourceId: txId, entityType, entityId, reason, title }).
14. frontend/admin/src/app/accounting/period-close/page.tsx: default date = yesterday PKT, input max = yesterday.
15. Optional: admin reconciliation page shows backfill `orders.rows` / `orders.summary`.
## From K (kitchen)
16. Pacing gaps (K-RV-01/02) in orders/service.ts fireCourse + orders/routes.ts POST /:id/fire-course: fire only due lines of course 1
    (scheduledFireAt null or <= now), return `paced`; fireAll only for MANAGERS + expediter (403 FIRE_ALL_NOT_ALLOWED), audited with the order's
    company; re-anchor pacing when a till sale is paid after its creation-time schedule expired (see BK.json K fix needsOtherFiles).
17. R2-UI-02 frontend: procurement/receiving page read-only for non-managers ('A manager takes the delivery in'); procurement page 'Receive' action
    managers only; role descriptions appRoles.ts:60 + workforce/page.tsx:112 ('sees deliveries at the dock; a manager receives').
OWNER Qs: late postings inside a closed month -> post into the current open month with a memo?; buyers receive deliveries (decision 27 says no)?;
   should course 1 only be fired from expo?

## From W (wallet) — .handoff/fixes/WF.json
18. backend/scripts/wipe-and-reset.ts: add ['customerWallets', () => prisma.customerWallet.deleteMany()] next to walletTransactions, before customers.
## From F (fiscal)
19. backend/src/connectors/types.ts FiscalPayload.totals: deliveryChargeCents?, billDiscountCents?; totalCents comment = the BILL.
20. docs/pos-connector-api.md: totals identity Σ taxable + tax + service + tip + delivery − billDiscount = total; tenders wallet/gift_card/pending COD.
PROD (owner/finance): pre-deploy SELECT id,"walletBalance" FROM customers WHERE "walletBalance" < 0; one-off 2050 adjusting entry per company to
  SUM(customer_wallets) (contra 6060 for goodwill; inter-company spends = owner call); held docs rebuilt on release, mismatches flagged.
OWNER Qs: goodwill account (6065?) vs 6060; cross-company wallet spends settle inter-company or write off; FBR PaymentMode codes confirm with vendor.

## Integration pass 2 BK2+FE2 DONE (.handoff/fixes/IP2-BKFE.json)
- Me: applied .handoff/fixes/BK2-RV-supplierPosting.patch (receipt splits carried variance on-hand vs used->5060; void true-up) — books suites 104/104, tsc clean.
21. Optional: a runner (reconciliation action) for applyMissedCarriedBillVariances (catch-up for receipts before this release) — not needed while not trading.
22. orders/service.ts stale comment ~2160 ('bookEarn only logs a refusal') -> 'bookEarn flags a refusal itself; this re-checks…' (after OK2).
23. Optional (from F): docs/TAX_SETUP.md reporting-OFF note; connectorsApi.ts heldNote/reporting types; FiscalSetup/PosStatus show heldNote,
    REPORTING_OFF, TOTALS_MISMATCH.
OWNER Qs: loyalty redeem refusal severity high?; hide 'Receive' for the PO's own creator (needs createdBy in list)?
