'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { Concept } from '../../lib/concept'
import { useBrandSlug, getServdHost } from '../../lib/host'

// Build a link that points to the servd canonical host. On the servd host
// itself it stays relative (so client-side navigation kicks in). On a brand
// custom domain it resolves to the absolute servd URL — otherwise the link
// would loop back to the brand microsite (middleware rewrites `/` on a brand
// host to /brand/<slug>).
function servdHref(path: string, onBrandHost: boolean): string {
  if (!onBrandHost) return path
  const host = getServdHost()
  return host ? `${host}${path}` : path
}

interface Props {
  concept: Concept
  children: React.ReactNode
}

export function BrandShell({ concept, children }: Props) {
  const onBrandHost = useBrandSlug() !== null
  return (
    <>
      <BrandNav concept={concept} onBrandHost={onBrandHost} />
      {children}
      <BrandFooter concept={concept} onBrandHost={onBrandHost} />
    </>
  )
}

function BrandNav({ concept, onBrandHost }: { concept: Concept; onBrandHost: boolean }) {
  const pathname = usePathname() ?? ''
  const base = `/brand/${concept.slug}`
  const servdHome = servdHref('/', onBrandHost)

  const links = [
    { href: base,                       label: 'Home' },
    { href: `${base}/menu`,             label: 'Menu' },
    { href: `${base}/about`,            label: 'Story' },
    { href: `/reserve/${concept.slug}`, label: 'Book' },
    { href: `${base}/visit`,            label: 'Visit' },
  ]

  return (
    <nav
      aria-label={`${concept.name} navigation`}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        borderBottom: '1px solid var(--servd-line)',
        padding: '0.85rem clamp(1rem, 4vw, 2rem)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
      }}
    >
      <Link href={base} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', textDecoration: 'none', color: 'inherit' }}>
        <span aria-hidden="true" style={{
          width: '2rem',
          height: '2rem',
          borderRadius: '0.5rem',
          background: 'var(--servd-green-dark)',
          color: 'white',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1rem',
          fontWeight: 900,
        }}>
          {concept.name.charAt(0)}
        </span>
        <span style={{ fontSize: '1.15rem', fontWeight: 800, letterSpacing: '-0.02em' }}>
          {concept.name}
        </span>
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
        {links.map((l) => {
          const active = l.href === '/brand/' + concept.slug
            ? pathname === l.href
            : pathname.startsWith(l.href)
          return (
            <Link
              key={l.href}
              href={l.href}
              style={{
                padding: '0.45rem 0.85rem',
                color: active ? 'var(--servd-black)' : 'var(--servd-mute)',
                fontWeight: active ? 700 : 500,
                fontSize: '0.9rem',
                textDecoration: 'none',
                borderRadius: '0.5rem',
              }}
              className="hidden sm:inline-block"
            >
              {l.label}
            </Link>
          )
        })}

        <Link
          href={`/${concept.slug}`}
          aria-label={`Order from ${concept.name}`}
          className="brand-cta"
          style={{
            background: 'var(--servd-black)',
            color: 'white',
            fontWeight: 800,
            fontSize: '0.875rem',
            padding: '0.55rem 1.1rem',
            borderRadius: '999px',
            textDecoration: 'none',
            marginLeft: '0.5rem',
          }}
        >
          Order →
        </Link>

        <Link
          href={servdHome}
          style={{
            color: 'var(--servd-dim)',
            fontSize: '0.75rem',
            fontWeight: 500,
            padding: '0.45rem 0.5rem',
            textDecoration: 'none',
          }}
          className="hidden md:inline-block"
        >
          on servd
        </Link>
      </div>
    </nav>
  )
}

function BrandFooter({ concept, onBrandHost }: { concept: Concept; onBrandHost: boolean }) {
  const servdHome   = servdHref('/',       onBrandHost)
  const servdBrowse = servdHref('/browse', onBrandHost)
  return (
    <footer style={{
      background: 'var(--servd-black)',
      color: 'rgba(255,255,255,0.75)',
      padding: 'clamp(2.5rem, 5vw, 4rem) 0 1.75rem',
      marginTop: '4rem',
    }}>
      <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '2rem' }}>
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 900, color: 'white', marginBottom: '0.5rem' }}>
            {concept.name}
          </div>
          <p style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.55)', maxWidth: '20rem' }}>
            {concept.description}
          </p>
        </div>

        <div>
          <h3 style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            {concept.name}
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.5rem' }}>
            <li><Link href={onBrandHost ? '/menu'  : `/brand/${concept.slug}/menu`}  style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.875rem' }}>Menu</Link></li>
            <li><Link href={onBrandHost ? '/about' : `/brand/${concept.slug}/about`} style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.875rem' }}>Our story</Link></li>
            <li><Link href={onBrandHost ? '/visit' : `/brand/${concept.slug}/visit`} style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.875rem' }}>Find us</Link></li>
            <li><Link href={`/${concept.slug}`} style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.875rem' }}>Order online</Link></li>
          </ul>
        </div>

        <div>
          <h3 style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            Powered by
          </h3>
          <Link href={servdHome} style={{
            display: 'inline-block',
            color: 'white',
            fontWeight: 900,
            fontSize: '1.5rem',
            letterSpacing: '-0.04em',
            textDecoration: 'none',
          }}>
            servd
          </Link>
          <p style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.45)', marginTop: '0.25rem' }}>
            One platform, every GS Foods kitchen.
          </p>
          <Link href={servdBrowse} style={{
            display: 'inline-block',
            marginTop: '0.85rem',
            color: 'var(--servd-green)',
            fontWeight: 600,
            fontSize: '0.85rem',
            textDecoration: 'none',
          }}>
            See all brands →
          </Link>
        </div>
      </div>

      <div className="container" style={{ marginTop: '2.5rem', paddingTop: '1.25rem', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
        <span>© {new Date().getFullYear()} {concept.name} · GS Foods Pvt. Ltd.</span>
        <Link href={servdHome} style={{ color: 'rgba(255,255,255,0.55)', textDecoration: 'none' }}>
          back to servd →
        </Link>
      </div>
    </footer>
  )
}
