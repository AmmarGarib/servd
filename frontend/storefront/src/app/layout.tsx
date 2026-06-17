import type { Metadata, Viewport } from 'next'
import './globals.css'
import { StorefrontNav } from '../components/StorefrontNav'
import { StorefrontFooter } from '../components/StorefrontFooter'
import { FeedbackWidget } from '../components/feedback/FeedbackWidget'

export const metadata: Metadata = {
  // Absolute base for og:image / canonical resolution. Single source for the
  // public host — flip via NEXT_PUBLIC_SITE_URL when the domain moves to servd.pk.
  metadataBase: new URL(process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://servd-app.garibsons.app'),
  title: { default: 'servd — order from your favourite kitchens', template: '%s · servd' },
  description: 'Three kitchens. One cart. Order direct from simmer, Stax, and Flipd — delivered fresh.',
  applicationName: 'servd',
  formatDetection: { telephone: false, email: false, address: false },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'servd' },
  openGraph: {
    type: 'website',
    siteName: 'servd',
    title: 'servd',
    description: 'Order directly from your favourite GS Foods brands.',
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: '#3A0E69',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
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
