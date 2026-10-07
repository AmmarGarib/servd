// The servd logo in the nav — operator-set in Admin → Storefront → "servd
// logo" (SiteLayout `servd:header`, one `siteLogo` block; CEO-approved like
// everything else). Nothing live, or no image picked → null, and the nav shows
// the text wordmark.

import { fetchSiteLayout } from './blocks'

export interface SiteLogo { url: string; alt: string; height: number }

export async function fetchSiteLogo(): Promise<SiteLogo | null> {
  const layout = await fetchSiteLayout('servd:header')
  const blocks = (layout?.blocks ?? []) as unknown as Array<Record<string, unknown> | null>
  const block = blocks.find((b) => b?.type === 'siteLogo') ?? undefined
  const url = typeof block?.url === 'string' ? block.url.trim() : ''
  // Same rule the API enforces: https or a site path, never protocol-relative.
  if (!url || !/^(https:\/\/|\/(?!\/))/.test(url)) return null
  const h = Number(block?.height)
  return {
    url,
    alt: typeof block?.alt === 'string' && block.alt.trim() ? block.alt.trim() : 'servd',
    height: Number.isFinite(h) ? Math.min(44, Math.max(16, Math.round(h))) : 28,
  }
}
