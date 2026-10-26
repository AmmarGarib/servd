// 404 page. Browsers land here on any unmatched route — including stale brand
// slugs after a concept rename.
//
// Server-rendered: for a path that matches no route Next draws this inside the
// root layout with a 404 status and a <title>. A notFound() thrown from a page
// or layout is drawn by the browser instead (Next 14.2 sends a bare shell), so
// the middleware rewrites paths that are certainly not a brand onto an
// unmatched URL (lib/crawlGate.ts) to land here with the real HTML.
//
// On a brand's domain the middleware stamps the brand on the request
// (BRAND_HOST_HEADER) and the servd chrome is hidden, so this page names the
// brand and links back to ITS home, in the brand's own colours
// (--kit-<slug>-* tokens) — never servd's.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { BRAND_HOST_HEADER, SERVD_LINK_ORIGIN, brandCanonical } from '../lib/brandDomains'
import { formatBrandName } from '../lib/concept'
import { lookupConcept } from '../lib/liveConcepts'
import { NotFoundTitle } from './NotFoundTitle'

/** The brand domain this request came in on (stamped by the middleware). */
async function brandSlugOfRequest(): Promise<string | null> {
  const slug = (await headers()).get(BRAND_HOST_HEADER)
  return slug && /^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug) ? slug : null
}

async function brandNameOf(slug: string): Promise<string> {
  const { concept } = await lookupConcept(slug)
  return formatBrandName(concept?.name ?? slug)
}

export async function generateMetadata(): Promise<Metadata> {
  const slug = await brandSlugOfRequest()
  return {
    // `absolute`: a brand's 404 must not carry servd's '· servd' template.
    title: { absolute: slug ? `Page not found · ${await brandNameOf(slug)}` : 'Page not found · servd' },
    // Explicit, so a 404 never carries an inherited 'index, follow'.
    robots: { index: false, follow: true },
  }
}

export default async function NotFound() {
  const slug = await brandSlugOfRequest()
  const brand = slug ? await brandNameOf(slug) : null
  const kit = (role: string, fallback: string) => (slug ? `var(--kit-${slug}-${role}, ${fallback})` : fallback)
  return (
    <div
      style={{
        minHeight: '70dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '1.25rem',
        textAlign: 'center',
        // On a brand domain the page wears the brand's surface; on servd it
        // inherits the page (the servd tokens).
        ...(slug
          ? { background: kit('surface-bg', 'transparent'), color: kit('surface-text', 'inherit'), fontFamily: kit('body', 'inherit') }
          : {}),
      }}
    >
      <NotFoundTitle />
      <p style={{
        color: slug ? kit('surface-muted', 'inherit') : 'var(--servd-mute)',
        fontSize: 'clamp(0.7rem, 1.8vw, 0.85rem)',
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        margin: 0,
      }}>
        404
      </p>
      <h1 style={{
        fontSize: 'clamp(2rem, 6vw, 3.5rem)',
        fontWeight: 900,
        letterSpacing: '-0.04em',
        margin: 0,
        ...(slug ? { fontFamily: kit('display', 'inherit') } : {}),
      }}>
        We couldn&rsquo;t find that.
      </h1>
      <p style={{ color: slug ? kit('surface-muted', 'inherit') : 'var(--servd-mute)', maxWidth: '28rem', margin: 0 }}>
        {brand
          ? `That page isn’t on ${brand}. It may have moved, or the link may be old.`
          : 'The page may have moved, or the brand may no longer be on servd.'}
      </p>
      {slug && brand ? (
        // Back to the brand's own home (its own domain when it has one).
        <Link
          href={brandCanonical(slug)}
          style={{
            display: 'inline-block',
            background: kit('accent', 'currentColor'),
            color: kit('surface-bg', 'inherit'),
            fontWeight: 800,
            fontSize: '1rem',
            padding: '0.75rem 2rem',
            borderRadius: '999px',
            textDecoration: 'none',
            marginTop: '0.5rem',
          }}
        >
          Back to {brand}
        </Link>
      ) : (
        // servd's home is its root; the kitchens list is #kitchens (absolute
        // when this 404 is served on a domain that is not servd's).
        <Link
          href={`${SERVD_LINK_ORIGIN}/#kitchens`}
          style={{
            display: 'inline-block',
            background: 'var(--servd-green)',
            color: 'var(--servd-on-green)',
            fontWeight: 800,
            fontSize: '1rem',
            padding: '0.75rem 2rem',
            borderRadius: '999px',
            textDecoration: 'none',
            marginTop: '0.5rem',
          }}
        >
          See all brands
        </Link>
      )}
    </div>
  )
}
