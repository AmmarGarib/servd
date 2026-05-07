'use client'
import { ConfigStubPage } from '../_StubPage'

export default function AuditLogConfigPage() {
  return (
    <ConfigStubPage
      icon="📜"
      title="Audit Log"
      description="Who did what, when — refunds, voids, comps, price overrides."
      whyItMatters="When a manager refunds a 5,000-rupee order at 2am, you want to know why. The audit log is your forensic record: every refund, void, comp, price override, and config change is captured with the user, IP, and reason."
      defaults={[
        { label: 'Order refunds', value: 'Logged', hint: 'Includes reason (mandatory) + before/after totals' },
        { label: 'Item voids', value: 'Logged', hint: 'After firing — manager-only with reason' },
        { label: 'Comp / freebie', value: 'Logged + reason required', hint: 'Manager PIN required at POS' },
        { label: 'Price overrides',  value: 'Logged', hint: 'Any deviation from menu price captures user + reason' },
        { label: 'Permission changes',  value: 'Logged',  hint: 'Role escalations + station assignments' },
        { label: 'Failed logins',  value: 'Last 90 days',  hint: 'IP, email attempted, fingerprint' },
        { label: 'Inventory adjustments', value: 'Logged', hint: 'Manual stock corrections show user + delta + reason' },
        { label: 'Concept config edits', value: 'Logged', hint: 'Tax rate / hours / branding changes' },
        { label: 'Retention', value: '7 years', hint: 'Pakistan tax authority recommendation' },
      ]}
    />
  )
}
