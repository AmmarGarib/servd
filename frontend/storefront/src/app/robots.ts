import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'

import { BRAND_ORIGIN, SERVD_ORIGIN, hostBrand } from '../lib/brandDomains'

// robots.txt, per host. Every brand domain (stackd.pk, simmer.pk, flipd.pk)
// names ITS OWN sitemap, which lists only that domain's URLs — the sitemap a
// brand's Search Console property can actually submit. servd.pk names
// servd's. Reading the Host makes this dynamic, so a cached copy can never
// hand one host's file to another.
//
// Disallowed: URLs that carry a token or a personal session — order trackers
// (/<brand>/order/<id>), reservation claim and confirm links, group-order
// codes, the cart hand-off (?cart=… / &cart=…), the signed-in pages, and
// servd.pk/rider (the riders' own app — also noindex in app/rider/layout.tsx
// and never in the sitemap). Not
// disallowed: checkout, the printable QR card and draft previews. Those are
// noindexed with an X-Robots-Tag header (next.config.js), and a crawler has to
// be allowed to fetch a page to see its noindex.


export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = headers().get('host') ?? ''
  const slug = await hostBrand(host)
  // Own-property check: a pattern host like constructor.servd.pk resolves to
  // the slug "constructor", which must not read Object.prototype.constructor
  // out of BRAND_ORIGIN.
  const origin = slug && Object.prototype.hasOwnProperty.call(BRAND_ORIGIN, slug) ? BRAND_ORIGIN[slug]! : SERVD_ORIGIN

  return {
    rules: [
      {
        userAgent: '*',
        allow:    ['/'],
        disallow: [
          '/*/order/', '/reserve/claim/', '/reserve/confirm/', '/group-order/',
          '/orders', '/account', '/login', '/signup',
          // The rider app's web version, and everything under it.
          '/rider',
          '/*cart=',
          // The storefront's own JSON (the admin's section catalogue).
          '/api/',
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  }
}
