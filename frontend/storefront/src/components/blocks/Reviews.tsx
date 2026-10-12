import type { ReviewsBlock } from '../../lib/blocks'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface ReviewsResp {
  reviews: Array<{ id: string; rating: number; comment: string | null; createdAt: string; customerName: string }>
  average: number | null
  total: number
}

export async function Reviews({ block, fallbackSlug }: { block: ReviewsBlock; fallbackSlug?: string }) {
  const slug = block.conceptSlug ?? fallbackSlug
  if (!slug) return null

  let data: ReviewsResp | null = null
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/${encodeURIComponent(slug)}/reviews`, { next: { revalidate: 120 } })
    if (res.ok) data = await res.json() as ReviewsResp
  } catch { /* nope */ }

  if (!data || data.total === 0) return null

  const visible = data.reviews.slice(0, block.max ?? 6)

  return (
    <div className="container">
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
          Customer reviews
        </p>
        {block.showRating !== false && data.average !== null && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '2.25rem', fontWeight: 900, letterSpacing: '-0.02em' }}>
              {data.average.toFixed(1)}
            </span>
            <span aria-hidden="true" style={{ fontSize: '1.25rem', color: 'var(--servd-green-dark)' }}>
              {'★'.repeat(Math.round(data.average))}{'☆'.repeat(5 - Math.round(data.average))}
            </span>
          </div>
        )}
        <p style={{ color: 'var(--servd-mute)' }}>Based on {data.total} verified order{data.total === 1 ? '' : 's'}</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1.25rem' }}>
        {visible.map((r) => (
          <article key={r.id} className="servd-card" style={{ padding: '1.4rem' }}>
            <div aria-label={`${r.rating} out of 5`} style={{ color: 'var(--servd-green-dark)', fontSize: '1rem', marginBottom: '0.75rem' }}>
              {'★'.repeat(r.rating)}<span style={{ color: 'rgba(0,0,0,0.15)' }}>{'★'.repeat(5 - r.rating)}</span>
            </div>
            {r.comment && (
              <p style={{ color: 'var(--servd-ink)', fontSize: '0.95rem', lineHeight: 1.5, marginBottom: '1rem' }}>
                &ldquo;{r.comment}&rdquo;
              </p>
            )}
            <p style={{ color: 'var(--servd-dim)', fontSize: '0.8rem' }}>
              {r.customerName} · {new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </p>
          </article>
        ))}
      </div>
    </div>
  )
}
