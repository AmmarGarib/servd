// The artwork behind a brand's share card (./opengraph-image.tsx) and its
// browser / home-screen icons (./icon.tsx, ./apple-icon.tsx) — the same
// ImageResponse convention as servd's own card (src/app/opengraph-image.tsx).
//
// Colours come from the brand's own palette (brandSurface / brandAccent in
// lib/concept.ts), never literals here. Artwork is the brand's own: the
// wordmark / logo uploaded in Admin → Brands, else the asset bundled in this
// build (read from public/, which the Docker image ships), else the name set
// as type. Simmer follows its SKILL rules: a flat tiber field, bone type, the
// lowercase wordmark with `simmer down.` BELOW it, the full stop the one
// orange signal; no white, no gradient.
//
// Fonts are fetched from Google Fonts (the families globals.css uses), cached
// for a day; if that fails the card still renders in the built-in face.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ReactElement } from 'react'
import { brandAccent, brandSurface, formatBrandName, type Concept } from '../../../lib/concept'

type Font = { name: string; data: ArrayBuffer; weight: 400 | 500 | 700 | 800 | 900; style: 'normal' }

const FETCH_TIMEOUT_MS = 3_000

/** One weight of a Google font, subset to `text`. null when unavailable. */
async function googleFont(family: string, weight: Font['weight'], text: string): Promise<Font | null> {
  if (!text.trim()) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const axis = weight === 400 ? '' : `:wght@${weight}`
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}${axis}&text=${encodeURIComponent(text)}`
    const css = await (await fetch(cssUrl, { signal: ctrl.signal, next: { revalidate: 86_400 } })).text()
    const src = /src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype)'\)/.exec(css)?.[1]
    if (!src) return null
    const res = await fetch(src, { signal: ctrl.signal, next: { revalidate: 86_400 } })
    if (!res.ok) return null
    return { name: family, data: await res.arrayBuffer(), weight, style: 'normal' }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' }

/** A file bundled in public/ as a data URI (null when missing / unsupported). */
async function publicImage(rel: string): Promise<string | null> {
  const ext = path.extname(rel).toLowerCase()
  const mime = MIME[ext]
  if (!mime || rel.includes('..')) return null
  try {
    const buf = await readFile(path.join(process.cwd(), 'public', rel.replace(/^\/+/, '')))
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** An uploaded image (https URL, or a path in public/) as a data URI — fetched
 *  here, with a timeout, so a slow or broken upload falls back instead of
 *  failing the whole image. */
async function artwork(src: string | null | undefined): Promise<string | null> {
  const s = (src ?? '').trim()
  if (!s) return null
  if (s.startsWith('/') && !s.startsWith('//')) return publicImage(s)
  if (!/^https:\/\//i.test(s)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(s, { signal: ctrl.signal, cache: 'no-store' })
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!res.ok || !Object.values(MIME).includes(type)) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Relative luminance of a #rrggbb colour (null when not a hex colour). */
function luminance(color: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!m?.[1]) return null
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(m[1]!.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
}

/** Of the brand's two surface colours, the one that reads best on `bg`. */
function inkOn(bg: string, a: string, b: string): string {
  const L = luminance(bg)
  const la = luminance(a)
  const lb = luminance(b)
  if (L === null || la === null || lb === null) return b
  const contrast = (x: number) => (Math.max(L, x) + 0.05) / (Math.min(L, x) + 0.05)
  return contrast(la) >= contrast(lb) ? a : b
}

/** The artwork each brand's card falls back to when nothing is uploaded. */
const BUNDLED_ART: Record<string, { src: string; width: number; height: number }> = {
  stackd: { src: '/brand/stackd-wordmark-tagline.png', width: 599, height: 195 },
  flipd:  { src: '/brand/flipd-badge.png', width: 760, height: 760 },
}

export const OG_SIZE = { width: 1200, height: 630 }

/** The brand's 1200×630 share card, and the fonts it needs. */
export async function brandCard(concept: Concept): Promise<{ element: ReactElement; fonts: Font[] }> {
  const slug = concept.slug
  const surface = brandSurface(slug)
  const accent = brandAccent(slug, concept.primaryColor)
  const name = formatBrandName(concept.name)
  const about = (concept.description ?? '').replace(/\s+/g, ' ').trim()
  const line = about.length > 120 ? `${about.slice(0, 117).replace(/\s+\S*$/, '')}…` : about
  const frame = {
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column' as const,
    alignItems: 'center', justifyContent: 'center', background: surface.bg, padding: '64px 96px',
  }

  // Simmer: the lowercase wordmark set in Amarante, `simmer down.` below it.
  if (slug === 'simmer') {
    const mark = name.toLowerCase()
    const tagline = 'simmer down'
    const uploaded = await artwork(concept.wordmarkUrl)
    const font = await googleFont('Amarante', 400, `${mark}${tagline}.`)
    return {
      fonts: font ? [font] : [],
      element: (
        <div style={{ ...frame, fontFamily: 'Amarante' }}>
          {uploaded
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={uploaded} alt="" width={760} height={250} style={{ objectFit: 'contain' }} />
            : <div style={{ display: 'flex', fontSize: 210, lineHeight: 1, color: surface.text }}>{mark}</div>}
          <div style={{ display: 'flex', fontSize: 58, marginTop: 36, color: surface.text, letterSpacing: 2 }}>
            <span>{tagline}</span>
            <span style={{ color: accent }}>.</span>
          </div>
        </div>
      ),
    }
  }

  const bundled = BUNDLED_ART[slug]
  const art = (await artwork(concept.wordmarkUrl)) ?? (bundled ? await publicImage(bundled.src) : null)
  const square = slug === 'flipd'
  const [display, body] = await Promise.all([
    art ? Promise.resolve(null) : googleFont('Bricolage Grotesque', 800, `${name}.`),
    googleFont('Inter', 500, line),
  ])
  // Use fetched fonts only when every line has one; else the built-in face.
  const fonts = [display, body].filter((f): f is Font => !!f)
  const complete = (art || display) && (!line || body)
  return {
    fonts: complete ? fonts : [],
    element: (
      <div style={frame}>
        {art
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={art} alt="" width={square ? 360 : 820} height={square ? 360 : 267} style={{ objectFit: 'contain' }} />
          : (
            <div style={{ display: 'flex', fontFamily: 'Bricolage Grotesque', fontSize: 170, fontWeight: 800, letterSpacing: -6, lineHeight: 1, color: surface.text }}>
              <span>{name}</span>
              <span style={{ color: accent }}>.</span>
            </div>
          )}
        {line && (
          <div style={{
            display: 'flex', fontFamily: 'Inter', fontSize: 34, fontWeight: 500, lineHeight: 1.35,
            color: surface.muted, marginTop: square ? 28 : 44, textAlign: 'center', maxWidth: 940,
          }}>
            {line}
          </div>
        )}
      </div>
    ),
  }
}

/** The monogram's type: servd's display face, except Simmer, whose SKILL
 *  allows only Amarante and keeps its mark lowercase. A lowercase letter is
 *  set larger so its x-height fills the disc as a capital does, and nudged up
 *  so it sits in the middle of the disc rather than on the line box's
 *  baseline. */
function monogram(concept: Concept): { letter: string; family: string; weight: Font['weight']; scale: number; lift: number } {
  const first = formatBrandName(concept.name).charAt(0)
  return concept.slug === 'simmer'
    ? { letter: first.toLowerCase(), family: 'Amarante', weight: 400, scale: 0.78, lift: 0.1 }
    : { letter: first, family: 'Bricolage Grotesque', weight: 800, scale: 0.56, lift: 0 }
}

/**
 * The brand's icon at `size` px: the header's disc — the accent colour with
 * the brand's logo in it, else its monogram (the display name's first letter;
 * Simmer's is a lowercase Amarante `s`) in whichever of the brand's surface
 * colours reads on the accent. `square` fills the whole tile (the home-screen
 * icon, which iOS masks itself).
 */
export async function brandMark(concept: Concept, size: number, square = false): Promise<{ element: ReactElement; fonts: Font[] }> {
  const surface = brandSurface(concept.slug)
  const accent = brandAccent(concept.slug, concept.primaryColor)
  const mono = monogram(concept)
  const logo = await artwork(concept.logoUrl)
  const font = logo ? null : await googleFont(mono.family, mono.weight, mono.letter)
  return {
    fonts: font ? [font] : [],
    element: (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', ...(square && { background: accent }) }}>
        <div style={{
          width: square ? '100%' : size, height: square ? '100%' : size,
          borderRadius: square ? 0 : '50%', overflow: 'hidden', background: accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: mono.family, fontWeight: mono.weight, fontSize: Math.round(size * mono.scale), lineHeight: 1,
          color: inkOn(accent, surface.bg, surface.text),
        }}>
          {logo
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logo} alt="" width={size} height={size} style={{ objectFit: 'cover' }} />
            : <span style={{ display: 'flex', ...(mono.lift && { marginTop: -Math.round(size * mono.lift) }) }}>{mono.letter}</span>}
        </div>
      </div>
    ),
  }
}
