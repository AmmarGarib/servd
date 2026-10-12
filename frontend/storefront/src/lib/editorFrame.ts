// The editor frame route (/editor-frame): the live page inside Admin →
// Storefront (src/editor/README.md). A plain module — no 'use client', no
// imports — so the middleware (edge), the root layout's client gates and the
// server can all ask the same question.

export const EDITOR_FRAME_ROUTE = '/editor-frame'

/** True on the editor frame route itself (`/editor-frame` or `/editor-frame/`).
 *  Not for `/editor-frame-x` or `/editor-frame/x` — those are 404s. */
export function isEditorFramePath(pathname: string | null | undefined): boolean {
  return pathname === EDITOR_FRAME_ROUTE || pathname === `${EDITOR_FRAME_ROUTE}/`
}
