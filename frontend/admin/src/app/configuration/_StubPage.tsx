'use client'
import Link from 'next/link'

interface Props {
  icon: string
  title: string
  description: string
  whyItMatters: string
  defaults: { label: string; value: string; hint?: string }[]
  comingSoon?: boolean
  primaryAction?: { label: string; href: string }
}

/**
 * Reusable placeholder for configuration sub-pages that aren't fully built yet.
 * Shows the icon, title, description, the placeholder defaults the system is
 * using right now, and a path forward — never a dead-end "coming soon" wall.
 */
export function ConfigStubPage({ icon, title, description, whyItMatters, defaults, comingSoon, primaryAction }: Props) {
  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-3xl">{icon}</span>
          <div>
            <h1 className="text-2xl font-black text-white/90">{title}</h1>
            <p className="text-sm text-white/40">{description}</p>
          </div>
        </div>
      </header>

      <div className="px-7 py-7 max-w-3xl space-y-6">
        {/* Why it matters */}
        <div className="rounded-2xl p-5"
          style={{ background: 'rgba(0,212,177,0.05)', border: '1px solid rgba(0,212,177,0.18)' }}>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-[#00D4B1]/70 mb-2">Why this matters</p>
          <p className="text-sm text-white/75 leading-relaxed">{whyItMatters}</p>
        </div>

        {/* Current defaults */}
        <div className="rounded-2xl"
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="px-5 py-3 border-b border-white/[0.05]">
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-white/40">Current defaults</p>
            <p className="text-xs text-white/35 mt-0.5">
              These values are baked in right now. You can tweak them once this section is wired up to the backend.
            </p>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {defaults.map((d) => (
              <div key={d.label} className="px-5 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white/80">{d.label}</p>
                  {d.hint && <p className="text-xs text-white/35 mt-0.5">{d.hint}</p>}
                </div>
                <span className="font-mono text-sm text-[#00D4B1] shrink-0">{d.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Status + primary action */}
        <div className="flex items-center justify-between gap-3 rounded-2xl p-4"
          style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
          <div>
            <p className="text-sm font-bold text-amber-400">{comingSoon ? 'Editor coming soon' : 'Read-only for now'}</p>
            <p className="text-xs text-white/45 mt-0.5">
              The system is running on these defaults. Edit support is on the roadmap.
            </p>
          </div>
          {primaryAction && (
            <Link
              href={primaryAction.href}
              className="rounded-xl bg-amber-400 px-4 py-2 text-xs font-black text-black hover:opacity-90 shrink-0"
            >
              {primaryAction.label} →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
