'use client'
import Link from 'next/link'

interface SampleItem {
  emoji: string
  title: string
  hint: string
}

interface Props {
  icon: string
  title: string
  description: string
  primaryAction?: { label: string; onClick?: () => void; href?: string }
  secondaryAction?: { label: string; href: string }
  samples?: SampleItem[]                 // Inline example tiles to show "what good looks like"
  whyItMatters?: string                  // One-line value prop
  variant?: 'page' | 'inline'            // page = full-screen empty; inline = inside a section
}

/**
 * Reusable empty-state component. Always shows a path forward — primary CTA,
 * sample tiles (so users see what's possible), and a value-prop explanation.
 * Replaces dead-end "no data" blocks with an actionable, on-brand surface.
 */
export function EmptyStateGuide({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  samples,
  whyItMatters,
  variant = 'page',
}: Props) {
  const isPage = variant === 'page'
  return (
    <div className={isPage ? 'min-h-[60vh] flex items-center justify-center p-8' : 'p-6'}>
      <div className={`w-full ${isPage ? 'max-w-xl' : 'max-w-md'} text-center`}>
        <span className="text-5xl">{icon}</span>
        <h2 className="mt-3 text-xl font-black text-kds-text">{title}</h2>
        <p className="mt-2 text-sm text-kds-subtext leading-relaxed">{description}</p>

        {whyItMatters && (
          <div
            className="mt-5 rounded-xl px-4 py-3 text-left text-xs text-kds-text/80"
            style={{ background: 'rgba(0,212,177,0.06)', border: '1px solid rgba(0,212,177,0.18)' }}
          >
            <span className="font-bold text-kds-green">Why it matters: </span>
            {whyItMatters}
          </div>
        )}

        {samples && samples.length > 0 && (
          <div className="mt-5">
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-kds-subtext mb-2">
              Examples to get you going
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {samples.map((s) => (
                <div
                  key={s.title}
                  className="rounded-xl p-3 text-left"
                  style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  <p className="text-2xl mb-1">{s.emoji}</p>
                  <p className="text-sm font-bold text-kds-text">{s.title}</p>
                  <p className="text-xs text-kds-subtext mt-0.5 leading-tight">{s.hint}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {primaryAction && (
            primaryAction.href ? (
              <Link
                href={primaryAction.href}
                className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90"
              >
                {primaryAction.label} →
              </Link>
            ) : (
              <button
                onClick={primaryAction.onClick}
                className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90"
              >
                {primaryAction.label} →
              </button>
            )
          )}
          {secondaryAction && (
            <Link
              href={secondaryAction.href}
              className="rounded-xl border border-kds-border px-4 py-2.5 text-sm text-kds-subtext hover:text-kds-text"
            >
              {secondaryAction.label}
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
