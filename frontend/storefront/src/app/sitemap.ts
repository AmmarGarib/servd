import type { MetadataRoute } from 'next'
import { fetchBrandLocations } from '../lib/brandLocations'

// Sitemap covers every customer-facing URL Google + LLMs need to crawl.
// Per the local-seo + ai-seo skills: without a sitemap, AI surfaces and
// Google can't index the per-brand pages efficiently. Excludes account /
// checkout / order trackers — those are post-auth and have no SEO value.
//
// Brand list is fetched from the live Concept rows so adding a new
// concept in admin instantly puts its URLs in the sitemap on the next
// request; no code change needed.

import { SERVD_ORIGIN, brandCanonical } from '../lib/brandDomains'

const SITE = SERVD_ORIGIN
const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const now  = new Date()

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const brandLocations = await fetchBrandLocations(API_URL)
  const brandSlugs = Object.keys(brandLocations)
  const locationSlugs = Object.values(brandLocations).map((b) => b.locationSlug)

  const top: MetadataRoute.Sitemap = [
    { url: `${SITE}/`,        lastModified: now, changeFrequency: 'daily',   priority: 1.0 },
    { url: `${SITE}/home`,    lastModified: now, changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${SITE}/reserve`, lastModified: now, changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${SITE}/press`,   lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
  ]

  // Brand microsites are listed at their CANONICAL URLs — each brand's own
  // domain — not at servd.pk/brand/<slug>. Listing the servd path would have
  // the sitemap say "index this" while the page's canonical says "index the
  // other one", which wastes crawl budget and dilutes the brand domain that
  // owning the domain was meant to build up. Cross-host entries are fine so
  // long as both domains are verified together in Search Console.
  const brand: MetadataRoute.Sitemap = brandSlugs.flatMap((slug) => [
    { url: brandCanonical(slug),           lastModified: now, changeFrequency: 'weekly',  priority: 0.9 },
    { url: brandCanonical(slug, 'menu'),   lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
    { url: brandCanonical(slug, 'visit'),  lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${SITE}/${slug}`,              lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
  ])

  const loc: MetadataRoute.Sitemap = locationSlugs.map((s) => ({
    url:             `${SITE}/locations/${s}`,
    lastModified:    now,
    changeFrequency: 'monthly',
    priority:        0.7,
  }))

  return [...top, ...brand, ...loc]
}
