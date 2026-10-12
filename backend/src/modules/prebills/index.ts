// Pre-bills — guest checks printed before payment (spec §17). Never fiscal,
// never ledger, never revenue. See service.ts for the lifecycle.
export {
  createPreBill,
  markPreBillsConvertedTx,
  markPreBillsCancelledTx,
  renderPreBillHtml,
  preBillReceiptFor,
  listPreBills,
  preBillsCsvRows,
  preBillLabel,
  PRE_BILL_BANNER,
  ORPHAN_AFTER_MS,
  type PreBillTender,
  type PreBillLine,
  type PreBillReceipt,
  type PreBillRow,
  type PreBillSummary,
  type PreBillList,
  type PreBillFlag,
  type CreatePreBillInput,
} from './service.js'
export { registerPreBillPlugins, preBillPosRoutes, preBillFinanceRoutes, PREBILL_FINANCE_ROLES } from './routes.js'
