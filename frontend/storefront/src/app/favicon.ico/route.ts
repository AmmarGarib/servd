import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { hostBrand } from '../../lib/brandDomains'
import { resolveConcept } from '../../lib/liveConcepts'
import { brandMark, servdKitMark } from '../brand/[slug]/brandArt'

// /favicon.ico — the icon browsers and Google ask for at the site root (owner, 2026-11-23: "link those to the logos
// we use per brand"). On a brand's own domain (simmer.pk, stackd.pk, flipd.pk) it is that brand's storefront logo
// (brandArt.tsx brandMark, the same art as /brand/<slug>/icon); on servd's hosts it is servd's own icon. This route
// replaces the app/favicon.ico file, which Next linked on EVERY page — brand pages included — so the brand's own
// icon lost to servd's S. On servd's hosts a published servd kit logo (servdKitMark) wins over the bundled file.
// The middleware never runs here (its matcher skips favicon), so Host is the visitor's.

export const dynamic = 'force-dynamic'

const CACHE = 'public, max-age=86400, s-maxage=86400'

async function servdIcon(): Promise<Response> {
  // The published servd kit's logo (Admin → Storefront → Brand kit → servd), else the bundled icon.
  const mark = await servdKitMark(48).catch(() => null)
  if (mark) return new ImageResponse(mark, { width: 48, height: 48, headers: { 'cache-control': CACHE } })
  const buf = await readFile(path.join(process.cwd(), 'public', 'brand', 'servd-favicon.ico'))
  return new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/x-icon', 'cache-control': CACHE } })
}

export async function GET(req: Request): Promise<Response> {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const slug = host ? await hostBrand(host).catch(() => null) : null
  if (!slug) return servdIcon()
  const concept = await resolveConcept(slug).catch(() => null)
  if (!concept) return servdIcon()
  const size = 48
  const { element, fonts } = await brandMark(concept, size)
  return new ImageResponse(element, {
    width: size, height: size,
    ...(fonts.length > 0 && { fonts }),
    headers: { 'cache-control': CACHE },
  })
}
