import { redirect } from 'next/navigation'

// Retired. This page saved company-level fonts, extra colours, brand-voice
// notes and social handles into OperationsConfig, and nothing on the
// storefront or anywhere else ever read them. Each now has one home, per
// brand:
//   social links   → Storefront → Brand Footers (/storefront-footer)
//   WhatsApp       → Storefront → Brands → Contact (Concept.whatsapp)
//   brand voice    → Storefront → Brands → Brief (Concept.brandVoice)
// Kept as a redirect for old links.
export default function BrandAssetsRedirect() {
  redirect('/storefront-footer')
}
