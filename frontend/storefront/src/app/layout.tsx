import type { Metadata, Viewport } from 'next'
import './globals.css'
import { StorefrontNav } from '../components/StorefrontNav'
import { StorefrontFooter } from '../components/StorefrontFooter'
import { FeedbackWidget } from '../components/feedback/FeedbackWidget'
import { CursorFX } from '../components/ui/CursorFX'
import { ScrollDock } from '../components/ui/ScrollDock'

export const metadata: Metadata = {
  // Absolute base for og:image / canonical resolution. Single source for the
  // public host — flip via NEXT_PUBLIC_SITE_URL when the domain moves to servd.pk.
  metadataBase: new URL(process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://servd-app.garibsons.app'),
  title: { default: 'servd — order from your favourite kitchens', template: '%s · servd' },
  description: 'One place to order from simmer, Stax, and Flipd. Explore the kitchens and join Insiders for rewards on every order.',
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
        {/* Ambient layers — film grain over every surface, the food
            scroll-dock in place of the native scrollbar, cursor FX. */}
        <div aria-hidden className="grain-overlay" />
        <ScrollDock />
        <CursorFX />
      </body>
    </html>
  )
}
