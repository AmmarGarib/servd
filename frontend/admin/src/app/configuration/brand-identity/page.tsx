import { redirect } from 'next/navigation'

// Brands have ONE editor: CEO → Brands (/ceo/brands), over
// PATCH /concepts/:id. This page wrote the same Concept fields (logo, colour,
// tagline, banner, description, map pin, delivery radius) and the last save
// won. The map pin now belongs to the kitchen's Location and the radius to
// delivery zones. Kept as a redirect for old links and bookmarks.
export default function BrandIdentityRedirect() {
  redirect('/ceo/brands')
}
