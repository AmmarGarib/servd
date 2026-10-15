import { redirect } from 'next/navigation'

// The Business Info page is gone (owner, 2026-10-15): it duplicated the brand
// editor (phone, WhatsApp, cuisine, price tier, reservations, map details) and
// its saves were refused. Brand details are edited in CEO → Brands; kitchen
// addresses and map pins in Locations. The module id `business_info` stays —
// it is what gives access to Locations and Delivery zones.
export default function BusinessInfoRedirect() {
  redirect('/ceo/brands')
}
