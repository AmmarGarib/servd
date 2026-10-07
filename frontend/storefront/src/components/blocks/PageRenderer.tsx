// Server component that renders a Block[] as a sequence of typed sections.
// Async components (kitchens, featured_menu, reviews) fetch data in-render.

import type { CSSProperties, ReactNode } from 'react'
import type { Block, ColumnsBlock } from '../../lib/blocks'
import { PADDING_PX, BUTTON_SIZE_PX, cssFontFamily } from '../../lib/blocks'
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
import { formatBrandName } from '../../lib/concept'

export interface RenderContext {
  /** When rendering a brand page, the active concept slug — block defaults
      that say "inherit" use this. */
  conceptSlug?: string
  /** When rendering a brand page, the brand metadata used for {{brand.name}}
      placeholder substitution. */
  brand?: { name: string; description: string | null; primaryColor: string | null; slug: string }
  /** The page's built-in design, rendered where a `signature` block sits:
      brand page → BrandFallback, servd:home → HomeClient. Absent → nothing. */
  signature?: ReactNode
}

export async function PageRenderer({ blocks, context }: { blocks: Block[]; context?: RenderContext }) {
  return <>{await renderSlots(blocks, context, false)}</>
}

async function renderSlots(blocks: Block[], ctx: RenderContext | undefined, nested: boolean): Promise<ReactNode[]> {
  const visible = blocks.filter((b) => b && !b.hidden && !(nested && b.type === 'columns'))
  const rendered = await Promise.all(visible.map((b) => renderBlock(b, ctx)))
  return visible.map((b, i) => (
    <BlockSlot key={b.id ?? i} block={b} nested={nested}>
      {rendered[i]}
    </BlockSlot>
  ))
}

// Wraps every block with a section that applies background / textColor /
// padding / font / entrance-animation controls uniformly.
function BlockSlot({ block, nested, children }: { block: Block; nested: boolean; children: ReactNode }) {
  // The built-in design paints its own surface edge to edge.
  if (block.type === 'signature') return <>{children}</>
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
    case 'signature':    return ctx?.signature ?? null
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
