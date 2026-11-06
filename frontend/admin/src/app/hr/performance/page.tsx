'use client'
// HR → Performance: evaluation cycles and the results dashboard.

import { useState } from 'react'
import { HrShell } from '../../../components/hr/HrShell'
import { ResultsView } from '../../../components/hr/performance/ResultsView'
import { CyclesView } from '../../../components/hr/performance/CyclesView'

export default function PerformancePage() {
  const [tab, setTab] = useState<'results' | 'cycles'>('results')
  return (
    <HrShell title="Performance" subtitle="Evaluation cycles, results and training needs across the company.">
      <div role="tablist" aria-label="Performance" className="flex gap-1 mb-5 border-b border-white/[0.07]">
        {([['results', 'Results'], ['cycles', 'Cycles']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="px-4 py-2.5 text-sm font-bold border-b-2 -mb-px min-h-[44px]"
            style={{ borderColor: tab === k ? 'var(--erp-accent)' : 'transparent', color: tab === k ? 'rgb(var(--fg-rgb) / 0.95)' : 'rgb(var(--fg-rgb) / 0.55)' }}>{l}</button>
        ))}
      </div>
      {tab === 'results' ? <ResultsView /> : <CyclesView />}
    </HrShell>
  )
}
