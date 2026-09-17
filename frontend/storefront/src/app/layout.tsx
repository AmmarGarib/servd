import type { Metadata, Viewport } from 'next'
import './globals.css'
import { StorefrontNav } from '../components/StorefrontNav'
import { StorefrontFooter } from '../components/StorefrontFooter'
import { FeedbackWidget } from '../components/feedback/FeedbackWidget'
import { SERVD_ORIGIN } from '../lib/brandDomains'

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
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-black focus:text-white focus:px-3 focus:py-2 focus:rounded"
        >
          Skip to content
        </a>
        <StorefrontNav />
        <main id="main">{children}</main>
        <StorefrontFooter />
        <FeedbackWidget />
      </body>
    </html>
  )
}
