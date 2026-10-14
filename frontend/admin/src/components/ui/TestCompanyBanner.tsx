'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useViewAllTenants } from './TenantSwitcher'

// Strip under the header while the ACTIVE company is a test company.
// Shares the switcher's ['my-tenants'] query (/tenants/mine, field isTest).
export function TestCompanyBanner() {
  const viewAll = useViewAllTenants()
  const { data: tenants = [] } = useQuery<{ id: string; name: string; isActive?: boolean; isTest?: boolean }[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get('/tenants/mine'),
    staleTime: 30_000,
  })
  const active = tenants.find((t) => t.isActive) ?? tenants[0]
  if (viewAll || !active?.isTest) return null
  return (
    <div role="status" className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)',
        borderBottom: '1px solid color-mix(in srgb, var(--erp-warning) 40%, transparent)',
        color: 'var(--text)',
      }}>
      <span className="font-black uppercase tracking-wider" style={{ color: 'var(--erp-warning)' }}>Test</span>
      <span className="font-bold">Test company</span>
      <span style={{ color: 'rgb(var(--fg-rgb) / 0.6)' }}>— nothing here is real or sent to customers or FBR/SRB.</span>
    </div>
  )
}
