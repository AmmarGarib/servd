// /editor-frame — the live page inside Admin → Storefront (owner decision D4).
// The admin frames this route and posts the operator's unsaved working copy
// into it; the frame renders it through the real storefront renderers via a
// server action and draws selection outlines over it. See src/editor/README.md
// for the protocol and the security rules (framable only by ADMIN_ORIGINS —
// CSP set in the middleware; no draft ever fetched; nothing counted).
//
// Never indexed (this metadata + X-Robots-Tag in next.config.js). The root
// layout's servd nav, footer, feedback button and pop-ups stand down on this
// path (lib/editorFrame.ts); the frame draws its own copy of what belongs to
// the page being edited.

import type { Metadata } from 'next'
// Every section group's CSS and client sections, so they are in this route's
// manifest whatever the action's tree renders.
import '../../sections/brand/brand.css'
import '../../sections/simmer/simmer.css'
import '../../sections/simmer/crossBrand.css'
import '../../sections/stackd/stackd.css'
import '../../sections/servd/servd.css'
import '../../sections/renderers'
// …and every client component the action's tree can reference (BlockMarker,
// BrandShell, MotionRuntime, the block renderers), whether or not Next follows
// the 'use server' module's imports when it builds this route's manifest.
import '../../editor/FrameDocument'
import { adminOrigins } from '../../lib/adminOrigins'
import { EditorFrameClient } from '../../editor/EditorFrameClient'
import { renderEditorFrame } from './actions'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: { absolute: 'Editor preview' },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  alternates: { canonical: null },
}

export default function EditorFramePage() {
  return <EditorFrameClient render={renderEditorFrame} allowedOrigins={adminOrigins()} />
}
