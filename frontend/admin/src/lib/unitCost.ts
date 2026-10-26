// Per-stock-unit costs (owner, 2026-10-26): a cost of one stock unit (a gram of saffron, one egg) is shown with 2
// decimals and its unit — "PKR 2.34 / g" — never rounded to whole rupees ("PKR 0" for an egg).

export function fmtUnitCost(cents: number | null | undefined, unit?: string | null): string {
  if (cents == null) return '—'
  const rupees = (cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `PKR ${rupees}${unit ? ` / ${unit}` : ''}`
}

/** ItemPriceHistory.source in words; a row with no supplier and no purchase source is a manual cost edit. */
export function priceSourceLabel(source: string, hasSupplier = true): string {
  if (source === 'manual_adjust' || (!hasSupplier && source !== 'po_receive' && source !== 'dock_receive' && source !== 'bill_match')) return 'Manual cost edit'
  if (source === 'po_receive' || source === 'dock_receive') return 'Receipt'
  if (source === 'bill_match') return 'Bill'
  return source.replace(/_/g, ' ')
}
