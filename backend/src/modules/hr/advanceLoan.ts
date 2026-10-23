// HR staff advances moved from an unsettled cash request (accountant default
// H3, 2026-10-13) — LEGACY rows only. The converter
// (createLoanFromCashAdvanceTx) had no caller left in servd (the cash-request
// flow books the expense at pay; 1355 is not used by new code) and has been
// removed. Rows written before stay ordinary approved 'loan' records
// (category 'advance') marked data.paidFrom 'cash_request', so loansFor,
// payroll installments, the F&F recovery and Staff loans 1350 still see them;
// two things still key on that marker:
//   - their disbursement credited 1355 (ledger.ts loanPayingAccount);
//   - HR cannot edit or cancel them (routes.ts → 409 LOAN_FROM_CASH_REQUEST).

export const CASH_REQUEST_PAID_FROM = 'cash_request'
