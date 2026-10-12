// Storefront-internal shapes of the editor frame's server action
// (app/editor-frame/actions.ts). The wire protocol with the admin is
// ./protocol.ts; these never leave the storefront.

import type { ReactNode } from 'react'

export interface FrameRenderInput {
  rev: number
  /** The edited slug, or the context slug for a pop-up backdrop. */
  slug: string
  /** The operator's working copy; null = render `slug` live (pop-up backdrop). */
  edited: null | {
    title: string | null
    blocks: unknown[]
    settings: Record<string, unknown> | null
    fonts: Array<{ family: string; url: string }>
  }
  variant: 'a' | 'b'
}

export type FrameRenderCode = 'BAD_INPUT' | 'TOO_LARGE' | 'RATE_LIMITED' | 'RENDER'

export type FrameRenderResult =
  | { ok: true; rev: number; node: ReactNode }
  | { ok: false; rev: number; code: FrameRenderCode; error: string }

/** The operator-facing text for each failure (shown in the frame's banner and
 *  sent to the admin in `rendered.error`). */
export const RENDER_ERROR_TEXT: Record<FrameRenderCode, string> = {
  BAD_INPUT: "The editor sent something the page can't read.",
  TOO_LARGE: 'This page is too large to preview.',
  RATE_LIMITED: 'Too many updates at once; catching up.',
  RENDER: "Part of the page couldn't be drawn.",
}
