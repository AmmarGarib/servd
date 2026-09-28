// Renders a published (or previewed) SiteLayout: library @font-face rules,
// PageSettings fonts, the A/B variant for this visitor, and the view/convert
// beacon. Server component — the variant is decided here from the visitor
// cookie so the HTML already carries the right blocks (no flicker).

import type { CSSProperties } from 'react'
import { cookies } from 'next/headers'
import type { Block, SiteLayoutRead } from '../../lib/blocks'
import { cssFontFamily, fontFaceCss } from '../../lib/blocks'
import { VISITOR_COOKIE, pickVariant, type Variant } from '../../lib/abVariant'
import { PageRenderer, type RenderContext } from './PageRenderer'
import { TrackedLayout } from './TrackedLayout'

function hasAnimation(blocks: Block[]): boolean {
  return blocks.some((b) =>
    (!!b.animation && b.animation !== 'none') ||
    (b.type === 'columns' && Array.isArray(b.columns) && b.columns.some((c) => Array.isArray(c) && hasAnimation(c))))
}

/** Blocks for this visitor. `forceVariant` (preview) skips the cookie. */
export function resolveVariant(layout: SiteLayoutRead, forceVariant?: Variant): { variant: Variant; blocks: Block[] } {
  const main = layout.blocks ?? []
  const ab = layout.settings?.ab
  const bBlocks = ab && Array.isArray(ab.blocks) ? ab.blocks : null
  if (forceVariant) return forceVariant === 'b' && bBlocks ? { variant: 'b', blocks: bBlocks } : { variant: 'a', blocks: main }
  if (!bBlocks || !(ab!.splitPct > 0)) return { variant: 'a', blocks: main }
  const vid = cookies().get(VISITOR_COOKIE)?.value
  if (!vid) return { variant: 'a', blocks: main }
  const variant = pickVariant(vid, layout.slug, layout.version, ab!.splitPct)
  return { variant, blocks: variant === 'b' ? bBlocks : main }
}

export async function SiteLayoutView({ layout, context, previewVariant }: {
  layout: SiteLayoutRead
  context?: RenderContext
  /** Set on /preview: render this variant, send no stats. */
  previewVariant?: Variant
}) {
  const { variant, blocks } = resolveVariant(layout, previewVariant)
  const heading = cssFontFamily(layout.settings?.fonts?.heading)
  const body = cssFontFamily(layout.settings?.fonts?.body)
  const faces = fontFaceCss(layout.fonts)

  const style: CSSProperties = {
    ...(body && { fontFamily: body }),
    ...(heading && { ['--sv-heading-font' as string]: heading }),
  }
  const content = (
    <div style={style} {...(heading && { 'data-sv-font': '' })}>
      <PageRenderer blocks={blocks} {...(context !== undefined && { context })} />
    </div>
  )

  return (
    <>
      {faces && <style dangerouslySetInnerHTML={{ __html: faces }} />}
      {hasAnimation(blocks) && (
        <noscript dangerouslySetInnerHTML={{ __html: '<style>.sv-anim{opacity:1!important}</style>' }} />
      )}
      {previewVariant
        ? content
        : <TrackedLayout slug={layout.slug} version={layout.version} variant={variant}>{content}</TrackedLayout>}
    </>
  )
}
