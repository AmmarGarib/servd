// Native renderer for storefront content blocks (decision 41).
//
// <ContentBlocks> is what screens use: it picks the A/B variant, loads the
// page's library fonts, posts one `view` per mount and one `convert` on the
// first link/button press. <BlockRenderer> renders a Block[] and is reused for
// the blocks inside a `columns` block.
//
// Entrances: a block plays its own `animation`; a block with only a scroll
// effect (`motion`, D4 stage 1) plays the matching entrance instead, and none
// under the device's reduce-motion setting (./motion.ts). Unknown values are
// static and fully visible.
//
// The app is dark, the web storefront is light: a block with no background
// sits on the screen's own dark surface with light text; a block with a
// background picks ink or white text by the background's luminance, unless
// the owner set textColor.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  View, Text, Image, ImageBackground, ScrollView, TouchableOpacity, Animated, Easing,
  useWindowDimensions, type TextStyle, type ViewStyle,
} from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { formatBrandName } from '../lib/brandName'
import { getVisitorId, peekVisitorId, pickVariant, trackContent } from './api'
import { resolveFontFamily, useLibraryFonts } from './fonts'
import { openHref } from './links'
import { entranceFor, ownEntrance, useReduceMotion } from './motion'
import type {
  Align, Animation, Block, BannerBlock, ButtonSize, ButtonStyle, ColumnsBlock, CtaButtonBlock, FeaturedMenuBlock,
  GalleryBlock, HeroBlock, ImageBlock, KitchensBlock, LibraryFont, PageSettings, QuoteBlock, ReviewsBlock,
  SectionPad, SignupFormBlock, StatStripBlock, TextBlock, Variant, VideoBlock, VoicesBlock, WaitlistFormBlock,
} from './types'

// ── Palette (root storefront tokens; the app has no CSS variables) ─────────

const APP_TEXT = '#ffffff'
const INK = '#3d1f3b'
const GREEN = '#87c540'
const GREEN_SOFT = '#e2edc8'
const GREEN_INK = '#3a5c12'

// Mirrors the storefront's :root --servd-* tokens (bone / green / purple, 2026-10-05).
const CSS_VARS: Record<string, string> = {
  '--servd-green': GREEN, '--servd-green-dark': '#4f7a1c', '--servd-green-soft': GREEN_SOFT,
  '--servd-green-ink': GREEN_INK, '--servd-on-green': INK, '--servd-black': '#3f1640', '--servd-purple': '#5a2156', '--servd-on-purple': '#f3e7cd', '--servd-ink': INK,
  '--servd-mute': '#705764', '--servd-dim': '#a3909e', '--servd-line': 'rgba(61,31,59,0.14)',
  '--servd-bg': '#f3e7cd', '--servd-surface': '#ece0c3',
  '--simmer-green': '#06392F', '--simmer-bone': '#EDE6D3', '--simmer-walnut': '#3D2817',
  '--simmer-black': '#0E0E0E', '--simmer-orange': '#E94E1B',
  '--stackd-plum': '#7C2946', '--stackd-plum-dark': '#3D1122', '--stackd-cream': '#FCE8CE',
  '--stackd-sky': '#9BD3DD', '--stackd-cement': '#2E1922',
  '--flipd-blue': '#6A0DAD', '--flipd-blue-deep': '#3B0764', '--flipd-mustard': '#FFFFFF',
  '--flipd-bone': '#F3EEFA', '--flipd-green': '#87C540', '--flipd-ink': '#261038',
}

function resolveColor(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = v.trim()
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(s)
  if (m) return CSS_VARS[m[1] as string] ?? resolveColor(m[2])
  if (/gradient\(|url\(/i.test(s)) return undefined
  return s
}

/** true = light surface (use ink text), false = dark, null = can't tell. */
function isLight(color: string): boolean | null {
  const c = color.trim().toLowerCase()
  if (c === 'white') return true
  if (c === 'black' || c === 'transparent') return false
  let r: number, g: number, b: number
  const hex = /^#([0-9a-f]{3,8})$/.exec(c)
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c)
  if (hex) {
    const h = hex[1] as string
    const full = h.length <= 4 ? h.slice(0, 3).split('').map((x) => x + x).join('') : h.slice(0, 6)
    r = parseInt(full.slice(0, 2), 16); g = parseInt(full.slice(2, 4), 16); b = parseInt(full.slice(4, 6), 16)
  } else if (rgb) {
    r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3])
  } else return null
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
}

const PAD: Record<SectionPad, number> = { none: 0, sm: 16, md: 32, lg: 48, xl: 64 }
const GUTTER = 20

const BUTTON_SIZE: Record<ButtonSize, { px: number; py: number; fz: number }> = {
  sm:   { px: 16, py: 8,  fz: 13.5 },
  md:   { px: 24, py: 12, fz: 15 },
  lg:   { px: 36, py: 16, fz: 17 },
  xl:   { px: 40, py: 17, fz: 17.5 },
  huge: { px: 44, py: 19, fz: 18.5 },
}

const alignItems = (a: Align | undefined): ViewStyle['alignItems'] =>
  a === 'center' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start'

// ── Render context ─────────────────────────────────────────────────────────

export interface BrandContext { name: string; description: string | null; slug: string }

interface RenderCtx {
  conceptSlug?: string
  brand?: BrandContext
  headingFont?: string
  bodyFont?: string
  signature?: ReactNode
  onAction: (href: string | undefined) => void
}

const Ctx = createContext<RenderCtx>({ onAction: (href) => { openHref(href) } })

function interpolate(s: string | undefined, ctx: RenderCtx): string {
  if (!s) return ''
  if (!ctx.brand) return s
  return s
    .replace(/\{\{brand\.name\}\}/g, formatBrandName(ctx.brand.name))
    .replace(/\{\{brand\.description\}\}/g, ctx.brand.description ?? '')
    .replace(/\{\{brand\.slug\}\}/g, ctx.brand.slug)
}

interface Look {
  fg: string                 // text color
  onLight: boolean           // the surface under the text is light
  heading?: string           // native font family for titles
  body?: string              // native font family for copy
}

interface P<B> { b: B; look: Look }

// ── ContentBlocks: A/B + tracking + fonts around a Block[] ──────────────────

export interface ContentLayout {
  slug: string
  version: number
  blocks: Block[] | null
  settings?: PageSettings | null
  fonts?: LibraryFont[]
}

export function ContentBlocks({
  layout, signature, conceptSlug, brand, onAfterAction, ensureSignature,
}: {
  layout: ContentLayout
  /** What a `signature` block renders (the screen's own built-in design). */
  signature?: ReactNode
  conceptSlug?: string
  brand?: BrandContext
  /** Pop-ups use this to close themselves after a press. */
  onAfterAction?: () => void
  /** Render `signature` after the blocks when the layout has no signature
      element (screens whose own body must always show, e.g. the menu). */
  ensureSignature?: boolean
}) {
  const ab = layout.settings?.ab
  const hasAb = !!ab && Array.isArray(ab.blocks) && ab.blocks.length > 0 && Number(ab.splitPct) > 0
  const [visitorId, setVisitorId] = useState<string | null>(peekVisitorId())
  useEffect(() => {
    if (!hasAb || visitorId) return
    let alive = true
    getVisitorId().then((id) => { if (alive) setVisitorId(id) })
    return () => { alive = false }
  }, [hasAb, visitorId])

  const variant: Variant | null = !hasAb ? 'a' : visitorId ? pickVariant(visitorId, layout) : null
  const blocks = variant === 'b' && ab ? ab.blocks : (layout.blocks ?? [])
  const fontTick = useLibraryFonts(layout.fonts)

  const viewed = useRef<string | null>(null)
  const converted = useRef(false)
  useEffect(() => {
    if (!variant || !layout.version) return
    const key = `${layout.slug}:${layout.version}:${variant}`
    if (viewed.current === key) return
    viewed.current = key
    converted.current = false
    trackContent(layout.slug, layout.version, variant, 'view')
  }, [layout.slug, layout.version, variant])

  const onAction = useCallback((href: string | undefined) => {
    if (variant && layout.version && !converted.current) {
      converted.current = true
      trackContent(layout.slug, layout.version, variant, 'convert')
    }
    onAfterAction?.()
    openHref(href)
  }, [variant, layout.slug, layout.version, onAfterAction])

  const headingName = layout.settings?.fonts?.heading
  const bodyName = layout.settings?.fonts?.body
  const ctx = useMemo<RenderCtx>(() => ({
    ...(conceptSlug !== undefined && { conceptSlug }),
    ...(brand !== undefined && { brand }),
    ...(signature !== undefined && { signature }),
    headingFont: resolveFontFamily(headingName),
    bodyFont: resolveFontFamily(bodyName),
    onAction,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [conceptSlug, brand, signature, headingName, bodyName, onAction, fontTick])

  if (!variant) return null
  return (
    <Ctx.Provider value={ctx}>
      <BlockRenderer blocks={blocks} />
      {ensureSignature && !blocks.some((x) => x && !x.hidden && x.type === 'signature') ? signature : null}
    </Ctx.Provider>
  )
}

// ── BlockRenderer ──────────────────────────────────────────────────────────

export function BlockRenderer({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.filter((b) => b && !b.hidden).map((b) => <BlockSlot key={b.id} block={b} />)}
    </>
  )
}

function defaultPad(b: Block): SectionPad {
  switch (b.type) {
    case 'spacer':    return b.size ?? 'md'
    case 'divider':   return 'none'
    case 'hero':      return 'none'
    case 'signature': return 'none'
    case 'columns':   return 'md'
    default:          return 'lg'
  }
}

function BlockSlot({ block }: { block: Block }) {
  const ctx = useContext(Ctx)
  const reduceMotion = useReduceMotion()
  const bg = resolveColor(block.background)
  const light = bg ? isLight(bg) : false
  const own = resolveFontFamily(block.fontFamily)
  const look: Look = {
    fg: resolveColor(block.textColor) ?? (light ? INK : APP_TEXT),
    onLight: light === true,
    ...((own ?? ctx.headingFont) !== undefined && { heading: own ?? ctx.headingFont }),
    ...((own ?? ctx.bodyFont) !== undefined && { body: own ?? ctx.bodyFont }),
  }
  const pad = PAD[block.paddingY ?? defaultPad(block)] ?? 0
  const content = renderBlock(block, look, ctx)
  if (content === null) return null
  // The block's own entrance, else its scroll effect played as an entrance
  // (the app has no scroll effects yet; see ./motion.ts). Timing fields belong
  // to the block's own entrance, so a motion-derived one uses the defaults.
  const kind = entranceFor(block, reduceMotion)
  const ownTiming = ownEntrance(block) !== null
  return (
    <View style={{ backgroundColor: bg, paddingTop: pad, paddingBottom: pad }}>
      <Animate
        kind={kind}
        durationMs={ownTiming ? block.animationDurationMs : undefined}
        delayMs={ownTiming ? block.animationDelayMs : undefined}>
        {content}
      </Animate>
    </View>
  )
}

function renderBlock(b: Block, look: Look, ctx: RenderCtx): ReactNode {
  switch (b.type) {
    case 'hero':          return <HeroView b={b} look={look} />
    case 'cta_button':    return <CtaView b={b} look={look} />
    case 'banner':        return <BannerView b={b} look={look} />
    case 'text':          return b.body ? <TextView b={b} look={look} /> : null
    case 'image':         return b.url ? <ImageView b={b} look={look} /> : null
    case 'gallery':       return Array.isArray(b.images) && b.images.length > 0 ? <GalleryView b={b} look={look} /> : null
    case 'stat_strip':    return Array.isArray(b.stats) && b.stats.length > 0 ? <StatStripView b={b} look={look} /> : null
    case 'voices':        return Array.isArray(b.voices) && b.voices.length > 0 ? <VoicesView b={b} look={look} /> : null
    case 'kitchens':      return <KitchensView b={b} look={look} />
    case 'featured_menu': return (b.conceptSlug ?? ctx.conceptSlug) ? <FeaturedMenuView b={b} look={look} /> : null
    case 'reviews':       return (b.conceptSlug ?? ctx.conceptSlug) ? <ReviewsView b={b} look={look} /> : null
    case 'quote':         return b.text ? <QuoteView b={b} look={look} /> : null
    case 'spacer':        return <View />
    case 'divider':       return <Container full={b.fullBleed}><View style={{ height: 1, backgroundColor: look.fg, opacity: 0.15 }} /></Container>
    case 'columns':       return Array.isArray(b.columns) && b.columns.length > 0 ? <ColumnsView b={b} look={look} /> : null
    case 'video':         return b.url ? <VideoView b={b} look={look} /> : null
    case 'signature':     return ctx.signature ?? null
    case 'signup_form':   return <SignupFormView b={b} look={look} />
    case 'waitlist_form': return <WaitlistFormView b={b} look={look} />
    default:              return null
  }
}

// ── Animation ──────────────────────────────────────────────────────────────

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt

function Animate({
  kind, durationMs, delayMs, children,
}: {
  kind: Animation
  durationMs: number | undefined
  delayMs: number | undefined
  children: ReactNode
}) {
  const v = useRef(new Animated.Value(kind === 'none' ? 1 : 0)).current
  useEffect(() => {
    if (kind === 'none') return
    const anim = Animated.timing(v, {
      toValue: 1,
      duration: clamp(durationMs, 200, 3000, 600),
      delay: clamp(delayMs, 0, 3000, 0),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    })
    anim.start()
    return () => anim.stop()
  }, [kind, v, durationMs, delayMs])

  if (kind === 'none') return <>{children}</>
  const transform =
    kind === 'fade-up'     ? [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }] :
    kind === 'slide-left'  ? [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] :
    kind === 'slide-right' ? [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }] :
    kind === 'zoom-in'     ? [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] :
    []
  return <Animated.View style={{ opacity: v, transform }}>{children}</Animated.View>
}

// ── Shared pieces ──────────────────────────────────────────────────────────

function Container({ full, children, style }: { full?: boolean | undefined; children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ paddingHorizontal: full ? 0 : GUTTER }, style]}>{children}</View>
}

function Kicker({ text, look, center }: { text: string | undefined; look: Look; center?: boolean }) {
  if (!text) return null
  return (
    <Text style={{
      color: look.onLight ? '#4f7a1c' : GREEN, fontFamily: look.body, fontWeight: '700', fontSize: 11,
      letterSpacing: 2.5, textTransform: 'uppercase', marginBottom: 8, textAlign: center ? 'center' : 'left',
    }}>
      {text}
    </Text>
  )
}

function Button({
  text, href, kind = 'primary', size = 'lg', look, fullWidth, arrow,
}: {
  text: string; href: string | undefined; kind?: ButtonStyle | undefined; size?: ButtonSize | undefined
  look: Look; fullWidth?: boolean | undefined; arrow?: boolean | undefined
}) {
  const { onAction } = useContext(Ctx)
  const sz = BUTTON_SIZE[size] ?? BUTTON_SIZE.lg
  const palette: Record<ButtonStyle, { bg: string; fg: string; border: string }> = {
    primary:   { bg: GREEN, fg: INK, border: GREEN },
    secondary: { bg: '#fff', fg: INK, border: 'rgba(0,0,0,0.12)' },
    dark:      { bg: '#0a0a0a', fg: '#fff', border: look.onLight ? '#0a0a0a' : 'rgba(255,255,255,0.18)' },
    ghost:     { bg: 'transparent', fg: look.fg, border: look.onLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.25)' },
  }
  const p = palette[kind] ?? palette.primary
  return (
    <TouchableOpacity
      accessibilityRole="link"
      onPress={() => onAction(href)}
      activeOpacity={0.8}
      style={{
        backgroundColor: p.bg, borderColor: p.border, borderWidth: 1, borderRadius: 999,
        paddingVertical: sz.py, paddingHorizontal: sz.px, alignItems: 'center', justifyContent: 'center',
        alignSelf: fullWidth ? 'stretch' : undefined,
      }}>
      <Text style={{ color: p.fg, fontSize: sz.fz, fontWeight: '900', fontFamily: look.body, textAlign: 'center' }}>
        {text}{arrow ? ' →' : ''}
      </Text>
    </TouchableOpacity>
  )
}

function heading(look: Look, size: number, extra?: TextStyle): TextStyle {
  return { color: look.fg, fontFamily: look.heading, fontSize: size, fontWeight: '800', lineHeight: Math.round(size * 1.08), ...extra }
}
function copy(look: Look, size: number, extra?: TextStyle): TextStyle {
  return { color: look.fg, fontFamily: look.body, fontSize: size, lineHeight: Math.round(size * 1.5), ...extra }
}

// ── Blocks ─────────────────────────────────────────────────────────────────

function HeroView({ b, look }: P<HeroBlock>) {
  const ctx = useContext(Ctx)
  const { height: winH } = useWindowDimensions()
  const minHeight = {
    sm: Math.min(winH * 0.4, 320), md: Math.min(winH * 0.6, 520), lg: Math.min(winH * 0.75, 700),
    xl: Math.min(winH * 0.85, 800), screen: Math.min(winH * 0.92, 820),
  }[b.height ?? 'lg'] ?? 480
  const hasImage = !!b.imageUrl
  const l: Look = hasImage && !b.textColor ? { ...look, fg: '#ffffff', onLight: false } : look
  const align = b.align ?? 'left'
  const textAlign: TextStyle['textAlign'] = align
  const body = (
    <View style={{ paddingHorizontal: GUTTER, paddingVertical: 40, alignItems: alignItems(align) }}>
      {b.kicker ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
          <View style={{ width: 36, height: 1, backgroundColor: l.fg, opacity: 0.6, marginRight: 12 }} />
          <Text style={copy(l, 11, { fontWeight: '600', letterSpacing: 3, textTransform: 'uppercase', opacity: 0.85 })}>
            {interpolate(b.kicker, ctx)}
          </Text>
        </View>
      ) : null}
      <Text style={heading(l, 40, { fontWeight: '900', letterSpacing: -1.5, lineHeight: 42, textAlign })}>
        {interpolate(b.title, ctx)}
      </Text>
      {b.subtitle ? (
        <Text style={copy(l, 17, { opacity: 0.85, marginTop: 16, textAlign })}>{interpolate(b.subtitle, ctx)}</Text>
      ) : null}
      {(b.primaryCta || b.secondaryCta) ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 28, justifyContent: alignItems(align) as ViewStyle['justifyContent'] }}>
          {b.primaryCta ? <Button text={interpolate(b.primaryCta.text, ctx)} href={b.primaryCta.href} kind="primary" size="lg" look={l} /> : null}
          {b.secondaryCta ? <Button text={interpolate(b.secondaryCta.text, ctx)} href={b.secondaryCta.href} kind="ghost" size="md" look={l} /> : null}
        </View>
      ) : null}
    </View>
  )
  if (!hasImage) return <View style={{ minHeight, justifyContent: 'center' }}>{body}</View>
  const overlay = clamp(b.imageOverlay, 0, 1, 0.45)
  return (
    <ImageBackground source={{ uri: b.imageUrl }} resizeMode="cover" style={{ minHeight, justifyContent: 'center', backgroundColor: '#0a0a0a' }}>
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: `rgba(0,0,0,${overlay * 0.75})` }} />
      {body}
    </ImageBackground>
  )
}

function CtaView({ b, look }: P<CtaButtonBlock>) {
  const ctx = useContext(Ctx)
  return (
    <Container full={b.fullBleed} style={{ alignItems: b.fullWidth ? 'stretch' : alignItems(b.align) }}>
      <Button text={interpolate(b.text, ctx)} href={b.href} kind={b.style} size={b.size} look={look} fullWidth={b.fullWidth} arrow={b.trailingArrow} />
    </Container>
  )
}

function BannerView({ b, look }: P<BannerBlock>) {
  const ctx = useContext(Ctx)
  const bg = resolveColor(b.backgroundColor) ?? '#0a0a0a'
  const lightBg = !b.backgroundUrl && isLight(bg) === true
  const l: Look = { ...look, fg: resolveColor(b.textColor) ?? (lightBg ? INK : '#ffffff'), onLight: lightBg }
  const minHeight = { sm: 180, md: 280, lg: 420 }[b.height ?? 'md'] ?? 280
  const align = b.align ?? 'center'
  const inner = (
    <View style={{ paddingHorizontal: GUTTER, paddingVertical: 32, alignItems: alignItems(align) }}>
      <Text style={heading(l, 28, { letterSpacing: -0.8, textAlign: align })}>{interpolate(b.title, ctx)}</Text>
      {b.subtitle ? <Text style={copy(l, 16, { opacity: 0.85, marginTop: 8, textAlign: align })}>{interpolate(b.subtitle, ctx)}</Text> : null}
      {b.cta ? (
        <View style={{ marginTop: 22 }}>
          <Button text={interpolate(b.cta.text, ctx)} href={b.cta.href} kind={b.cta.style} size={b.cta.size ?? 'md'} look={l} />
        </View>
      ) : null}
    </View>
  )
  if (!b.backgroundUrl) return <View style={{ minHeight, justifyContent: 'center', backgroundColor: bg }}>{inner}</View>
  return (
    <ImageBackground source={{ uri: b.backgroundUrl }} resizeMode="cover" style={{ minHeight, justifyContent: 'center', backgroundColor: bg }}>
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' }} />
      {inner}
    </ImageBackground>
  )
}

function TextView({ b, look }: P<TextBlock>) {
  const ctx = useContext(Ctx)
  const size = { sm: 14.5, md: 16.5, lg: 20, xl: 26 }[b.size ?? 'md'] ?? 16.5
  return (
    <Container full={b.fullBleed}>
      <Text style={copy(look, size, { textAlign: b.align ?? 'left', fontWeight: b.emphasized ? '600' : '400', lineHeight: Math.round(size * 1.6) })}>
        {interpolate(b.body, ctx)}
      </Text>
    </Container>
  )
}

const ASPECT: Record<NonNullable<ImageBlock['aspect']>, number> = {
  '16/9': 16 / 9, '4/3': 4 / 3, '1/1': 1, '3/4': 3 / 4, '21/9': 21 / 9,
}

function ImageView({ b, look }: P<ImageBlock>) {
  return (
    <Container full={b.fullBleed}>
      <Image
        source={{ uri: b.url }}
        accessibilityLabel={b.alt ?? ''}
        resizeMode="cover"
        style={{ width: '100%', aspectRatio: ASPECT[b.aspect ?? '16/9'] ?? 16 / 9, borderRadius: b.rounded ? 16 : 0, backgroundColor: 'rgba(127,127,127,0.15)' }}
      />
      {b.caption ? <Text style={copy(look, 13, { opacity: 0.6, textAlign: 'center', marginTop: 10 })}>{b.caption}</Text> : null}
    </Container>
  )
}

function GalleryView({ b }: P<GalleryBlock>) {
  const { width } = useWindowDimensions()
  const cols = b.columns ?? 3
  const size = Math.round((width - GUTTER * 2) * (cols >= 4 ? 0.42 : cols === 3 ? 0.58 : 0.78))
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: GUTTER, gap: 12 }}>
      {b.images.map((img, i) => (
        <Image
          key={`${img.url}-${i}`}
          source={img.url ? { uri: img.url } : undefined}
          accessibilityLabel={img.alt ?? ''}
          resizeMode="cover"
          style={{ width: size, height: size, borderRadius: 12, backgroundColor: 'rgba(127,127,127,0.15)' }}
        />
      ))}
    </ScrollView>
  )
}

function StatStripView({ b, look }: P<StatStripBlock>) {
  const line = look.onLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)'
  const perRow = b.stats.length <= 3 ? b.stats.length : 2
  return (
    <Container full={b.fullBleed}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderBottomWidth: 1, borderColor: line }}>
        {b.stats.map((s, i) => (
          <View key={i} style={{
            width: `${100 / perRow}%` as `${number}%`, paddingVertical: 18, paddingHorizontal: 12,
            borderRightWidth: (i + 1) % perRow === 0 ? 0 : 1, borderColor: line,
          }}>
            <Text style={heading(look, 26, { fontWeight: '900', letterSpacing: -1 })}>{s.value}</Text>
            <Text style={copy(look, 11, { fontWeight: '600', opacity: 0.65, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4 })}>{s.label}</Text>
          </View>
        ))}
      </View>
    </Container>
  )
}

function VoicesView({ b, look }: P<VoicesBlock>) {
  const ctx = useContext(Ctx)
  const line = look.onLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)'
  return (
    <Container full={b.fullBleed}>
      <Kicker text={interpolate(b.kicker, ctx)} look={look} />
      {b.voices.map((v, i) => (
        <View key={i} style={{ paddingVertical: 14, borderTopWidth: 1, borderColor: line }}>
          <Text style={heading(look, 24, { letterSpacing: -0.6 })}>{formatBrandName(v.brand)}.</Text>
          <Text style={copy(look, 16, { fontStyle: 'italic', opacity: 0.7, marginTop: 4 })}>{v.line}</Text>
        </View>
      ))}
      <View style={{ borderTopWidth: 1, borderColor: line }} />
    </Container>
  )
}

interface PublicConcept { id: string; name: string; slug: string; description: string | null; primaryColor: string | null }

function KitchensView({ b, look }: P<KitchensBlock>) {
  const { onAction } = useContext(Ctx)
  // Same key + endpoint as the Browse tab, so the two share one cached list.
  const { data } = useQuery({
    queryKey: ['concepts-public'],
    queryFn: () => api.get<PublicConcept[]>('/storefront/concepts'),
  })
  const list = (data ?? []).slice(0, b.max ?? 6)
  const card = look.onLight ? '#ffffff' : '#0d0f15'
  const border = look.onLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)'
  return (
    <Container full={b.fullBleed}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16 }}>
        <View style={{ flex: 1 }}>
          <Kicker text={b.kicker} look={look} />
          {b.title ? <Text style={heading(look, 26, { letterSpacing: -0.6 })}>{b.title}</Text> : null}
        </View>
        {b.showAllLink ? (
          <TouchableOpacity onPress={() => onAction('/home')} accessibilityRole="link">
            <Text style={copy(look, 14, { fontWeight: '700' })}>See all →</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {list.length === 0 ? (
        <Text style={copy(look, 14, { opacity: 0.6, textAlign: 'center', paddingVertical: 24 })}>No kitchens available.</Text>
      ) : list.map((c) => (
        <TouchableOpacity
          key={c.id}
          onPress={() => onAction(`/brand/${c.slug}`)}
          accessibilityRole="link"
          activeOpacity={0.85}
          style={{ flexDirection: 'row', borderRadius: 16, borderWidth: 1, borderColor: border, backgroundColor: card, overflow: 'hidden', marginBottom: 12 }}>
          <View style={{ width: 6, backgroundColor: c.primaryColor ?? GREEN }} />
          <View style={{ flex: 1, padding: 16 }}>
            <Text style={heading({ ...look, fg: look.onLight ? INK : '#fff' }, 18)}>{formatBrandName(c.name)}</Text>
            {c.description ? (
              <Text numberOfLines={2} style={copy({ ...look, fg: look.onLight ? '#525252' : '#888' }, 13, { marginTop: 4 })}>{c.description}</Text>
            ) : null}
          </View>
        </TouchableOpacity>
      ))}
    </Container>
  )
}

interface MenuItemLite { id: string; name: string; description: string | null; priceCents: number; imageUrl: string | null }
type MenuResp = { categories?: Array<{ items?: MenuItemLite[] }>; items?: MenuItemLite[] } | Array<{ items?: MenuItemLite[] }>

function menuItems(resp: MenuResp | undefined): MenuItemLite[] {
  if (!resp) return []
  const cats = Array.isArray(resp) ? resp : resp.categories ?? []
  const out = cats.flatMap((c) => c.items ?? [])
  if (out.length === 0 && !Array.isArray(resp) && Array.isArray(resp.items)) return resp.items
  return out
}

const pkr = (cents: number) => `PKR ${Math.round(cents / 100).toLocaleString('en-PK')}`

function FeaturedMenuView({ b, look }: P<FeaturedMenuBlock>) {
  const ctx = useContext(Ctx)
  const slug = (b.conceptSlug ?? ctx.conceptSlug) as string
  const { width } = useWindowDimensions()
  // Same key + endpoint as the brand menu screen (one cached menu per brand).
  const { data } = useQuery({
    queryKey: ['menu', slug],
    queryFn: () => api.get<MenuResp>(`/storefront/${slug}/menu`),
  })
  const items = menuItems(data).slice(0, b.max ?? 6)
  if (items.length === 0) return null
  const cardW = Math.round(Math.min(width * 0.62, 280))
  const onThisMenu = ctx.conceptSlug === slug
  const card = look.onLight ? '#ffffff' : '#0d0f15'
  const cardFg: Look = { ...look, fg: look.onLight ? INK : '#fff' }
  return (
    <View>
      <Container>
        <Kicker text={b.kicker} look={look} />
        {b.title ? <Text style={heading(look, 26, { letterSpacing: -0.6, marginBottom: 16 })}>{b.title}</Text> : null}
      </Container>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: GUTTER, gap: 12 }}>
        {items.map((it) => (
          <TouchableOpacity
            key={it.id}
            disabled={onThisMenu}
            onPress={() => ctx.onAction(`/${slug}/menu`)}
            activeOpacity={0.85}
            style={{ width: cardW, borderRadius: 16, overflow: 'hidden', backgroundColor: card, borderWidth: 1, borderColor: look.onLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)' }}>
            {it.imageUrl
              ? <Image source={{ uri: it.imageUrl }} resizeMode="cover" style={{ width: '100%', aspectRatio: 4 / 3 }} />
              : <View style={{ width: '100%', aspectRatio: 4 / 3, backgroundColor: look.onLight ? GREEN_SOFT : '#2a1428' }} />}
            <View style={{ padding: 14 }}>
              <Text numberOfLines={1} style={heading(cardFg, 15)}>{it.name}</Text>
              {it.description ? <Text numberOfLines={2} style={copy(cardFg, 13, { opacity: 0.6, marginTop: 4 })}>{it.description}</Text> : null}
              <Text style={copy(cardFg, 14, { fontWeight: '800', marginTop: 8 })}>{pkr(it.priceCents)}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  )
}

interface ReviewsResp {
  reviews: Array<{ id: string; rating: number; comment: string | null; createdAt: string; customerName: string }>
  average: number | null
  total: number
}

function ReviewsView({ b, look }: P<ReviewsBlock>) {
  const ctx = useContext(Ctx)
  const slug = (b.conceptSlug ?? ctx.conceptSlug) as string
  const { data } = useQuery({
    queryKey: ['brand-reviews', slug],
    queryFn: () => api.get<ReviewsResp>(`/storefront/${slug}/reviews`),
    staleTime: 120_000,
  })
  if (!data || !data.total) return null
  const avg = data.average
  const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(Math.max(0, 5 - Math.min(5, n)))
  const card = look.onLight ? '#ffffff' : '#0d0f15'
  const cardFg: Look = { ...look, fg: look.onLight ? INK : '#fff' }
  return (
    <Container full={b.fullBleed}>
      <View style={{ alignItems: 'center', marginBottom: 20 }}>
        <Kicker text="Customer reviews" look={look} center />
        {b.showRating !== false && avg !== null ? (
          <Text style={heading(look, 32, { fontWeight: '900' })}>
            {avg.toFixed(1)}  <Text style={{ fontSize: 18 }}>{stars(Math.round(avg))}</Text>
          </Text>
        ) : null}
        <Text style={copy(look, 13, { opacity: 0.6, marginTop: 4 })}>
          Based on {data.total} verified order{data.total === 1 ? '' : 's'}
        </Text>
      </View>
      {data.reviews.slice(0, b.max ?? 6).map((r) => (
        <View key={r.id} style={{ backgroundColor: card, borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: look.onLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)' }}>
          <Text accessibilityLabel={`${r.rating} out of 5`} style={{ color: look.onLight ? INK : GREEN, fontSize: 14, marginBottom: 8 }}>{stars(r.rating)}</Text>
          {r.comment ? <Text style={copy(cardFg, 15, { marginBottom: 10 })}>{`“${r.comment}”`}</Text> : null}
          <Text style={copy(cardFg, 12, { opacity: 0.55 })}>
            {r.customerName} · {new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          </Text>
        </View>
      ))}
    </Container>
  )
}

function QuoteView({ b, look }: P<QuoteBlock>) {
  const ctx = useContext(Ctx)
  const size = { md: 20, lg: 24, xl: 28 }[b.size ?? 'lg'] ?? 24
  return (
    <Container full={b.fullBleed}>
      <Text style={heading(look, size, { fontWeight: '600', textAlign: 'center', lineHeight: Math.round(size * 1.35), letterSpacing: -0.4 })}>
        {interpolate(b.text, ctx)}
      </Text>
      {b.attribution ? (
        <Text style={copy(look, 14, { opacity: 0.55, textAlign: 'center', marginTop: 18 })}>{interpolate(b.attribution, ctx)}</Text>
      ) : null}
    </Container>
  )
}

function ColumnsView({ b }: P<ColumnsBlock>) {
  const { width } = useWindowDimensions()
  const row = b.stackOnMobile === false || width >= 768
  const gap = { sm: 12, md: 24, lg: 36 }[b.gap ?? 'md'] ?? 24
  return (
    <View style={{ flexDirection: row ? 'row' : 'column', gap }}>
      {b.columns.map((col, i) => (
        <View key={i} style={row ? { flex: 1 } : undefined}>
          <BlockRenderer blocks={(Array.isArray(col) ? col : []).filter((x) => x && (x as { type: string }).type !== 'columns')} />
        </View>
      ))}
    </View>
  )
}

const VIDEO_ASPECT: Record<NonNullable<VideoBlock['aspectRatio']>, number> = {
  '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5,
}

// No video player is a dependency of the app (expo-av / expo-video are not
// installed), so a video shows its poster with a play button that opens the
// file in the system player / browser.
function VideoView({ b, look }: P<VideoBlock>) {
  const { onAction } = useContext(Ctx)
  const ratio = VIDEO_ASPECT[b.aspectRatio ?? '16:9'] ?? 16 / 9
  const play = (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' }}>
        <View style={{
          width: 0, height: 0, marginLeft: 5,
          borderTopWidth: 12, borderBottomWidth: 12, borderLeftWidth: 20,
          borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: '#fff',
        }} />
      </View>
      <Text style={{ color: '#fff', fontFamily: look.body, fontSize: 13, fontWeight: '700', marginTop: 10 }}>Play video</Text>
    </View>
  )
  return (
    <Container full={b.fullBleed}>
      <TouchableOpacity onPress={() => onAction(b.url)} accessibilityRole="button" accessibilityLabel="Play video" activeOpacity={0.85}>
        {b.posterUrl ? (
          <ImageBackground source={{ uri: b.posterUrl }} resizeMode="cover" style={{ width: '100%', aspectRatio: ratio, justifyContent: 'center', backgroundColor: '#0a0a0a' }} imageStyle={{ borderRadius: b.fullBleed ? 0 : 16 }}>
            {play}
          </ImageBackground>
        ) : (
          <View style={{ width: '100%', aspectRatio: ratio, justifyContent: 'center', backgroundColor: '#0a0a0a', borderRadius: b.fullBleed ? 0 : 16 }}>{play}</View>
        )}
      </TouchableOpacity>
    </Container>
  )
}

function useSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    SecureStore.getItemAsync('servd_token')
      .then((t) => { if (alive) setSignedIn(!!t) })
      .catch(() => { if (alive) setSignedIn(false) })
    return () => { alive = false }
  }, [])
  return signedIn
}

// The app signs in on its own login screen; the form hands off to it.
// The web form verifies by WhatsApp code; the app just opens it (?src=app).
function WaitlistFormView({ b, look }: P<WaitlistFormBlock>) {
  const ctx = useContext(Ctx)
  const cardFg: Look = { ...look, fg: '#f3e7cd', onLight: false }
  return (
    <Container full={b.fullBleed}>
      <View style={{ backgroundColor: '#5a2156', borderRadius: 18, padding: 20 }}>
        <Text style={heading(cardFg, 22)}>{interpolate(b.title?.trim() || 'Be first in line.', ctx)}</Text>
        <Text style={copy(cardFg, 14, { opacity: 0.8, marginTop: 6 })}>
          {interpolate(b.subtitle?.trim() || 'Join the servd waitlist and we will message you on WhatsApp when a new brand opens.', ctx)}
        </Text>
        <View style={{ marginTop: 18 }}>
          <Button text={b.buttonText?.trim() || 'Join the waitlist'} href="/waitlist?src=app" kind="primary" size="md" look={cardFg} fullWidth />
        </View>
      </View>
    </Container>
  )
}

function SignupFormView({ b, look }: P<SignupFormBlock>) {
  const { onAction } = useContext(Ctx)
  const signedIn = useSignedIn()
  if (signedIn !== false) return null
  const isLogin = b.mode === 'login'
  const title = b.title ?? (isLogin ? 'Sign in' : 'Create your account')
  const card = look.onLight ? '#ffffff' : '#0d0f15'
  const cardFg: Look = { ...look, fg: look.onLight ? INK : '#fff' }
  return (
    <Container full={b.fullBleed}>
      <View style={{ backgroundColor: card, borderRadius: 18, padding: 20, borderWidth: 1, borderColor: look.onLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)' }}>
        <Text style={heading(cardFg, 22)}>{title}</Text>
        {b.subtitle ? <Text style={copy(cardFg, 14, { opacity: 0.65, marginTop: 6 })}>{b.subtitle}</Text> : null}
        <View style={{ marginTop: 18 }}>
          <Button text={isLogin ? 'Sign in' : 'Sign up'} href="/login" kind="primary" size="md" look={cardFg} fullWidth />
        </View>
      </View>
    </Container>
  )
}
