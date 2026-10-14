// Stripe shown on a test company's brand pages, ordering and order tracker.
// The API marks the concept payload `isTestCompany: true`; the field may be
// absent (older API, fallback records), so it is read defensively.
// Colours are servd tokens only — never a brand colour.

export function isTestConcept(concept: unknown): boolean {
  return !!concept && typeof concept === 'object' && (concept as { isTestCompany?: unknown }).isTestCompany === true
}

export function TestCompanyStripe({ concept, show }: { concept?: unknown; show?: boolean }) {
  if (!(show ?? isTestConcept(concept))) return null
  return (
    <div role="status" data-test-company-stripe
      style={{
        position: 'relative', zIndex: 60, width: '100%', textAlign: 'center',
        padding: '6px 16px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.04em',
        background: 'var(--servd-black)', color: '#fff',
        borderBottom: '2px solid var(--servd-danger)',
      }}>
      TEST — this brand is a test. Nothing here is real.
    </div>
  )
}
