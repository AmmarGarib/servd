import type { Metadata, Viewport } from 'next'
import './globals.css'
import { StorefrontNav } from '../components/StorefrontNav'
import { StorefrontFooter } from '../components/StorefrontFooter'

export const metadata: Metadata = {
  title: { default: 'servd — order from your favourite kitchens', template: '%s · servd' },
  description: 'Seven kitchens. One cart. Order direct from Simmer, Stax, Strata, Flipd, Craveman, Garnish Station and more — delivered fresh.',
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
  themeColor: '#22c55e',
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
      </body>
    </html>
  )
}
