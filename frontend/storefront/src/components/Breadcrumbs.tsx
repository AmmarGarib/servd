// Breadcrumbs: a small visible trail AND the BreadcrumbList JSON-LD for it, so
// the two can never disagree. A server component.
//
//   <Breadcrumbs origin={brandOrigin(slug)} items={[
//     { name: 'Simmer', href: '/' },
//     { name: 'Menu',   href: '/menu' },
//   ]} />
//
// `origin` is the page's canonical origin (https://simmer.pk, https://servd.pk):
// a relative href is resolved against it for the JSON-LD, so the structured
// data always carries canonical absolute URLs (never a redirecting one). An
// absolute href is used as given. The LAST item is the page itself — shown as
// plain text (aria-current="page"), not a link.
//
// Style: quiet and inherited. Text takes the page's own colour (currentColor,
// dimmed), so it works inside a brand page without ever bringing servd's
// colours onto a brand. Pages that already emit their own BreadcrumbList must
// drop it when they use this, or Google sees two.

import { breadcrumbSchema, jsonLdScript } from '../lib/jsonLd'

export interface Crumb {
  name: string
  href: string
}

export function absoluteCrumbUrl(href: string, origin: string): string {
  if (/^https?:\/\//i.test(href)) return href
  const base = origin.replace(/\/+$/, '')
  return `${base}${href.startsWith('/') ? href : `/${href}`}`
}

export function Breadcrumbs({
  items,
  origin = '',
  jsonLd = true,
  className,
}: {
  items: Crumb[]
  origin?: string
  /** false = the trail only (the page emits its own BreadcrumbList). */
  jsonLd?: boolean
  className?: string
}) {
  if (items.length === 0) return null
  const schema = breadcrumbSchema(items.map((it) => ({ name: it.name, url: absoluteCrumbUrl(it.href, origin) })))
  return (
    <>
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />}
      <nav aria-label="Breadcrumb" className={className}>
        <ol
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '0.35rem',
            listStyle: 'none',
            margin: 0,
            padding: '0.75rem 1rem',
            maxWidth: '72rem',
            marginInline: 'auto',
            fontSize: '0.8125rem',
            lineHeight: 1.4,
            color: 'inherit',
          }}
        >
          {items.map((it, i) => {
            const last = i === items.length - 1
            return (
              <li key={`${it.href}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                {last ? (
                  <span aria-current="page" style={{ opacity: 0.9 }}>{it.name}</span>
                ) : (
                  <a href={it.href} style={{ color: 'inherit', opacity: 0.65, textDecoration: 'underline', textUnderlineOffset: '0.2em' }}>
                    {it.name}
                  </a>
                )}
                {!last && <span aria-hidden="true" style={{ opacity: 0.4 }}>/</span>}
              </li>
            )
          })}
        </ol>
      </nav>
    </>
  )
}
