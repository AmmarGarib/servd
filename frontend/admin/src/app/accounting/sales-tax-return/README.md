# sales-tax-return

Admin route: **/accounting/sales-tax-return** (module `accounting`). Three tabs;
`?tab=withholding-rates` / `?tab=withholding-register` open a tab directly
(Configuration → Operations links to the rates).

## Files

- `page.tsx` — the **Return** tab and the tab bar. Reads
  `GET /accounting/sales-tax-return?dateFrom&dateTo` (the ACTIVE company; CSV
  with `&format=csv`). Shows output / input tax, each authority's own net
  (input of one authority never sets off another's output), **Withheld by
  customers (1335)** and **Net after withholding** per authority (H13),
  income tax / sales tax withheld by us (2040 / 2041), payments for the
  period, the by-rate table (supplies labelled as the API's `SUPPLY_LABEL`:
  standard, own rate, zero-rated, exempt, **Delivery charges** — H9, GST at
  the order's tender rate), reclasses, taxable sales by brand (revenue +
  delivery charges) and the API's caveats.
  - **H10 (accountant, 2026-10-14):** a kept no-show deposit is untaxed
    OTHER income (4210), not a supply. While the API still sends
    `supply: 'deposit_forfeit'` rows they are shown apart, labelled "Other
    income, not taxable (H10)", left out of the by-rate table and never
    declared; the API's old "deposits are taxable" caveat is hidden.
  - Statutory payroll challans (salary tax 2042 / EOBI 2043 / SESSI 2044) are
    NOT this return's payments — they live on Accounting → Statutory
    payments; rows with `kind: 'statutory'` are filtered out.
  - **Record payment** (`POST /accounting/sales-tax-return/payments`, admin +
    finance): paid, input set off, and for a sales-tax authority
    **Withheld by customers set off** (the hint shows the API's
    `customerWithheldAvailableCents`). Link existing entry, void / unlink and
    post reclass as before. Every error code is shown in words
    (`NO_WITHHELD_SET_OFF`, `WITHHELD_SET_OFF_TOO_LARGE`,
    `INPUT_SET_OFF_TOO_LARGE`, `TAX_PAYMENT_EXISTS`, `NOT_LINKABLE`, …).
- `WithholdingRates.tsx` — `GET/PUT /accounting/withholding/rates`: filer and
  non-filer rate per section (153(1)(a)/(b)/(c), 155) for the ACTIVE company.
  Editable only when the API's `canEdit` is true (admin, finance); read-only
  otherwise. The PUT is the ONE writer of the rates (and of the legacy
  `withholdingTaxPct`); the on/off switch stays on Configuration → Operations.
- `WithholdingRegister.tsx` — `GET /accounting/withholding/register?from&to`
  (+ `&format=csv`): one row per income-tax deduction (supplier bills, paid
  OpEx and CapEx payments) for the CA's s.165 statement; company column in
  "All companies" view.

All figures are the server's: the page never works tax out. Money is typed in
rupees and sent in paisa.
