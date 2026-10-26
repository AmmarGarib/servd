'use client'

// The customer's internal member code as a Code 128 barcode (owner,
// 2026-10-26: "link an internal barcode for that customer in marketing
// module/customer profile"). Staff only — the code is never shown to the
// customer. Scanning it into the CRM search finds the customer
// (GET /crm/customers?search=<code>). "Print" opens a small label page.

import { useMemo } from 'react'
import { code128Svg } from '../../lib/code128'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export function MemberBarcode({ code, name, compact = false }: { code: string; name: string; compact?: boolean }) {
  const svg = useMemo(() => {
    try { return code128Svg(code, { height: compact ? 40 : 56, module: compact ? 1.5 : 2 }) } catch { return null }
  }, [code, compact])
  if (!svg) return null

  const print = () => {
    const w = window.open('', '_blank', 'width=420,height=320')
    if (!w) return
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(code)}</title>
      <style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif;background:#fff;color:#000}
      .l{text-align:center}.n{font-weight:700;font-size:14px;margin:0 0 6px}.c{font-family:ui-monospace,monospace;letter-spacing:.15em;font-size:13px;margin:6px 0 0}
      @page{margin:8mm}</style></head><body><div class="l"><p class="n">${escapeHtml(name)}</p>${code128Svg(code, { height: 70, module: 2 })}<p class="c">${escapeHtml(code)}</p></div>
      <script>window.onload=function(){window.print()}</script></body></html>`)
    w.document.close()
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="min-w-0 max-w-full rounded-md overflow-hidden border border-s-border [&>svg]:block [&>svg]:h-auto [&>svg]:max-w-full" style={{ lineHeight: 0 }}
        // Generated from the code alone (lib/code128.ts) — no user markup.
        dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-s-muted font-bold">Member code</p>
        <p className="font-mono text-sm text-s-text tracking-wider">{code}</p>
        <button type="button" onClick={print} className="text-xs font-bold text-primary-ink underline min-h-[32px]">Print</button>
      </div>
    </div>
  )
}
