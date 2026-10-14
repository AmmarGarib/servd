// /health is public (no auth: api.servd.pk/health is curled from anywhere). The
// finance wave-B checks (fixed assets, petty cash, FIFO cut-over, chart
// template types, statutory reclass, card payouts) say 'ok' / 'warn' with a
// COUNT and where to look — never an amount, a company slug or name, or an
// item name (final gate, 2026-10-14: the details used to publish each
// company's petty-cash floats, unsettled card sales and payroll taxes in PKR).
// The route lives inline in src/index.ts, so this reads its source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
const start = src.indexOf('// ── Finance wave B (2026-10-14)')
const end = src.indexOf('// Upload storage.', start)
const block = src.slice(start, end)

describe('/health finance wave-B details are public-safe', () => {
  it('the block is found', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    for (const key of ['fixedAssets', 'pettyCash', 'fifoCutover', 'chartTemplateTypes', 'statutoryReclass', 'cardPayouts']) {
      expect(block, key).toContain(`details.${key} =`)
    }
  })

  it('no amount, company slug / name or item name is written into a detail', () => {
    const assignments = block.split('\n').filter((l) => /details\.\w+ =|details\[/.test(l) || /^\s*\+ `/.test(l) || /^\s*(notCut|loose)\.length \? `/.test(l))
    for (const line of assignments) {
      expect(line, line).not.toMatch(/PKR|pkr\(|\.slug\b|slugOf|companyName|\.name\b|Cents\b/)
    }
    expect(block).not.toMatch(/const pkr\b/)
  })
})
