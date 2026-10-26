'use client'
// Spec list (owner, 2026-10-26 — kitchen flow K6): "a sheet defining the characteristics of what we BUY (e.g. burger
// meat = 80/20, coarse ground)". Every ingredient this company buys, by supplier, with its spec from servd's
// ingredient master (edited on Operations → Ingredients). Printable / exportable (GET /kitchen/spec-list?format=).
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { stockErrorText } from '../../../lib/stockUi'
import { ExportMenu } from '../../../components/ui/ExportMenu'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'

interface Row { supplier: string; ingredient: string; masterIngredientId: string | null; unit: string; boughtBy: string; spec: string; specDetails: string; status: string }

export default function SpecListPage() {
  const [q, setQ] = useState('')
  const { data, isLoading, error } = useQuery<{ rows: Row[] }>({ queryKey: ['kitchen', 'spec-list'], queryFn: () => api.get('/kitchen/spec-list') })
  const bySupplier = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of data?.rows ?? []) {
      if (q && !`${r.ingredient} ${r.spec}`.toLowerCase().includes(q.toLowerCase())) continue
      m.set(r.supplier, [...(m.get(r.supplier) ?? []), r])
    }
    return [...m.entries()]
  }, [data, q])
  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-success">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Spec list</h1>
          <p className="text-xs text-s-muted">What we buy, and how it must come. Specs are edited on <Link href="/kitchen/ingredients" className="text-primary-ink underline">Ingredients</Link>.</p>
        </div>
        <div className="flex items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="s-input w-auto" aria-label="Search" />
          <ExportMenu path="/kitchen/spec-list" filename="spec-list" />
        </div>
      </header>
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        {isLoading ? <p className="text-sm text-s-muted">Loading…</p>
          : error ? <p className="text-sm text-s-red">{stockErrorText(error)}</p>
          : bySupplier.length === 0 ? <CompactEmptyState message="No ingredients yet." />
          : bySupplier.map(([supplier, rows]) => (
            <section key={supplier} className="s-card overflow-x-auto">
              <h2 className="px-4 pt-3 text-sm font-bold text-s-text">{supplier}</h2>
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted"><tr><th className="px-3 py-2 text-left">Ingredient</th><th className="px-3 py-2 text-left">Bought by</th><th className="px-3 py-2 text-left">Spec</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.ingredient}-${r.masterIngredientId}`} className="border-t border-s-border align-top">
                      <td className="px-3 py-2">{r.ingredient}{r.status && <span className="ml-2 s-badge-purple text-[10px] px-1.5 py-0.5 rounded">{r.status}</span>}</td>
                      <td className="px-3 py-2 text-s-muted">{r.boughtBy}</td>
                      <td className="px-3 py-2">{r.spec || <span className="text-s-muted">No spec yet</span>}{r.specDetails && <span className="block text-xs text-s-muted">{r.specDetails}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
      </div>
    </div>
  )
}
