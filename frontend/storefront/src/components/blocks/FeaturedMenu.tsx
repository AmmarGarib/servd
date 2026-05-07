import type { FeaturedMenuBlock } from '../../lib/blocks'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface MenuItem { id: string; name: string; description: string | null; priceCents: number; imageUrl: string | null }
interface Cat { items: MenuItem[] }

const fmt = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

export async function FeaturedMenu({ block, fallbackSlug }: { block: FeaturedMenuBlock; fallbackSlug?: string }) {
  const slug = block.conceptSlug ?? fallbackSlug
  if (!slug) return null

  let items: MenuItem[] = []
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/${slug}/menu`, { next: { revalidate: 60 } })
    if (res.ok) {
      const cats: Cat[] = await res.json()
      for (const c of cats) for (const it of c.items ?? []) {
        items.push(it)
        if (items.length >= (block.max ?? 6)) break
      }
    }
  } catch { /* fall through to empty */ }

  if (items.length === 0) return null

  return (
    <div className="container">
      <div style={{ marginBottom: '1.75rem' }}>
        {block.kicker && (
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            {block.kicker}
          </p>
        )}
        {block.title && <h2 style={{ fontSize: 'clamp(1.6rem, 3.5vw, 2.4rem)' }}>{block.title}</h2>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.25rem' }}>
        {items.map((item) => (
          <article key={item.id} className="servd-card" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{
              aspectRatio: '4/3',
              background: item.imageUrl
                ? `url(${item.imageUrl}) center/cover`
                : `linear-gradient(135deg, var(--servd-green-soft) 0%, white 100%)`,
            }} />
            <div style={{ padding: '1.1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
              <h3 style={{ fontSize: '1rem', color: 'var(--servd-ink)' }}>{item.name}</h3>
              {item.description && (
                <p style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', lineHeight: 1.4 }}>{item.description}</p>
              )}
              <p style={{ fontWeight: 800, color: 'var(--servd-green-dark)', marginTop: '0.5rem' }}>{fmt(item.priceCents)}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
