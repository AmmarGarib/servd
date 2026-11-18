// Where an account shows in the P&L is STORED on the account (owner, 2026-11-18: "account code should not decide
// where an account balance will reflect") — backend lib/accountSection.ts is the one rule; the chart list
// (GET /setup/chart-of-accounts) sends the resolved `plSection` on every row. Never test an account's code here.

export type PlSection = 'revenue' | 'other_income' | 'cost_of_sales' | 'contra_revenue' | 'operating_expense'

/** A running-cost account a payment, voucher or bill line may be booked to. */
export function isOperatingExpenseAccount(a: object): boolean {
  return (a as { plSection?: string | null }).plSection === 'operating_expense'
}
