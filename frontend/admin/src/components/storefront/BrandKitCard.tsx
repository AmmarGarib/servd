'use client'

// Read-only "Brand kit" card for Marketing -> Brands: the brand's LIVE kit
// (colours, fonts, pictures) and a button into the one place it is edited,
// Storefront -> Brand kit. Colours, pictures and fonts are no longer edited on
// the brand form: they change through the kit's draft -> CEO approval, and the
// publish keeps the brand's ordering colour and logo in step.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { kitHref, kitSlugOf, KIT_IMAGE_KEYS, type BrandKit } from '../../lib/content'
import { brandCatalog, kitLook, storefrontAsset, useBrandKitCatalog } from './kitCatalog'
import { KitSwatches } from './KitPanel'

const IMAGE_LABEL = { logo: 'Logo', wordmark: 'Wordmark', mascot: 'Mascot', badge: 'Badge' } as const

export function BrandKitCard({ slug, primaryColor, logoUrl }: { slug: string; primaryColor: string | null; logoUrl: string | null }) {
  const catalog = useBrandKitCatalog()
  // The public live read: { version, settings: { kit } | null }. Nothing here
  // needs the storefront module, only reads what the site shows.
  const live = useQuery<{ version: number; settings: { kit?: BrandKit } | null }>({
    queryKey: ['site-layout-live', kitSlugOf(slug)],
    queryFn: () => api.get(`/site-layouts/${encodeURIComponent(kitSlugOf(slug))}`),
  })
  const cat = brandCatalog(catalog.data, slug)
  const kit = live.data?.settings?.kit
  const look = kitLook(cat, kit, primaryColor, logoUrl)
  const fontLabel = (ref: string | undefined, def: string | undefined) => {
    const id = ref ?? def
    if (!id) return 'Built-in'
    if (id.startsWith('library:')) return 'Library font'
    return catalog.data?.fonts.find((f) => f.id === id)?.label ?? id
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-white/55">
          {live.data?.version ? `Live kit: version ${live.data.version}.` : 'No kit published: this brand uses its built-in look.'}
        </p>
        <Link href={kitHref(slug)} className="s-btn-primary text-xs">Edit in Storefront → Brand kit</Link>
      </div>

      {catalog.isError && <p className="text-xs text-s-red">{(catalog.error as Error).message} Colours show once it answers.</p>}

      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-1.5">Colours</p>
        <KitSwatches look={look} />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-white/65">
        <span><span className="text-white/40">Heading font </span>{fontLabel(kit?.fonts?.display, cat.fonts.display)}</span>
        <span><span className="text-white/40">Body font </span>{fontLabel(kit?.fonts?.body, cat.fonts.body)}</span>
      </div>

      <div className="flex flex-wrap gap-4">
        {KIT_IMAGE_KEYS.map((k) => {
          const src = storefrontAsset(kit?.images?.[k] ?? (k === 'logo' ? logoUrl : undefined) ?? cat.images[k])
          return (
            <div key={k} className="w-24">
              <div className="h-16 w-24 rounded-lg border border-s-border bg-s-elevated flex items-center justify-center overflow-hidden">
                {src
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={src} alt="" className="max-h-full max-w-full object-contain" />
                  : <span className="text-[10px] text-white/30">None</span>}
              </div>
              <p className="mt-1 text-[10px] text-white/45">{IMAGE_LABEL[k]}</p>
            </div>
          )
        })}
      </div>
      {cat.note && <p className="text-[10px] text-white/35">{cat.note}</p>}
    </div>
  )
}
