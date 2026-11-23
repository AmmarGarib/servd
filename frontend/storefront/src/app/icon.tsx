import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { servdKitMark } from './brand/[slug]/brandArt'

// servd's favicon (192px) on servd's own pages (brand pages
// have their own: app/brand/[slug]/icon.tsx). The published servd kit's logo
// (Admin → Storefront → Brand kit → servd) when there is one; else the bundled
// public/brand/servd-icon.png — the file this route replaced (it used to be a static
// app/icon.png), so with no servd kit nothing changes. Dynamic, so a publish
// shows without a rebuild.

export const dynamic = 'force-dynamic'
export const size = { width: 192, height: 192 }
export const contentType = 'image/png'

const CACHE = 'public, max-age=3600, s-maxage=3600'

export default async function ServdIcon() {
  const mark = await servdKitMark(size.width, false).catch(() => null)
  if (mark) return new ImageResponse(mark, { ...size, headers: { 'cache-control': CACHE } })
  const buf = await readFile(path.join(process.cwd(), 'public', 'brand', 'servd-icon.png'))
  return new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/png', 'cache-control': CACHE } })
}
