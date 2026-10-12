// W4 — the direct FBR / SRB filers are gone (spec §12, D6, §14).
//
// The external fiscal POS is the ONLY filer: servd talks to it through
// backend/src/connectors (the outbox in completeOrder / refundOrder). A
// deployed image must never carry both filers, so nothing in backend/src may
// reach the old adapters, their queues or workers, the SRB sync submit, the
// FBR credentials, or the old /integrations/tax/status route. The one-off
// legacy drain (connectors/legacyDrain.ts) is the only place allowed to name
// the old queues — it empties them once at boot.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|js|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(SRC).map((p) => ({ path: relative(SRC, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }))

/** Code only: line and block comments stripped, so a comment recording the removal does not count. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FORBIDDEN: Array<{ needle: string; allowIn?: string[] }> = [
  { needle: 'adapters/fbr' },
  { needle: 'adapters/srb' },
  { needle: 'getFbrQueue' },
  { needle: 'getSrbQueue' },
  { needle: 'FbrSubmissionJob' },
  { needle: 'SrbSubmissionJob' },
  { needle: 'fbrSubmission' },
  { needle: 'srbSubmission' },
  { needle: 'fbr-submission', allowIn: ['connectors/legacyDrain.ts'] },
  { needle: 'srb-submission', allowIn: ['connectors/legacyDrain.ts'] },
  { needle: 'submitSrb' },
  { needle: 'buildSrbDataForOrder' },
  { needle: 'buildFbrDataForOrder' },
  { needle: 'FBR_USERNAME' },
  { needle: 'SRB_USERNAME' },
  { needle: '/integrations/tax/status' },
  { needle: 'syncSrb' },
]

describe('the direct FBR / SRB tax path is removed', () => {
  it('the old adapters and workers no longer exist', () => {
    for (const p of ['adapters/fbr', 'adapters/srb', 'workers/fbrSubmission.ts', 'workers/srbSubmission.ts']) {
      expect(existsSync(join(SRC, p)), p).toBe(false)
    }
  })

  it.each(FORBIDDEN)('no code in backend/src mentions $needle', ({ needle, allowIn }) => {
    const hits = files
      .filter((f) => !(allowIn ?? []).includes(f.path))
      .filter((f) => codeOf(f.text).includes(needle))
      .map((f) => f.path)
    expect(hits).toEqual([])
  })

  it('the API registers the connector plugins and drains the legacy queues before starting the connector workers', () => {
    const index = codeOf(readFileSync(join(SRC, 'index.ts'), 'utf8'))
    expect(index).toContain('registerConnectorPlugins(api)')
    expect(index).toContain('registerPreBillPlugins(api)')
    const drain = index.indexOf('drainLegacyTaxQueues()')
    expect(drain).toBeGreaterThan(-1)
    expect(index.indexOf('startFiscalConnectorWorker()')).toBeGreaterThan(drain)
    expect(index.indexOf('startTerminalConnectorWorker()')).toBeGreaterThan(drain)
    expect(index).toContain('connectorHealthChecks()')
    expect(index).toContain('whatsappSecretHealth()')
  })

  it('a sale is enqueued for the fiscal POS in ONE place: completeOrder', () => {
    const callers = files.filter((f) => f.path !== 'connectors/fiscal/outbox.ts' && codeOf(f.text).includes('enqueueFiscalSaleTx(')).map((f) => f.path)
    expect(callers).toEqual(['modules/orders/service.ts'])
  })
})
