import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import 'lenis/dist/lenis.css'
import './globals.css'
import { StorefrontNav } from '../components/StorefrontNav'
import { StorefrontFooter } from '../components/StorefrontFooter'
import { FeedbackWidget } from '../components/feedback/FeedbackWidget'
import { SmoothScroll } from '../components/ui/SmoothScroll'
import { PlayLayer } from '../components/play/PlayLayer'
import { SERVD_ORIGIN, BRAND_HOST_HEADER } from '../lib/brandDomains'

export const metadata: Metadata = {
  // Absolute base for og:image / canonical resolution. SERVD_ORIGIN is the one
  // source for the public host; override it with NEXT_PUBLIC_SITE_URL per env.
  metadataBase: new URL(SERVD_ORIGIN),
  title: { default: 'servd — order from your favourite kitchens', template: '%s · servd' },
  description: 'One place to order from simmer, stackd, and Flipd. Explore the kitchens and join Insiders for rewards on every order.',
  applicationName: 'servd',
  formatDetection: { telephone: false, email: false, address: false },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'servd' },
  openGraph: {
    type: 'website',
    siteName: 'servd',
    title: 'servd',
    description: 'Order from your favourite kitchens, explore the brands, and join Insiders.',
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: '#4E2A4F',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
}

export default function StorefrontLayout({ children }: { children: React.ReactNode }) {
  // Which brand domain this request came in on, if any.
  //
  // A brand microsite carries its own header — the badge and its nav pill —
  // and must not also get the servd one stacked on top of it. On /brand/<slug>
  // the servd header hides itself by path, but on a brand's own domain the
  // path the client sees is "/", so it cannot: the domain is served by an
  // internal rewrite that the browser never sees. Only the server knows, so
  // the middleware stamps the slug on the request and it is read here.
  //
  // It is passed DOWN as a seed rather than used to decide here. A layout
  // renders once per document load and never re-renders on client-side
  // navigation, so deciding here freezes the answer to whatever URL was first
  // hard-loaded — which broke navigation in both directions. The header
  // component owns the decision and re-evaluates it on every navigation.
  //
  // Reading a request header makes the layout dynamic, which is right for this
  // app: it is a live ordering storefront, and the brand pages already opt out
  // of static rendering anyway (see the fetch-caching note in CLAUDE.md).
  const initialBrandSlug = headers().get(BRAND_HOST_HEADER)
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-black focus:text-white focus:px-3 focus:py-2 focus:rounded"
        >
          Skip to content
        </a>
        <StorefrontNav initialBrandSlug={initialBrandSlug} />
        <main id="main">{children}</main>
        <StorefrontFooter initialBrandSlug={initialBrandSlug} />
        <FeedbackWidget />
        <PlayLayer />
        <SmoothScroll />
      </body>
    </html>
  )
}
