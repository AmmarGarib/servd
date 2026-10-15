import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import {
  Inter, Bricolage_Grotesque, Syne, Amarante, Playfair_Display, JetBrains_Mono, Alfa_Slab_One, Poppins,
} from 'next/font/google'
import './globals.css'
import { StorefrontNav } from '../components/StorefrontNav'
import { StorefrontFooter } from '../components/StorefrontFooter'
import { FeedbackSlot } from '../components/feedback/FeedbackSlot'
import { PopupHost } from '../components/popups/PopupHost'
import { Analytics, type ConsentWords } from '../components/analytics/Analytics'
import { SERVD_ORIGIN, SERVD_OG_IMAGE, BRAND_HOST_HEADER } from '../lib/brandDomains'
import { ManagedPage } from '../sections/ManagedPage'
import { liveSectionFields } from '../sections/liveFields'
import { link, str } from '../sections/safe'
import { gaConfigured } from '../lib/analytics'
import { allKitsCss } from '../lib/brandKit'
import { getLiveKits } from '../lib/brandKitFetch'
// The share card's own alt and type (app/opengraph-image.tsx), restated below:
// an explicit openGraph.images replaces the file-based image metadata, which
// is what used to emit og:image:alt / og:image:type.
import { alt as servdOgImageAlt, contentType as servdOgImageType } from './opengraph-image'

// ── Fonts ────────────────────────────────────────────────────────────────────
// Self-hosted through next/font (downloaded from Google at BUILD time and
// served from /_next/static/media). This replaced a render-blocking Google
// Fonts @import in globals.css: HTML -> CSS -> fonts.googleapis.com -> gstatic,
// about 0.6 s of FCP/LCP on mobile.
//
// Same families, weights and styles as that import, so the same font files:
// each family is exposed as a CSS variable on <html>, and every font token in
// globals.css (--font-display, --simmer-display, --stackd-*, --flipd-* …)
// points at one. Use the tokens, never a family name.
//
// - Only servd's own UI fonts are preloaded (latin subset): Inter (body),
//   Bricolage Grotesque (display), Syne (the servd. wordmark). The brand-only
//   families load when a brand page actually uses them.
// - adjustFontFallback is off: its size-adjusted local('Arial') fallback would
//   sit in front of each token's own fallbacks, so characters a font does not
//   cover (→, ★ …) would draw in Arial instead of the token's next family.
// - Bricolage loads as its variable font, because next/font only takes the
//   opsz axis (the optical sizes the display headlines rely on) with the
//   variable weight range. See the note at --font-display in globals.css.
const inter = Inter({
  weight: ['400', '500', '600', '700', '800', '900'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  adjustFontFallback: false,
})
const bricolage = Bricolage_Grotesque({
  weight: 'variable',
  axes: ['opsz'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-bricolage',
  adjustFontFallback: false,
})
const syne = Syne({
  weight: ['400', '600', '700', '800'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-syne',
  adjustFontFallback: false,
})
// Brand-only families (Simmer, Stackd, Flipd) — not preloaded.
const amarante = Amarante({
  weight: '400',
  display: 'swap',
  variable: '--font-amarante',
  preload: false,
  adjustFontFallback: false,
})
const playfair = Playfair_Display({
  weight: ['500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-playfair',
  preload: false,
  adjustFontFallback: false,
})
const jetbrainsMono = JetBrains_Mono({
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
  preload: false,
  adjustFontFallback: false,
})
const alfaSlab = Alfa_Slab_One({
  weight: '400',
  display: 'swap',
  variable: '--font-alfa-slab',
  preload: false,
  adjustFontFallback: false,
})
const poppins = Poppins({
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-poppins',
  preload: false,
  adjustFontFallback: false,
})
const fontVariables = [inter, bricolage, syne, amarante, playfair, jetbrainsMono, alfaSlab, poppins]
  .map((f) => f.variable)
  .join(' ')

// Search Console meta-tag verification — optional (a DNS TXT record is the
// preferred way to verify). A server-side env var, read when the server starts
// rather than baked in at build (every page here renders dynamically), so
// setting GOOGLE_SITE_VERIFICATION in the storefront container's environment
// and restarting it is enough — no image rebuild. Unset: no tag.
const googleSiteVerification = process.env['GOOGLE_SITE_VERIFICATION']?.trim() || undefined

// Bing Webmaster Tools meta-tag verification (msvalidate.01), same model as the
// Google one: BING_SITE_VERIFICATION (container env, read at start) wins; the
// build-time NEXT_PUBLIC_ copy is only a fallback, because the image build bakes
// it in as '' and an empty value counts as unset. Unset = no tag. (BingSiteAuth.xml
// or a DNS CNAME also work; the tag is the no-file option.)
const bingSiteVerification =
  process.env['BING_SITE_VERIFICATION']?.trim() ||
  process.env['NEXT_PUBLIC_BING_SITE_VERIFICATION']?.trim() ||
  undefined

export const metadata: Metadata = {
  // Absolute base for og:image / canonical resolution. SERVD_ORIGIN is the one
  // source for the public host; override it with NEXT_PUBLIC_SITE_URL per env.
  metadataBase: new URL(SERVD_ORIGIN),
  title: { default: 'servd — order from your favourite kitchens', template: '%s · servd' },
  description: 'One place to order from Simmer, Stackd, and Flipd. Explore the kitchens and join Insiders for rewards on every order.',
  applicationName: 'servd',
  formatDetection: { telephone: false, email: false, address: false },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'servd' },
  // The share-card base. No title or description here on purpose: Next fills
  // og:title / og:description (and twitter:*) from each page's own title and
  // description only when openGraph does not set them, so a hard-coded 'servd'
  // here made every page — brand domains included — preview as 'servd'.
  // No `robots` either: indexing is the default, and a forced 'index, follow'
  // was inherited by private/token pages and doubled up with noindex on 404s.
  openGraph: {
    type: 'website',
    siteName: 'servd',
    locale: 'en_PK',
    images: [{ url: SERVD_OG_IMAGE, width: 1200, height: 630, alt: servdOgImageAlt, type: servdOgImageType }],
  },
  twitter: { card: 'summary_large_image' },
  ...(googleSiteVerification || bingSiteVerification
    ? {
        verification: {
          ...(googleSiteVerification ? { google: googleSiteVerification } : {}),
          // Bing Webmaster Tools meta tag: <meta name="msvalidate.01" content="…">
          ...(bingSiteVerification ? { other: { 'msvalidate.01': bingSiteVerification } } : {}),
        },
      }
    : {}),
}

export const viewport: Viewport = {
  themeColor: '#ffffff',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
}

export default async function StorefrontLayout({ children }: { children: React.ReactNode }) {
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
  // Brand kits (Admin → Storefront → Brand kit): the ONE definition of every
  // brand's tokens (--simmer-* / --stackd-* / --flipd-* and the --kit-<slug>-*
  // roles), defaults ⊕ the published kits. Injected for every page so brand
  // pages, ordering skins, checkout, the tracker and servd.pk's cross-brand
  // tiles all follow. API down → {} → the defaults, which are in code.
  const brandKitCss = allKitsCss(await getLiveKits())
  // The cookie notice's words: the servd footer section's consent fields
  // (Admin → Storefront → Footer). Only read when GA is configured — without
  // it the notice never renders.
  const consentWords = gaConfigured() ? consentWordsOf(await liveSectionFields('servd:footer', 'servd.footer')) : undefined
  // The servd header and footer are content pages (`servd:header`,
  // `servd:footer` — Admin → Storefront), rendered here on the server and
  // handed to the client gates that hide them on brand microsites and the
  // pages that carry their own chrome. So is the floating feedback button
  // (`servd:feedback`); its gate only keeps it off /preview, which renders
  // the draft itself.
  return (
    <html lang="en" className={fontVariables}>
      <head>
        {/* Generated from validated hex and built-in stacks only (lib/brandKit.ts). */}
        <style id="servd-brand-kits" dangerouslySetInnerHTML={{ __html: brandKitCss }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-black focus:text-white focus:px-3 focus:py-2 focus:rounded"
        >
          Skip to content
        </a>
        {/* Storefront pop-ups. Mounted above the header so a 'bar' pop-up sits
            in flow at the very top; modal / corner are fixed. */}
        <PopupHost initialBrandSlug={initialBrandSlug} />
        <StorefrontNav initialBrandSlug={initialBrandSlug}>
          <ManagedPage slug="servd:header" />
        </StorefrontNav>
        {/* GA4 + consent notice. Renders nothing without NEXT_PUBLIC_GA4_ID. */}
        <Analytics initialBrandSlug={initialBrandSlug} words={consentWords} />
        <main id="main">{children}</main>
        <StorefrontFooter initialBrandSlug={initialBrandSlug}>
          <ManagedPage slug="servd:footer" />
        </StorefrontFooter>
        <FeedbackSlot>
          <ManagedPage slug="servd:feedback" />
        </FeedbackSlot>
      </body>
    </html>
  )
}

/** The consent notice's words from the servd footer section's fields. */
function consentWordsOf(f: Record<string, unknown>): ConsentWords {
  const l = link(f['consentLink'])
  return {
    text: str(f['consentText']),
    linkText: l.text,
    linkHref: l.href,
    decline: str(f['consentDecline']),
    accept: str(f['consentAccept']),
  }
}
