// /brand/[slug]/qr — printable table-card QR that lands customers
// directly on the brand's menu. Operator opens this page, prints,
// and clips it to the table card.
//
// The QR points at the absolute menu URL on prod so a scan from the
// dining room loads the menu without any base-URL ambiguity.

import { QRCard } from './QRCard'

const PUBLIC_HOST = process.env.NEXT_PUBLIC_PUBLIC_HOST ?? 'https://servd-app.garibsons.app'

const BRAND_NAMES: Record<string, string> = {
  simmer: 'Simmer',
  stackd:   'Stackd',
  flipd:  'Flipd',
}

export default async function BrandQRPage({
  params,
}: {
  params: Promise<{ slug: string }> | { slug: string }
}) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const brand = BRAND_NAMES[slug] ?? slug
  const url   = `${PUBLIC_HOST}/brand/${slug}/menu`
  return <QRCard slug={slug} brand={brand} url={url} />
}
