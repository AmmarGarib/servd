import Link from 'next/link'

const BRANDS = [
  { slug: 'simmer',          name: 'Simmer' },
  { slug: 'stax',            name: 'Stax' },
  { slug: 'strata',          name: 'Strata' },
  { slug: 'flipd',           name: 'Flipd' },
  { slug: 'craveman',        name: 'Craveman' },
  { slug: 'garnish-station', name: 'Garnish Station' },
  { slug: 'stax-padel',      name: 'Stax @ Padel' },
]

export function StorefrontFooter() {
  return (
    <footer
      style={{
        background: 'var(--servd-black)',
        color: 'rgba(255,255,255,0.75)',
        padding: 'clamp(3rem, 5vw, 4.5rem) 0 2rem',
        marginTop: '4rem',
      }}
    >
      <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '2.5rem' }}>
        <div>
          <Link
            href="/"
            style={{
              fontSize: '1.75rem',
              fontWeight: 900,
              letterSpacing: '-0.04em',
              color: 'white',
              textDecoration: 'none',
              display: 'inline-block',
              marginBottom: '0.75rem',
            }}
          >
            servd
          </Link>
          <p style={{ fontSize: '0.9rem', maxWidth: '20rem', color: 'rgba(255,255,255,0.55)' }}>
            One platform. Every GS Foods kitchen. Order direct, no middlemen.
          </p>
        </div>

        <div>
          <h3 style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            Brands
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.55rem' }}>
            {BRANDS.map((b) => (
              <li key={b.slug}>
                <Link href={`/brand/${b.slug}`} style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.9rem' }}>
                  {b.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            Customer
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.55rem' }}>
            <li><Link href="/browse"  style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.9rem' }}>Browse all brands</Link></li>
            <li><Link href="/account" style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.9rem' }}>My account</Link></li>
            <li><Link href="/orders"  style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.9rem' }}>Order history</Link></li>
            <li><Link href="/login"   style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.9rem' }}>Sign in</Link></li>
          </ul>
        </div>

        <div>
          <h3 style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            Company
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.55rem' }}>
            <li><span style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.9rem' }}>GS Foods Pvt. Ltd.</span></li>
            <li><span style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.9rem' }}>Lahore · Pakistan</span></li>
            <li><a href="mailto:hello@servd.pk" style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'none', fontSize: '0.9rem' }}>hello@servd.pk</a></li>
          </ul>
        </div>
      </div>

      <div className="container" style={{ marginTop: '3rem', paddingTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
        <span>© {new Date().getFullYear()} GS Foods. All rights reserved.</span>
        <span>Built in Lahore.</span>
      </div>
    </footer>
  )
}
