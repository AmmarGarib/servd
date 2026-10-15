import { redirect } from 'next/navigation'

// Retired. This page saved company-level fonts, extra colours, brand-voice
// notes and social handles into OperationsConfig, and nothing on the
// storefront or anywhere else ever read them. Each now has one home, per
// brand:
//   social links   → Storefront hub → the brand's footer page (brand:<slug>:footer)
//   WhatsApp       → CEO → Brands → Contact (Concept.whatsapp)
//   brand voice    → CEO → Brands → Brief (Concept.brandVoice)
// Kept as a redirect for old links.
export default function BrandAssetsRedirect() {
  redirect('/storefront')
}
