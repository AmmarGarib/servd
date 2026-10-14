'use client'

// Brand kit tab of the Storefront hub: every brand with the colours it shows
// now, where its kit stands (Live / Draft / Waiting for CEO / Scheduled) and a
// way into the kit editor. The colours come from the storefront's own list
// (kitCatalog.ts) plus the brand's live kit, so nothing here knows a palette.

import Link from 'next/link'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  contentApi, fmtDateTime, kitHref, kitSlugOf, STOREFRONT_BRANDS_KEY,
  type ConceptLite, type LayoutEdit, type LayoutSummary,
} from '../../lib/content'
import { brandCatalog, kitLook, useBrandKitCatalog, type KitLook } from './kitCatalog'
import { StatusBadge } from './panels'

export function KitSwatches({ look }: { look: KitLook }) {
  const colours = [
    ...look.palette.map((p) => ({ key: `p-${p.key}`, label: p.label, value: p.value })),
    ...(['accent', 'surfaceBg', 'surfaceText', 'ordering'] as const)
      .filter((k) => !!look.roles[k])
      .map((k) => ({
        key: `r-${k}`,
        label: { accent: 'Website signal colour', surfaceBg: 'Band / footer background', surfaceText: 'Band / footer text', ordering: 'Ordering & ERP colour' }[k],
        value: look.roles[k]!,
      })),
  ]
  if (colours.length === 0) return <span className="text-[11px] text-s-muted">No colours listed</span>
  return (
    <span className="inline-flex flex-wrap gap-1">
      {colours.map((c) => (
        // The swatch is the brand's own colour (data), so it is an inline background.
        <span key={c.key} title={`${c.label} ${c.value}`} className="h-5 w-5 rounded-full border border-s-border" style={{ background: c.value }} />
      ))}
    </span>
  )
}

export function KitPanel() {
  const concepts = useQuery<ConceptLite[]>({ queryKey: STOREFRONT_BRANDS_KEY, queryFn: contentApi.brands })
  const layouts = useQuery<LayoutSummary[]>({ queryKey: ['site-layouts', 'all'], queryFn: () => contentApi.list({ status: 'all' }) })
  const catalog = useBrandKitCatalog()
  const brands = concepts.data ?? []
  // The live kit of each brand (same cache entry the editor uses).
  const kits = useQueries({
    queries: brands.map((c) => ({
      queryKey: ['site-layout-edit', kitSlugOf(c.slug)],
      queryFn: () => contentApi.edit(kitSlugOf(c.slug)),
    })),
  })
  const bySlug = new Map((layouts.data ?? []).map((r) => [r.slug, r]))

  return (
    <div className="space-y-4">
      <p className="text-xs text-s-muted">
        Each brand&apos;s look in one place: its colours, two fonts and four pictures. Nothing changes until something is set here and the CEO approves it.
      </p>
      {concepts.isError && <p className="text-sm text-s-red">Could not load brands: {(concepts.error as Error).message}</p>}
      {catalog.isError && (
        <div role="alert" className="s-card border-s-red/40 p-4 flex flex-wrap items-center gap-3">
          <p className="flex-1 min-w-[16rem] text-xs text-s-text">{(catalog.error as Error).message} The colours show once it answers.</p>
          <button type="button" onClick={() => void catalog.refetch()} disabled={catalog.isFetching} className="s-btn-secondary text-xs shrink-0">
            {catalog.isFetching ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}
      {concepts.isLoading && <p className="text-xs text-s-muted">Loading brands...</p>}
      {concepts.isSuccess && brands.length === 0 && <p className="text-xs text-s-muted">No brands yet.</p>}
      {brands.length > 0 && (
        <div className="s-card overflow-x-auto">
          <table className="s-table">
            <thead><tr><th>Brand</th><th>Colours now</th><th>Live</th><th>Draft</th><th>Last edited</th><th /></tr></thead>
            <tbody>
              {brands.map((c, i) => {
                const slug = kitSlugOf(c.slug)
                const row = bySlug.get(slug)
                const live = (kits[i]?.data as LayoutEdit | undefined)?.settings?.kit
                const look = kitLook(brandCatalog(catalog.data, c.slug), live, c.primaryColor, c.logoUrl)
                return (
                  <tr key={c.slug}>
                    <td>
                      <Link href={kitHref(c.slug)} className="flex items-center gap-2 font-semibold text-s-text hover:text-primary-ink">
                        {look.logo && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={look.logo} alt="" className="h-6 w-6 rounded object-contain bg-s-elevated" />
                        )}
                        {c.name}
                      </Link>
                      <p className="text-[11px] text-s-muted font-mono">{c.slug}</p>
                    </td>
                    <td><KitSwatches look={look} /></td>
                    <td className="text-xs">{row?.liveVersion ? `v${row.liveVersion}` : <span className="text-s-muted">Built-in look</span>}</td>
                    <td>{row ? <StatusBadge row={row} showNote /> : <span className="s-badge-muted">No draft</span>}</td>
                    <td className="text-xs text-s-muted">{fmtDateTime(row?.draftUpdatedAt ?? row?.updatedAt ?? null)}</td>
                    <td className="text-right text-xs"><Link href={kitHref(c.slug)} className="text-primary-ink hover:underline">Edit</Link></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
