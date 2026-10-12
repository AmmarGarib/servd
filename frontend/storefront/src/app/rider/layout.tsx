// servd.pk/rider — the web version of the rider app (docs/rider-app.md):
// sign in with a WhatsApp code, go on shift, carry jobs. Same API and flows as
// the native app in rider/; location is shared only while this page is open.
//
// Private tool, not a public page: noindex/nofollow here, disallowed in
// app/robots.ts, never in the sitemap. The servd header and footer stand down
// on /rider (components/StorefrontNav.tsx, StorefrontFooter.tsx) — the shell
// brings its own top bar.

import type { Metadata, Viewport } from 'next'
import { RiderShell } from './_components/RiderShell'

export const metadata: Metadata = {
  // Absolute: not "… · servd" from the root template.
  title: { absolute: 'servd rider' },
  description: 'For servd riders: sign in, go on shift and carry your deliveries.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
  alternates: { canonical: null },
  // Not the customer app: "Add to Home Screen" here must not install servd's
  // customer manifest (which opens /home).
  manifest: null,
  appleWebApp: { capable: true, title: 'servd rider', statusBarStyle: 'default' },
  formatDetection: { telephone: false, email: false, address: false },
}

export const viewport: Viewport = {
  // The rider top bar (--servd-purple). Browser chrome takes a literal colour,
  // not a CSS variable.
  themeColor: '#6a0dad',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
}

export default function RiderLayout({ children }: { children: React.ReactNode }) {
  return <RiderShell>{children}</RiderShell>
}
