import { redirect } from 'next/navigation'

// Tax filing setup moved to Dev → API → POS connector (spec §10): FBR / SRB
// are filed by the external fiscal POS through servd's POS connector, and the
// brand POS ids are edited there. The cash / card GST rates stay per brand in
// Marketing → Brands → Tax registration.
export default function TaxConfigRedirect() {
  redirect('/connectors/pos')
}
