import type { MetadataRoute } from 'next'

import { SERVD_ORIGIN } from '../lib/brandDomains'

const SITE = SERVD_ORIGIN

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        // Index every public marketing surface; keep auth + post-auth +
        // checkout off the crawl path (no SEO value, leaks tokens in URLs
        // for the order tracker).
        allow:    ['/'],
        disallow: [
          '/account', '/orders', '/login', '/signup',
          '/group-order/', '/*?cart=',
        ],
      },
    ],
    sitemap: `${SITE}/sitemap.xml`,
  }
}
