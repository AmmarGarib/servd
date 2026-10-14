// Storefront editor <-> live frame protocol, v1 (D4 stage 1). Keep the two
// copies identical: frontend/storefront/src/editor/protocol.ts and
// frontend/admin/src/lib/editorProtocol.ts.
export const EDITOR_NS = 'servd-editor' as const
export const EDITOR_PROTOCOL = 1 as const
export const EDITOR_FRAME_PATH = '/editor-frame' as const
export const MAX_DOC_CHARS = 600_000

export type LayoutKindWire = 'page' | 'header' | 'footer' | 'widget' | 'popup'
export interface FrameRect { x: number; y: number; w: number; h: number }   // frame viewport CSS px
export interface FrameViewport { w: number; h: number; scrollY: number }

export interface FrameDoc {
  rev: number                                  // +1 per posted change, per session, starts at 1
  slug: string                                 // SiteLayout slug being edited
  kind: LayoutKindWire                         // kindForSlug(slug)
  title: string | null
  variant: 'a' | 'b'                           // which blocks to show when settings.ab exists
  blocks: unknown[]                            // the working copy's variant-A blocks (B lives in settings.ab.blocks)
  settings: Record<string, unknown> | null     // cleanSettings(...) output, as saved
  fonts: Array<{ family: string; url: string }> // library fonts used by the doc
  labels: Record<string, string>               // block id -> editor label (overlay chip)
  kit?: FrameKit                               // a brand's UNSAVED kit to preview the page with (Brand kit editor)
}

/** A brand kit as stored in settings.kit of `brand:<slug>:kit` (hex = #rrggbb;
 *  font = built-in id or 'library:<mediaAssetId>'; image = https URL or /brand/ path). */
export interface FrameBrandKit {
  v: 1
  palette?: Record<string, string>
  roles?: { accent?: string; surfaceBg?: string; surfaceText?: string; ordering?: string }
  fonts?: { display?: string; body?: string }
  images?: { logo?: string; wordmark?: string; mascot?: string; badge?: string }
}

/** The draft kit the frame paints with instead of that brand's live kit. Never saved or counted. */
export interface FrameKit {
  brand: string                                // the brand (concept) slug the kit belongs to
  kit: FrameBrandKit
  fonts?: Array<{ id: string; family: string; url: string }>   // Library fonts its 'library:<id>' refs name
}

interface Envelope { ns: typeof EDITOR_NS; v: typeof EDITOR_PROTOCOL }

export type AdminToFrame = Envelope & { from: 'admin' } & (
  | { type: 'init'; session: string; doc: FrameDoc; selectedId: string | null; mode: 'select' }
  | { type: 'doc'; session: string; doc: FrameDoc }
  | { type: 'select'; session: string; id: string | null; scroll: boolean }
  | { type: 'hover'; session: string; id: string | null }
  | { type: 'motion-preview'; session: string; id: string; progress: number | null }   // 0..1, null = back to live
  | { type: 'ping'; session: string }
)

export type FrameToAdmin = Envelope & { from: 'frame' } & (
  | { type: 'ready'; session: string | null; protocol: typeof EDITOR_PROTOCOL; scrollTimeline: boolean }
  | { type: 'rendered'; session: string; rev: number; ok: boolean; error: string | null; ids: string[]; ms: number }
  | { type: 'select'; session: string; id: string | null; rect: FrameRect | null; viewport: FrameViewport }
  | { type: 'hover'; session: string; id: string | null; rect: FrameRect | null; viewport: FrameViewport }
  | { type: 'context'; session: string; slug: string }
  | { type: 'motion-preview-ended'; session: string; id: string; reason: 'scrolled' | 'not-found' }
  | { type: 'error'; session: string | null; code: 'PROTOCOL' | 'TOO_LARGE' | 'BAD_DOC'; message: string }
)

function envelope(data: unknown, from: 'admin' | 'frame'): data is Envelope & { from: string; type: string } {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return d['ns'] === EDITOR_NS && d['v'] === EDITOR_PROTOCOL && d['from'] === from && typeof d['type'] === 'string'
}
export const isAdminMessage = (data: unknown): data is AdminToFrame => envelope(data, 'admin')
export const isFrameMessage = (data: unknown): data is FrameToAdmin => envelope(data, 'frame')
/** Same namespace but another protocol version (answer with error PROTOCOL). */
export function isForeignVersion(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as Record<string, unknown>)['ns'] === EDITOR_NS && (data as Record<string, unknown>)['v'] !== EDITOR_PROTOCOL
}
export function newSession(): string {
  const a = new Uint8Array(16); crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}
