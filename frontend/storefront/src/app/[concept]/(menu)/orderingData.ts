// Server-side read of a brand's ordering menu, so /<concept> has the dishes,
// prices and sections in its first HTML (search engines and AI tools read
// that, not what the browser fetches later). Same public endpoint the client
// screen calls — GET /storefront/<slug>/menu — with no caching, so a failed
// read is never baked into a cache (CLAUDE.md "Fetch caching gotcha").
//
// null = the API didn't answer (down, a 5xx, its shared rate limit): the page
// then renders the skeleton and the client screen fetches the menu itself,
// exactly as before.

import type { OrderingMenu } from './OrderingScreen'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export async function fetchOrderingMenu(slug: string): Promise<OrderingMenu | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug)) return null
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/${encodeURIComponent(slug)}/menu`, { cache: 'no-store' })
    if (!res.ok) return null
    const payload = await res.json() as OrderingMenuPayload | OrderingMenu['categories']
    if (Array.isArray(payload)) return { categories: payload, ordering: null, isTestCompany: false }
    if (!payload || !Array.isArray(payload.categories)) return null
    return {
      categories:    payload.categories,
      ordering:      payload.ordering ?? null,
      isTestCompany: payload.concept?.isTestCompany === true,
    }
  } catch {
    return null
  }
}

interface OrderingMenuPayload {
  concept?:    { isTestCompany?: boolean }
  categories:  OrderingMenu['categories']
  ordering?:   OrderingMenu['ordering']
}
