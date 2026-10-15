import { redirect } from 'next/navigation'

// Brands moved to the CEO workspace (owner, 2026-10-14: "the brand editor
// needs to be moved to CEO stuff, because a lot of this stuff is not
// marketing related"). The one brand editor is CEO → Brands (/ceo/brands),
// CEO only. This route stays so old links and bookmarks land there, with the
// brand they named (?id=) kept.
export default function MarketingBrandsRedirect({ searchParams }: { searchParams?: { id?: string | string[] } }) {
  const id = Array.isArray(searchParams?.id) ? searchParams?.id[0] : searchParams?.id
  redirect(id ? `/ceo/brands?id=${encodeURIComponent(id)}` : '/ceo/brands')
}
