import { redirect } from 'next/navigation'

// Customers live on /crm (D11) — same GET /crm/customers list, plus search,
// segments, the detail pane, blacklist and wallet top-up. This second list
// only linked each row to a /crm/:id page that never existed. Kept as a
// redirect for old links; open one customer with /crm?customer=<id>.
export default function CustomersRedirect() {
  redirect('/crm')
}
