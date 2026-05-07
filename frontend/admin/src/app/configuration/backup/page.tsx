'use client'
import { ConfigStubPage } from '../_StubPage'

export default function BackupConfigPage() {
  return (
    <ConfigStubPage
      icon="💾"
      title="Backup & Data Export"
      description="Periodic database snapshots, CSV exports, data residency."
      whyItMatters="Restaurants are noisy environments — power cuts, dropped tablets, accidental deletions. Backups are cheap insurance. CSV export also unblocks accountants who insist on Excel for monthly closes."
      defaults={[
        { label: 'Database backup',  value: 'Neon point-in-time recovery', hint: '7-day rolling PITR via Neon (managed automatically)' },
        { label: 'Daily snapshot', value: '03:00 AM', hint: 'Read-only snapshot taken at low-traffic hour' },
        { label: 'Retention',  value: '30 days', hint: 'Full backups kept 30 days, then aged out' },
        { label: 'CSV: Sales export', value: 'On-demand', hint: 'Reports → Sales → "Export CSV"' },
        { label: 'CSV: Inventory snapshot', value: 'On-demand', hint: 'Inventory → "Export current stock"' },
        { label: 'CSV: Customer list',  value: 'Managers only', hint: 'CRM → bulk export with PII consent flag' },
        { label: 'Data residency', value: 'AP-Southeast-1 (Singapore)', hint: 'Neon region; closest low-latency option to PK' },
        { label: 'Right-to-be-forgotten', value: 'Manual via support', hint: 'GDPR-style deletion request flow on roadmap' },
      ]}
    />
  )
}
