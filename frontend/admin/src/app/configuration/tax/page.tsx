import { redirect } from 'next/navigation'

// Placeholder retired (D14): it showed a hardcoded 17% GST that the till
// never charges. FBR / SRB setup and submission status live on Settings →
// Integrations; the cash / card GST rates are per brand in Storefront →
// Brands → Tax & FBR.
export default function TaxConfigRedirect() {
  redirect('/settings/integrations')
}
