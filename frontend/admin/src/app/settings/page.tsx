import { redirect } from 'next/navigation'

// /settings is retired. Every tab it had now lives on the one page that owns
// that job, and this route stays only so old links and bookmarks land
// somewhere useful:
//   Concepts (brands, GST cash/card, visibility, delete, retired brands)
//                         → Storefront → Brands (/marketing/brands)
//   Stations              → Kitchen → KDS Config (/kds/config)
//   Staff                 → Workforce (/workforce)
//   Printer               → Configuration → Receipts (/configuration/receipts)
//   Clock-in geofence     → Configuration → Operations
//   Language              → Configuration → Language (/configuration/language)
// Adding a brand or a company is the setup wizard (/onboarding).
export default function SettingsRedirect() {
  redirect('/marketing/brands')
}
