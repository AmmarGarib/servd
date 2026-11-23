import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ImageResponse } from 'next/og'
import { servdKitMark } from './brand/[slug]/brandArt'

// servd's home-screen icon (180px, full-bleed — iOS rounds the corners) on servd's own pages (brand pages
// have their own: app/brand/[slug]/apple-icon.tsx). The published servd kit's logo
// (Admin → Storefront → Brand kit → servd) when there is one; else the bundled
// public/brand/servd-apple-icon.png — the file this route replaced (it used to be a static
// app/apple-icon.png), so with no servd kit nothing changes. Dynamic, so a publish
// shows without a rebuild.

export const dynamic = 'force-dynamic'
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

const CACHE = 'public, max-age=3600, s-maxage=3600'

export default async function ServdAppleIcon() {
  const mark = await servdKitMark(size.width, true).catch(() => null)
  if (mark) return new ImageResponse(mark, { ...size, headers: { 'cache-control': CACHE } })
  const buf = await readFile(path.join(process.cwd(), 'public', 'brand', 'servd-apple-icon.png'))
  return new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/png', 'cache-control': CACHE } })
}
