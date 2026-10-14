// The page the editor frame shows, composed in its REAL context with the live
// renderers: the draft (the operator's posted working copy) where the edited
// part sits, and the live layouts of everything around it — the servd header
// and footer, the brand shell and its chrome, the page behind a header,
// footer or feedback button. Server component, rendered by the frame's
// server action (app/editor-frame/actions.ts).
//
//   DRAFT = ManagedPage({ slug, layout: draft, previewVariant, editor: true })
//           → markers on its blocks (BlockMarker); an untouched page (no
//             blocks) shows its built-in design, unmarked
//   LIVE  = ManagedPage({ slug, layout: live, previewVariant: 'a' }) inside a
//           data-sv-context marker (a click offers that part's own editor)
//
// previewVariant on every part means no TrackedLayout anywhere, so nothing in
// the frame counts as a view or a conversion (SiteLayoutStat). No JSON-LD,
// view trackers, beacons or the search sheet. Nothing here reads a draft from
// the API: the draft is only what the editor posted.

import type { ReactNode } from 'react'
import type { SiteLayoutRead } from '../lib/blocks'
import { brandAccent, type Concept } from '../lib/concept'
import { kitCss, resolveKit, type LiveKits } from '../lib/brandKit'
import { getLiveKits } from '../lib/brandKitFetch'
import { fetchBrandLocations, isPublishableLocation } from '../lib/brandLocations'
import { findConcept } from '../lib/liveConcepts'
import { ManagedPage, defaultBlocks } from '../sections/ManagedPage'
import { PageSurface } from '../sections/pageSurface'
import { SiteLayoutView } from '../components/blocks/SiteLayoutView'
import { BrandShell } from '../components/brand/BrandShell'
import { BlockMarker } from './BlockMarker'
import { FETCH_TIMEOUT_MS, cachedConcepts, cachedLiveLayout, withTimeout } from './limits'
import type { FrameKitInput, ParsedSlug, SanitizedFrameInput } from './sanitize'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/** One part of the document: the draft, or a live layout around it. */
interface Part { slug: string; draft: SiteLayoutRead | null }

type Plan =
  | { family: 'servd'; header: Part; page: Part; footer: Part; widget: Part | null }
  | { family: 'brand'; brand: string; header: Part; page: Part; footer: Part }
  | { family: 'notice'; text: string }

/** Everything the document needs, fetched up front by the action (inside its
 *  render slot): the live layouts of the parts not being edited, the brand
 *  list, and the location a servd:location draft previews. */
export interface FrameData {
  plan: Plan
  concepts: Concept[]
  live: Record<string, SiteLayoutRead>
  /** servd:location: the location shown; null = none to preview. */
  loc?: string | null
  /** The brand kit editor's draft kit (overrides that brand's live kit). */
  kit?: FrameKitInput | null
  /** Live kits with the draft kit laid over them (what every part themes with). */
  kits?: LiveKits
}

const live = (slug: string): Part => ({ slug, draft: null })

function planFor(parsed: ParsedSlug, slug: string, draft: SiteLayoutRead | null): Plan {
  const edited: Part = { slug, draft }
  switch (parsed.prefix) {
    case 'popup':
      return { family: 'notice', text: 'Pop-ups are drawn over a page, not on their own.' }
    case 'page':
      return { family: 'servd', header: live('servd:header'), page: edited, footer: live('servd:footer'), widget: null }
    case 'servd':
      if (parsed.kind === 'header') return { family: 'servd', header: edited, page: live('servd:home'), footer: live('servd:footer'), widget: null }
      if (parsed.kind === 'footer') return { family: 'servd', header: live('servd:header'), page: live('servd:home'), footer: edited, widget: null }
      if (parsed.kind === 'widget') return { family: 'servd', header: live('servd:header'), page: live('servd:home'), footer: live('servd:footer'), widget: edited }
      return { family: 'servd', header: live('servd:header'), page: edited, footer: live('servd:footer'), widget: null }
    case 'brand': {
      const b = parsed.brand
      const base = `brand:${b}`
      if (parsed.kind === 'header') return { family: 'brand', brand: b, header: edited, page: live(base), footer: live(`${base}:footer`) }
      if (parsed.kind === 'footer') return { family: 'brand', brand: b, header: live(`${base}:header`), page: live(base), footer: edited }
      return { family: 'brand', brand: b, header: live(`${base}:header`), page: edited, footer: live(`${base}:footer`) }
    }
  }
}

const emptyRead = (slug: string): SiteLayoutRead => ({
  slug, kind: 'page', title: null, version: 0, blocks: null, settings: null, fonts: [], publishedAt: null, updatedAt: null,
})

/** The first publishable location (by name), for a servd:location draft.
 *  Bounded: a hung API means no location (the page's own empty state). */
async function previewLocation(): Promise<string | null> {
  const all = Object.values(await withTimeout(fetchBrandLocations(API_URL), FETCH_TIMEOUT_MS, {}))
  const first = all
    .filter((l) => l && isPublishableLocation(l))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))[0]
  return first?.locationSlug ?? null
}

export async function loadFrameData(input: SanitizedFrameInput): Promise<FrameData> {
  const plan = planFor(input.parsed, input.slug, input.draft)
  const [concepts, liveKits] = await Promise.all([cachedConcepts(), getLiveKits()])
  if (plan.family === 'notice') return { plan, concepts, live: {} }
  // A draft kit replaces only its own brand's live kit, for this render only.
  const kitPart = input.kit ? { kit: input.kit, kits: { ...liveKits, [input.kit.brand]: input.kit.entry } } : {}
  if (plan.family === 'brand' && !findConcept(plan.brand, concepts)) {
    return { plan: { family: 'notice', text: 'This brand is not on the storefront.' }, concepts, live: {} }
  }
  const parts = [plan.header, plan.page, plan.footer, ...(plan.family === 'servd' && plan.widget ? [plan.widget] : [])]
  const liveSlugs = parts.filter((p) => !p.draft).map((p) => p.slug)
  const reads = await Promise.all(liveSlugs.map((s) => cachedLiveLayout(s)))
  const liveMap: Record<string, SiteLayoutRead> = {}
  liveSlugs.forEach((s, i) => { liveMap[s] = reads[i] ?? emptyRead(s) })
  const data: FrameData = { plan, concepts, live: liveMap, ...kitPart }
  if (plan.page.slug === 'servd:location') data.loc = await previewLocation()
  return data
}

const visibleBlocks = (r: SiteLayoutRead | null) => (r?.blocks ?? []).some((b) => b && !b.hidden)

/** An editor-only note (never on a live page). */
function FrameNote({ children }: { children: ReactNode }) {
  return (
    <div role="note" data-sv-frame-note="" style={{
      padding: 'clamp(3rem, 8vw, 5rem) 1.25rem', textAlign: 'center', color: 'var(--servd-mute)',
      font: '500 0.95rem/1.5 var(--font-inter), system-ui, sans-serif',
    }}>
      {children}
    </div>
  )
}

/** A live part: clicking it offers that part's own editor. */
function Context({ slug, children }: { slug: string; children: ReactNode }) {
  return <div data-sv-context={slug} style={{ display: 'contents' }}>{children}</div>
}

/** The draft kit's tokens, after the root layout's live ones so they win
 *  (`:root`, same specificity, later in the document). Preview only. */
function DraftKitStyle({ kit, concepts }: { kit: FrameKitInput; concepts: Concept[] }) {
  const concept = findConcept(kit.brand, concepts) ?? null
  const css = kitCss([resolveKit(kit.brand, concept, kit.entry)])
  return <style data-sv-draft-kit={kit.brand} dangerouslySetInnerHTML={{ __html: css }} />
}

export function FrameDocument({ data, variant }: { data: FrameData; variant: 'a' | 'b' }) {
  const { plan, concepts } = data
  if (plan.family === 'notice') return <FrameNote>{plan.text}</FrameNote>
  const kitStyle = data.kit ? <DraftKitStyle kit={data.kit} concepts={concepts} /> : null
  const kits = data.kits ? { kits: data.kits } : {}

  const render = (part: Part, extra?: { params?: Record<string, string> }) => {
    if (!part.draft) {
      return <ManagedPage slug={part.slug} layout={data.live[part.slug] ?? emptyRead(part.slug)} previewVariant="a" concepts={concepts} {...kits} {...extra} />
    }
    return (
      <ManagedPage slug={part.slug} layout={part.draft} previewVariant={variant} concepts={concepts}
        editor editorMarker={BlockMarker} {...kits} {...extra} />
    )
  }

  /** The edited page, or a note when it would render nothing at all. */
  const draftPage = (part: Part): ReactNode => {
    const draft = part.draft!
    const empty = !visibleBlocks(draft) && defaultBlocks(part.slug).length === 0
    if (part.slug.startsWith('page:')) {
      // Mirrors app/pages/[slug]: the layout alone, no section context.
      return (
        <>
          {draft.blocks?.length
            ? <SiteLayoutView layout={draft} context={{ editor: true, editorMarker: BlockMarker }} previewVariant={variant} />
            : null}
          {empty && <FrameNote>This page has no elements yet.</FrameNote>}
        </>
      )
    }
    if (part.slug === 'servd:location') {
      if (!data.loc) return <FrameNote>No location to preview yet.</FrameNote>
      return render(part, { params: { loc: data.loc } })
    }
    return (
      <>
        {render(part)}
        {empty && <FrameNote>This page has no elements yet.</FrameNote>}
      </>
    )
  }

  if (plan.family === 'servd') {
    const { header, page, footer, widget } = plan
    const headerNode = render(header)
    const pageNode = page.draft ? draftPage(page) : render(page, page.slug === 'servd:location' && data.loc ? { params: { loc: data.loc } } : undefined)
    return (
      <>
        {kitStyle}
        {/* Sticky as a whole, like StorefrontNav does on live pages. */}
        <div {...(!header.draft && { 'data-sv-context': header.slug })} style={{ position: 'sticky', top: 0, zIndex: 50 }}>
          {headerNode}
        </div>
        {page.draft
          ? <PageSurface slug={page.slug}>{pageNode}</PageSurface>
          : <Context slug={page.slug}><PageSurface slug={page.slug}>{pageNode}</PageSurface></Context>}
        {footer.draft ? render(footer) : <Context slug={footer.slug}>{render(footer)}</Context>}
        {widget && render(widget)}
      </>
    )
  }

  // Brand microsite: the same shell, scope and theming as
  // app/brand/[slug]/layout.tsx — .servd-brand-scope pins the servd tokens a
  // brand page inherits, exactly as on the live page.
  const found = findConcept(plan.brand, concepts)!
  const themed: Concept = { ...found, primaryColor: brandAccent(found.slug, found.primaryColor, data.kits) }
  const { header, page, footer } = plan
  return (
    <>
      {kitStyle}
      <div className="servd-brand-scope" style={{ display: 'contents' }}>
        <BrandShell
          concept={themed}
          header={header.draft ? render(header) : <Context slug={header.slug}>{render(header)}</Context>}
          footer={footer.draft ? render(footer) : <Context slug={footer.slug}>{render(footer)}</Context>}
        >
          {page.draft ? draftPage(page) : <Context slug={page.slug}>{render(page)}</Context>}
        </BrandShell>
      </div>
    </>
  )
}
