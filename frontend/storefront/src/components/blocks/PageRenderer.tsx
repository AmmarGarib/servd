// Server component that renders a Block[] as a sequence of typed sections.
// Async components (kitchens, featured_menu, reviews) fetch data in-render.

import type { ReactNode } from 'react'
import type { Block } from '../../lib/blocks'
import { PADDING_PX, BUTTON_SIZE_PX } from '../../lib/blocks'
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

interface RenderContext {
  /** When rendering a brand page, the active concept slug — block defaults
      that say "inherit" use this. */
  conceptSlug?: string
  /** When rendering a brand page, the brand metadata used for {{brand.name}}
      placeholder substitution. */
  brand?: { name: string; description: string | null; primaryColor: string | null; slug: string }
}

export async function PageRenderer({ blocks, context }: { blocks: Block[]; context?: RenderContext }) {
  const visible = blocks.filter((b) => !b.hidden)
  const rendered = await Promise.all(visible.map((b) => renderBlock(b, context)))
  return (
    <>
      {visible.map((b, i) => (
        <BlockSlot key={b.id} block={b}>
          {rendered[i]}
        </BlockSlot>
      ))}
    </>
  )
}

// Wraps every block with a section that applies background / textColor /
// padding controls uniformly.
function BlockSlot({ block, children }: { block: Block; context?: RenderContext; children: ReactNode }) {
  const padY = block.paddingY ?? defaultPad(block)
  return (
    <section
      style={{
        background: block.background ?? undefined,
        color:      block.textColor ?? undefined,
        paddingTop:    PADDING_PX[padY],
        paddingBottom: PADDING_PX[padY],
      }}
    >
      {children}
    </section>
  )
}

function defaultPad(block: Block): NonNullable<Block['paddingY']> {
  switch (block.type) {
    case 'spacer':  return block.size
    case 'divider': return 'none'
    case 'hero':    return 'none'   // hero owns its own height
    default:        return 'lg'
  }
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
    default:             return null
  }
}

// Tiny placeholder substitution. Supports {{brand.name}} / {{brand.description}}.
function interpolate(s: string, ctx?: RenderContext): string {
  if (!ctx?.brand) return s
  return s
    .replace(/\{\{brand\.name\}\}/g,        ctx.brand.name)
    .replace(/\{\{brand\.description\}\}/g, ctx.brand.description ?? '')
    .replace(/\{\{brand\.slug\}\}/g,        ctx.brand.slug)
}

// Re-export size helpers for blocks that need them
export { BUTTON_SIZE_PX }
