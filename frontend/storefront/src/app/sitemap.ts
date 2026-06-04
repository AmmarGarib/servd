import type { MetadataRoute } from 'next'
import { BRAND_LOCATIONS } from '../lib/brandLocations'

// Sitemap covers every customer-facing URL Google + LLMs need to crawl.
// Per the local-seo + ai-seo skills: without a sitemap, AI surfaces and
// Google can't index the per-brand pages efficiently. Excludes account /
// checkout / order trackers — those are post-auth and have no SEO value.

const SITE = 'https://servd-app.garibsons.app'
const now  = new Date()

export default function sitemap(): MetadataRoute.Sitemap {
  const brandSlugs = Object.keys(BRAND_LOCATIONS)
  const locationSlugs = Object.values(BRAND_LOCATIONS).map((b) => b.locationSlug)

  const top: MetadataRoute.Sitemap = [
    { url: `${SITE}/`,        lastModified: now, changeFrequency: 'daily',   priority: 1.0 },
    { url: `${SITE}/browse`,  lastModified: now, changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${SITE}/reserve`, lastModified: now, changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${SITE}/press`,   lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
  ]

  const brand: MetadataRoute.Sitemap = brandSlugs.flatMap((slug) => [
    { url: `${SITE}/brand/${slug}`,        lastModified: now, changeFrequency: 'weekly',  priority: 0.9 },
    { url: `${SITE}/brand/${slug}/menu`,   lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
    { url: `${SITE}/brand/${slug}/visit`,  lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
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
