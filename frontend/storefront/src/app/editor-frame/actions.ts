'use server'

// The editor frame's one server action: render the operator's posted working
// copy through the LIVE renderers and return the React tree (RSC) to the
// frame. Exports only async functions ('use server').
//
// It never reads drafts, cookies or staff auth and never writes anything: it
// renders only what it is given plus public data the live page already reads.
// Because that input is unauthenticated it is sanitised (src/editor/
// sanitize.ts), bounded (src/editor/limits.ts: MAX_IN_FLIGHT renders server-
// wide, each slot held until its tree has streamed; 240/min per IP; every
// composition fetch time-limited) and never logged — on failure the server log
// gets the code, slug, size, a reference and the exception message; the caller
// gets only the generic text and the reference.

import { createElement } from 'react'
import { headers } from 'next/headers'
import { FrameDocument, loadFrameData } from '../../editor/FrameDocument'
import { acquireRenderSlot, clientIp } from '../../editor/limits'
import { revOf, sanitizeFrameInput, type SanitizeResult } from '../../editor/sanitize'
import { RENDER_ERROR_TEXT, type FrameRenderResult } from '../../editor/types'

export async function renderEditorFrame(input: unknown): Promise<FrameRenderResult> {
  let ip = 'local'
  try { ip = clientIp(await headers()) } catch { /* outside a request */ }
  const slot = acquireRenderSlot(ip)
  if (!slot) return { ok: false, rev: revOf(input), code: 'RATE_LIMITED', error: RENDER_ERROR_TEXT.RATE_LIMITED }

  // The tree is rendered by React while the response streams, after this
  // returns: on success the slot is held until then (limits.ts), otherwise it
  // is given back in `finally`.
  let streaming = false
  let checked: SanitizeResult | null = null
  try {
    checked = sanitizeFrameInput(input)
    if (!checked.ok) return { ok: false, rev: checked.rev, code: checked.code, error: RENDER_ERROR_TEXT[checked.code] }
    const { value } = checked
    if (value.parsed.kind === 'popup') {
      return { ok: false, rev: value.rev, code: 'BAD_INPUT', error: RENDER_ERROR_TEXT.BAD_INPUT }
    }
    const data = await loadFrameData(value)
    const node = createElement(FrameDocument, { data, variant: value.variant })
    slot.hold()
    streaming = true
    return { ok: true, rev: value.rev, node }
  } catch (e) {
    // The exception text stays in the server log: it can name internal hosts.
    const ref = errorRef()
    console.error('[editor-frame] render failed', {
      code: 'RENDER', ref,
      slug: checked?.ok ? checked.value.slug : '?',
      bytes: checked?.bytes ?? 0,
      message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    })
    return { ok: false, rev: checked?.ok ? checked.value.rev : revOf(input), code: 'RENDER', error: `${RENDER_ERROR_TEXT.RENDER} (ref ${ref})` }
  } finally {
    if (!streaming) slot.release()
  }
}

/** A short reference that ties an operator's error to its server log line. */
function errorRef(): string {
  const a = new Uint8Array(4)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}
