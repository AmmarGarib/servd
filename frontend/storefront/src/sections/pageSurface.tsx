// The outer wrapper of each servd page — the ONE definition, used by the live
// routes (app/home, app/press, app/reserve, app/locations/[loc]) and by the
// editor frame (src/editor/FrameDocument.tsx), so the page in the editor and
// the live page cannot drift. A plain server component (no hooks). Never add
// overflow: hidden/auto here: it would break sticky headers and scroll effects.

import type { ReactNode } from 'react'

const SURFACE = { background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' } as const

export function PageSurface({ slug, children }: { slug: string; children: ReactNode }) {
  switch (slug) {
    case 'servd:home':
      return <div className="sv-home">{children}</div>
    case 'servd:press':
    case 'servd:location':
      return <div style={SURFACE}>{children}</div>
    case 'servd:reserve':
      return <div className="surface-bg" style={SURFACE}>{children}</div>
    default:
      return <>{children}</>
  }
}
