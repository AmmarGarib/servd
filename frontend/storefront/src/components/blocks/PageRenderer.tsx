// Server component that renders a Block[] as a sequence of typed sections.
// Async components (kitchens, featured_menu, reviews) fetch data in-render.
//
// Wrapping order for each visible block (outermost first):
//   [editor marker]  → only inside /editor-frame (context.editor)
//   [motion wrapper] → only when block.motion is a valid scroll effect
//   the block itself (BlockSlot: <section> / Animate / designed section)
// A block without valid motion, outside the editor, renders exactly as before.
// Consecutive sticky-stack blocks are grouped in one .sv-stack.

import type { CSSProperties, JSX, ReactNode } from 'react'
import type { Block, ColumnsBlock } from '../../lib/blocks'
import { PADDING_PX, BUTTON_SIZE_PX, cssFontFamily } from '../../lib/blocks'
import { normalizeMotion, type NormalizedMotion } from '../../lib/motion'
import { MotionWrap } from './Motion'
import { Hero }          from './Hero'
import { CtaButton }     from './CtaButton'
import { Banner }        from './Banner'
import { TextBody }      from './TextBody'
import { ImageBlockUi }  from './ImageBlockUi'
import { Gallery }       from './Gallery'
import { StatStrip }     from './StatStrip'
import { Voices }        from './Voices'
import { Kitchens }      from './Kitchens'
import { FeaturedMenu }  from './FeaturedMenu'
import { Reviews }       from './Reviews'
import { Quote }         from './Quote'
import { Spacer }        from './Spacer'
import { Divider }       from './Divider'
import { VideoBlockUi }  from './VideoBlockUi'
import { SignupFormBlock } from './SignupFormBlock'
import { WaitlistForm }  from '../waitlist/WaitlistForm'
import { Animate }       from './Animate'
import { brandSurface, formatBrandName } from '../../lib/concept'
import { SECTION_RENDERERS } from '../../sections/renderers'
import { mergeFields } from '../../sections/catalog'
import type { SectionContext, SectionProps } from '../../sections/types'

export interface RenderContext {
  /** When rendering a brand page, the active concept slug — block defaults
      that say "inherit" use this. */
  conceptSlug?: string
  /** When rendering a brand page, the brand metadata used for {{brand.name}}
      placeholder substitution. */
  brand?: { name: string; description: string | null; primaryColor: string | null; slug: string }
  /** What `section` blocks render against (page, brand, live brands). */
  section?: SectionContext
  /** Set only by the editor frame (/editor-frame): every rendered block is
      wrapped in a selection marker (data-sv-block). Never on live pages. */
  editor?: boolean
  /** The editor frame's marker component (src/editor/BlockMarker.tsx — a
      client error boundary per block). Handed in by the frame so live pages
      never import editor code; without it the marker is a plain div. */
  editorMarker?: EditorMarker
  /** false = ignore block.motion (header / widget / pop-up layouts: a
      transform there would break the sticky nav or the fixed button). */
  motion?: false
}

export type EditorMarker = (props: { id: string; type: string; children: ReactNode }) => ReactNode

export async function PageRenderer({ blocks, context }: { blocks: Block[]; context?: RenderContext }) {
  return <>{await renderSlots(blocks, context, false)}</>
}

async function renderSlots(blocks: Block[], ctx: RenderContext | undefined, nested: boolean): Promise<ReactNode[]> {
  const visible = blocks.filter((b) => b && !b.hidden && !(nested && b.type === 'columns'))
  const rendered = await Promise.all(visible.map((b) => (ctx?.editor ? renderBlockInEditor(b, ctx) : renderBlock(b, ctx))))
  const motions: Array<NormalizedMotion | null> = visible.map((b) => (ctx?.motion === false ? null : normalizeMotion(b.motion)))
  if (!ctx?.editor && motions.every((m) => !m)) {
    // No scroll effects and not the editor: today's markup, unchanged.
    return visible.map((b, i) => (
      <BlockSlot key={b.id ?? i} block={b} nested={nested}>
        {rendered[i]}
      </BlockSlot>
    ))
  }

  // Each block's place in its run of consecutive sticky-stack blocks.
  let run = 0
  const stackIndex = motions.map((m) => (m?.preset === 'sticky-stack' ? run++ : (run = 0, -1)))

  const slots = visible.map((b, i) => {
    const key = b.id ?? i
    const m = motions[i] ?? null
    let out: ReactNode = (
      <BlockSlot key={m || ctx?.editor ? undefined : key} block={b} nested={nested}>
        {rendered[i]}
      </BlockSlot>
    )
    if (m) out = <MotionWrap key={ctx?.editor ? undefined : key} motion={m} stackIndex={Math.max(0, stackIndex[i] ?? 0)}>{out}</MotionWrap>
    if (ctx?.editor) out = editorMarker(ctx, key, String(b.id ?? ''), String(b.type ?? ''), out)
    return out
  })

  // Group each maximal run of sticky-stack blocks in one .sv-stack: the cards
  // stick inside it. On a brand page the cards carry the brand's surface.
  const concept = ctx?.section?.concept
  const pageBg = concept ? ({ ['--sv-page-bg' as string]: brandSurface(concept.slug).bg } as CSSProperties) : undefined
  const out: ReactNode[] = []
  for (let i = 0; i < slots.length; i++) {
    if (stackIndex[i] !== 0) { out.push(slots[i]); continue }
    let j = i
    while (j + 1 < slots.length && (stackIndex[j + 1] ?? -1) > 0) j++
    out.push(
      <div className="sv-stack" key={`stack-${visible[i]!.id ?? i}`} style={pageBg} {...(concept && { 'data-sv-brand': concept.slug })}>
        {slots.slice(i, j + 1)}
      </div>,
    )
    i = j
  }
  return out
}

function editorMarker(ctx: RenderContext, key: string | number, id: string, type: string, children: ReactNode): ReactNode {
  const Marker = ctx.editorMarker
  if (Marker) return <Marker key={key} id={id} type={type}>{children}</Marker>
  return <div key={key} data-sv-block={id} data-sv-type={type} style={{ display: 'contents' }}>{children}</div>
}

/** Editor frame only: a block whose data fetch throws becomes an element that
 *  throws when rendered, so that block's marker (a client error boundary)
 *  shows a placeholder instead of the whole page failing. */
async function renderBlockInEditor(block: Block, ctx: RenderContext): Promise<ReactNode> {
  try {
    return await renderBlock(block, ctx)
  } catch (e) {
    return <BlockRenderError message={e instanceof Error ? e.message : 'This element could not be drawn.'} />
  }
}

function BlockRenderError({ message }: { message: string }): never {
  throw new Error(message)
}

// Wraps every block with a section that applies background / textColor /
// padding / font / entrance-animation controls uniformly.
function BlockSlot({ block, nested, children }: { block: Block; nested: boolean; children: ReactNode }) {
  // A designed section paints its own surface edge to edge; only the
  // overrides the editor actually set wrap it.
  if (block.type === 'section' && !block.background && !block.textColor && !block.paddingY && !block.fontFamily) {
    if (!block.animation || block.animation === 'none') return <>{children}</>
    return (
      <Animate animation={block.animation}
        {...(block.animationDelayMs !== undefined && { delayMs: block.animationDelayMs })}
        {...(block.animationDurationMs !== undefined && { durationMs: block.animationDurationMs })}>
        {children}
      </Animate>
    )
  }
  const padY = block.paddingY ?? defaultPad(block, nested)
  const font = cssFontFamily(block.fontFamily)
  const style: CSSProperties = {
    background: block.background ?? undefined,
    color:      block.textColor ?? undefined,
    paddingTop:    PADDING_PX[padY],
    paddingBottom: PADDING_PX[padY],
    ...(font && { fontFamily: font, ['--sv-heading-font' as string]: font }),
  }
  const section = (
    <section style={style} {...(font && { 'data-sv-font': '' })}>
      {children}
    </section>
  )
  if (!block.animation || block.animation === 'none') return section
  return (
    <Animate
      animation={block.animation}
      {...(block.animationDelayMs !== undefined && { delayMs: block.animationDelayMs })}
      {...(block.animationDurationMs !== undefined && { durationMs: block.animationDurationMs })}
    >
      {section}
    </Animate>
  )
}

function defaultPad(block: Block, nested: boolean): NonNullable<Block['paddingY']> {
  switch (block.type) {
    case 'spacer':  return block.size
    case 'divider': return 'none'
    case 'hero':    return 'none'   // hero owns its own height
    case 'section': return 'none'   // sections own their spacing
    default:        return nested ? 'none' : 'lg'
  }
}

const COLUMN_GAP: Record<NonNullable<ColumnsBlock['gap']>, string> = {
  sm: '1rem', md: 'clamp(1.5rem, 3vw, 2rem)', lg: 'clamp(2rem, 5vw, 3.5rem)',
}

async function Columns({ block, ctx }: { block: ColumnsBlock; ctx?: RenderContext }) {
  const cols = (Array.isArray(block.columns) ? block.columns : []).slice(0, 4)
  if (cols.length === 0) return null
  const rendered = await Promise.all(cols.map((col) => renderSlots(Array.isArray(col) ? col : [], ctx, true)))
  return (
    <div className={block.fullBleed ? undefined : 'container'}>
      <div
        className="sv-cols"
        data-stack={block.stackOnMobile === false ? 'false' : 'true'}
        style={{ ['--sv-cols' as string]: String(cols.length), ['--sv-gap' as string]: COLUMN_GAP[block.gap ?? 'md'] } as CSSProperties}
      >
        {rendered.map((slots, i) => <div key={i} style={{ minWidth: 0 }}>{slots}</div>)}
      </div>
    </div>
  )
}

async function renderBlock(block: Block, ctx?: RenderContext): Promise<ReactNode> {
  const sub = (str: string): string => interpolate(str, ctx)
  const subOpt = (str: string | undefined) => (str === undefined ? undefined : interpolate(str, ctx))
  switch (block.type) {
    case 'hero': {
      const subtitle = subOpt(block.subtitle)
      const kicker   = subOpt(block.kicker)
      return <Hero {...block} title={sub(block.title)} {...(subtitle !== undefined && { subtitle })} {...(kicker !== undefined && { kicker })} />
    }
    case 'cta_button':   return <CtaButton {...block} text={sub(block.text)} />
    case 'banner': {
      const subtitle = subOpt(block.subtitle)
      return <Banner {...block} title={sub(block.title)} {...(subtitle !== undefined && { subtitle })} />
    }
    case 'text':         return <TextBody {...block} body={sub(block.body)} />
    case 'image':        return <ImageBlockUi {...block} />
    case 'gallery':      return <Gallery {...block} />
    case 'stat_strip':   return <StatStrip {...block} />
    case 'voices': {
      const kicker = subOpt(block.kicker)
      return <Voices {...block} {...(kicker !== undefined && { kicker })} />
    }
    case 'kitchens':     return await Kitchens({ block })
    case 'featured_menu':return await FeaturedMenu({ block, ...(ctx?.conceptSlug !== undefined && { fallbackSlug: ctx.conceptSlug }) })
    case 'reviews':      return await Reviews({ block, ...(ctx?.conceptSlug !== undefined && { fallbackSlug: ctx.conceptSlug }) })
    case 'quote': {
      const attribution = subOpt(block.attribution)
      return <Quote {...block} text={sub(block.text)} {...(attribution !== undefined && { attribution })} />
    }
    case 'spacer':       return <Spacer {...block} />
    case 'divider':      return <Divider />
    case 'columns':      return await Columns({ block, ...(ctx !== undefined && { ctx }) })
    case 'video':        return <VideoBlockUi {...block} />
    case 'section': {
      // Rendered as an element (not called) so client-component sections work;
      // async server sections are awaited by React.
      const Comp = SECTION_RENDERERS[block.variant] as unknown as ((p: SectionProps) => JSX.Element) | undefined
      if (!Comp) return null
      const sctx: SectionContext = ctx?.section ?? { pageSlug: '', concepts: [] }
      return <Comp fields={mergeFields(block.variant, block.fields)} ctx={sctx} id={block.id} />
    }
    case 'signup_form': {
      const title    = subOpt(block.title)
      const subtitle = subOpt(block.subtitle)
      return <SignupFormBlock block={{ ...block, ...(title !== undefined && { title }), ...(subtitle !== undefined && { subtitle }) }} />
    }
    case 'waitlist_form': {
      const title      = subOpt(block.title?.trim() || undefined)
      const subtitle   = subOpt(block.subtitle?.trim() || undefined)
      const buttonText = block.buttonText?.trim()
      return (
        <div className="container">
          <WaitlistForm {...(title && { title })} {...(subtitle && { subtitle })} {...(buttonText && { buttonText })} />
        </div>
      )
    }
    default:             return null
  }
}

// Tiny placeholder substitution. Supports {{brand.name}} / {{brand.description}}.
function interpolate(s: string, ctx?: RenderContext): string {
  if (!ctx?.brand) return s
  return s
    .replace(/\{\{brand\.name\}\}/g,        formatBrandName(ctx.brand.name))
    .replace(/\{\{brand\.description\}\}/g, ctx.brand.description ?? '')
    .replace(/\{\{brand\.slug\}\}/g,        ctx.brand.slug)
}

// Re-export size helpers for blocks that need them
export { BUTTON_SIZE_PX }
