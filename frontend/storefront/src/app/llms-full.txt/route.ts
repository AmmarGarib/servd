// /llms-full.txt — the long companion to /llms.txt: everything a language
// model needs to answer "what does X serve, what does it cost, where is it,
// when is it open, how do I order" without crawling. Plain text, per host:
// servd.pk lists every kitchen on servd; stackd.pk / simmer.pk / flipd.pk
// describe that one brand. Each kitchen gets its description, address, phone,
// hours, ordering options and its full menu with prices in PKR, read from the
// same public API the ordering page uses (so it can't drift from the site).
// The FAQ is the live `servd:faq` page (Admin → Storefront), else the draft
// defaults.
//
// Built per request (force-dynamic) behind a short in-memory cache: a good
// build is served for CACHE_MS, then rebuilt once (single flight) while the
// last good text keeps answering; a build whose menus did not all load is only
// kept for RETRY_MS, never baked in (CLAUDE.md "Fetch caching gotcha").
// Simmer's lines keep Simmer's rules (no exclamation marks, no emoji).

import type { NextRequest } from 'next/server'
import { SERVD_ORIGIN, brandCanonical, hostBrand } from '../../lib/brandDomains'
import { addressLine, filled, isPublishableLocation, locationFromConcept, mapLinkOf, type BrandLocation } from '../../lib/brandLocations'
import { fetchSiteLayout } from '../../lib/blocks'
import { formatBrandName, type Concept } from '../../lib/concept'
import { fulfilmentFor, type FulfilmentOption } from '../../lib/fulfilment'
import { conceptsOrFallback, fetchLiveConcepts, findConcept, isServdCompanyBrand } from '../../lib/liveConcepts'
import { mergeFields } from '../../sections/catalog'
import { simmerText } from '../../sections/simmer/shared'
import { hoursSummary, priceWords } from '../../sections/servd/brandFacts'
import { FAQ_DEFAULTS, faqItemsOf, type FaqItem } from '../../sections/servd/faqData'

export const dynamic = 'force-dynamic'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const SERVD_EMAIL = 'servd@gsfoods.pk'
const CACHE_MS = 60_000
const RETRY_MS = 5_000
const TIMEOUT_MS = 4_000

// ─── Menu ───────────────────────────────────────────────────────────────────

interface MenuItem { name?: unknown; description?: unknown; priceCents?: unknown; isAvailable?: unknown; dietary?: unknown }
interface MenuCategory { name?: unknown; sortOrder?: unknown; items?: unknown }
interface Menu { categories: Array<{ name: string; items: Array<{ name: string; description: string; priceCents: number; dietary: string[] }> }>; isTestCompany: boolean }

async function getJson(path: string): Promise<unknown | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_URL}${path}`, { cache: 'no-store', signal: ctrl.signal })
    return res.ok ? await res.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** GET /storefront/<slug>/menu → the dishes that can be ordered now, in menu
 *  order. null = the API did not answer. */
async function fetchMenu(slug: string): Promise<Menu | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug)) return null
  const body = await getJson(`/api/v1/storefront/${encodeURIComponent(slug)}/menu`) as
    | MenuCategory[] | { categories?: MenuCategory[]; concept?: { isTestCompany?: boolean } } | null
  if (!body) return null
  const cats = Array.isArray(body) ? body : body.categories
  if (!Array.isArray(cats)) return null
  const categories = [...cats]
    .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
    .map((c) => ({
      name: typeof c.name === 'string' ? c.name.trim() : '',
      items: (Array.isArray(c.items) ? (c.items as MenuItem[]) : [])
        .filter((i) => i && typeof i.name === 'string' && i.name.trim() && i.isAvailable !== false && typeof i.priceCents === 'number')
        .map((i) => ({
          name: String(i.name).trim(),
          description: typeof i.description === 'string' ? i.description : '',
          priceCents: i.priceCents as number,
          dietary: Array.isArray(i.dietary) ? (i.dietary as unknown[]).filter((d): d is string => typeof d === 'string') : [],
        })),
    }))
    .filter((c) => c.items.length > 0)
  return { categories, isTestCompany: !Array.isArray(body) && body.concept?.isTestCompany === true }
}

// ─── Text helpers ───────────────────────────────────────────────────────────

/** One line of text; Simmer's copy keeps Simmer's rules wherever it appears. */
function oneLine(slug: string, text: unknown): string {
  const s = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim()
  return slug === 'simmer' ? simmerText(s) : s
}

/** "PKR 1,250" (paisa shown only when there is some). */
function pkr(cents: number): string {
  const rupees = cents / 100
  return `PKR ${rupees.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

const FULFILMENT_WORDS: Record<FulfilmentOption, string> = {
  'dine-in': 'dine-in', pickup: 'pickup', curbside: 'curbside', delivery: 'delivery',
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

interface Kitchen { concept: Concept; loc: BrandLocation; name: string; menu: Menu | null }

function kitchenText(k: Kitchen, level: '##' | '###'): string[] {
  const { concept: c, loc, name, menu } = k
  const slug = c.slug
  const sub = level === '##' ? '###' : '####'
  const street = filled(loc.street)
  const place = [street, filled(loc.area), filled(loc.city)].filter(Boolean).join(', ') || addressLine(loc)
  const hours = hoursSummary(c.serviceHours)
  const options = fulfilmentFor(slug).map((o) => FULFILMENT_WORDS[o])
  const profiles = loc.sameAs ?? []
  const desc = oneLine(slug, c.description || findConcept(slug, [])?.description)

  const out: string[] = [`${level} ${name}`, '']
  if (desc) out.push(desc, '')
  out.push(
    `- Cuisine: ${filled(loc.cuisine) || 'not listed'}`,
    `- Price range: ${filled(loc.priceRange) ? priceWords(loc.priceRange) : 'not listed'}`,
    `- Address: ${place || 'Karachi, Pakistan'}`,
    `- Phone: ${filled(loc.phone) || 'not listed'}`,
    ...(filled(loc.whatsapp) ? [`- WhatsApp: +${filled(loc.whatsapp)}`] : []),
    ...(filled(loc.email) ? [`- Email: ${filled(loc.email)}`] : []),
    `- Opening hours (Karachi time): ${hours || 'not listed'}`,
    `- How to get an order: ${options.join(', ')}`,
    `- Reservations: ${loc.acceptsReservations ? `yes, ${SERVD_ORIGIN}/reserve/${slug}` : 'no'}`,
    `- Website: ${brandCanonical(slug)}`,
    `- Order online: ${SERVD_ORIGIN}/${slug}`,
    ...(isPublishableLocation(loc) ? [`- Location page: ${SERVD_ORIGIN}/locations/${loc.locationSlug}`] : []),
    ...(mapLinkOf(loc) ? [`- Map: ${mapLinkOf(loc)}`] : []),
    ...profiles.map((p) => `- Profile: ${p}`),
    '',
  )

  out.push(`${sub} ${name} menu (prices in PKR)`, '')
  if (!menu || menu.categories.length === 0) {
    out.push(`The ${name} menu is at ${SERVD_ORIGIN}/${slug}.`, '')
  } else {
    for (const cat of menu.categories) {
      if (cat.name) out.push(`**${oneLine(slug, cat.name)}**`, '')
      for (const it of cat.items) {
        const tags = it.dietary.length ? ` (${it.dietary.map((d) => d.replace(/_/g, ' ')).join(', ')})` : ''
        const d = oneLine(slug, it.description)
        out.push(`- ${oneLine(slug, it.name)}: ${pkr(it.priceCents)}${tags}${d ? `. ${d}` : ''}`)
      }
      out.push('')
    }
  }
  return out
}

// ─── FAQ ────────────────────────────────────────────────────────────────────

/** The live servd:faq page's questions; the draft defaults while the owner has
 *  published nothing for it. */
async function loadFaq(): Promise<FaqItem[]> {
  try {
    const layout = await fetchSiteLayout('servd:faq')
    if (layout?.blocks?.length) {
      const items: FaqItem[] = []
      for (const b of layout.blocks) {
        if (b.type === 'section' && b.variant === 'servd.faq' && !b.hidden) {
          items.push(...faqItemsOf(mergeFields('servd.faq', b.fields)['items']))
        }
      }
      return items
    }
  } catch { /* fall through to the defaults */ }
  return FAQ_DEFAULTS
}

function faqText(items: FaqItem[]): string[] {
  if (!items.length) return []
  return [
    '## Frequently asked questions', '',
    ...items.flatMap((q) => [`**${q.question.replace(/\s+/g, ' ')}**`, q.answer.replace(/\n+/g, ' '), '']),
  ]
}

// ─── The two files ──────────────────────────────────────────────────────────

const PAY_LINE = 'Payment: Cash, Card and Raast QR (the options for an order are shown at checkout). All prices are in Pakistani rupees (PKR).'

function pageLinks(): string[] {
  return [
    '## Pages', '',
    `- ${SERVD_ORIGIN}/ : every kitchen in one place`,
    `- ${SERVD_ORIGIN}/about : what servd is`,
    `- ${SERVD_ORIGIN}/faq : questions and answers`,
    `- ${SERVD_ORIGIN}/contact : contact servd`,
    `- ${SERVD_ORIGIN}/reserve : book a table`,
    `- ${SERVD_ORIGIN}/llms.txt : short map of the site`,
    '',
  ]
}

async function build(slug: string | null): Promise<{ text: string; complete: boolean }> {
  const [live, faq] = await Promise.all([fetchLiveConcepts(), loadFaq()])
  const all = conceptsOrFallback(live).filter((c) => !c.isTestCompany)
  const own = slug ? findConcept(slug, live) : null
  const chosen = own ? [own] : all
  const kitchens: Kitchen[] = await Promise.all(chosen.map(async (c) => ({
    concept: c,
    loc: locationFromConcept(c),
    name: formatBrandName(c.name),
    menu: await fetchMenu(c.slug),
  })))
  // A hidden test-company menu is not published.
  const shown = kitchens.filter((k) => !k.menu?.isTestCompany)
  const complete = shown.every((k) => k.menu !== null)

  const out: string[] = []
  if (own && shown[0]) {
    const k = shown[0]
    const where = addressLine(k.loc) || 'Karachi'
    out.push(
      `# ${k.name}: full details`, '',
      `> ${k.name} is a restaurant in ${where}, Pakistan${isServdCompanyBrand(k.concept.slug, live) ? ', run by GS Foods' : ''}. Orders are taken online through servd (${SERVD_ORIGIN}/), the ordering platform it uses.`, '',
      PAY_LINE, '',
      ...kitchenText(k, '##'),
      ...faqText(faq),
      '## Contact', '',
      `- Email servd: ${SERVD_EMAIL}`,
      `- servd contact page: ${SERVD_ORIGIN}/contact`, '',
      ...pageLinks(),
    )
  } else {
    const names = listNames(shown.map((k) => k.name))
    out.push(
      '# servd: full details', '',
      `> servd is the online ordering platform of GS Foods, a restaurant group in Karachi, Pakistan. It brings ${shown.length} kitchens together in one place${names ? `: ${names}` : ''}. Pick a kitchen, see its menu with prices in PKR, and order for pickup, delivery or dining in.`, '',
      PAY_LINE, '',
      'servd has a free rewards programme called Insiders. Table bookings are taken at the kitchens that accept reservations.', '',
      '## Kitchens', '',
      ...shown.flatMap((k) => kitchenText(k, '###')),
      ...faqText(faq),
      '## Contact', '',
      `- Email: ${SERVD_EMAIL}`,
      `- Contact page: ${SERVD_ORIGIN}/contact`, '',
      ...pageLinks(),
    )
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', complete }
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface Entry { text: string; until: number }
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<string>>()

async function textFor(slug: string | null): Promise<string> {
  const key = slug ?? '*servd'
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.text
  let p = inflight.get(key)
  if (!p) {
    p = build(slug)
      .then(({ text, complete }) => {
        cache.set(key, { text, until: Date.now() + (complete ? CACHE_MS : RETRY_MS) })
        return text
      })
      // A failed build keeps serving the last good text, if there is one.
      .catch((e) => { if (hit) return hit.text; throw e })
      .finally(() => { inflight.delete(key) })
    inflight.set(key, p)
  }
  return p
}

export async function GET(req: NextRequest) {
  const host = await hostBrand(req.headers.get('host') ?? '')
  const slug = host
  let text: string
  try {
    text = await textFor(slug)
  } catch {
    return new Response('llms-full.txt is temporarily unavailable.\n', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30' },
    })
  }
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      // For language models, not for the search results page.
      'X-Robots-Tag': 'noindex',
    },
  })
}
