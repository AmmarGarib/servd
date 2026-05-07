'use client'
import { ConfigStubPage } from '../_StubPage'

export default function NotificationsConfigPage() {
  return (
    <ConfigStubPage
      icon="🔔"
      title="Notifications"
      description="Customer receipts, order updates, rider alerts, daily digests."
      whyItMatters="Every notification you skip is a customer who calls instead. Every notification you spam is one who unsubscribes. The defaults below are the proven minimum — turn on more later as you see where customers drop off."
      defaults={[
        { label: 'Order receipt (customer)', value: 'SMS + email if available', hint: 'Sent immediately after order placement' },
        { label: 'Order accepted',  value: 'SMS', hint: 'When kitchen confirms (status: confirmed)' },
        { label: 'Order ready / out for delivery',  value: 'SMS + push', hint: 'Critical update — customer needs to act' },
        { label: 'Rider assigned (customer)', value: 'SMS with rider name + phone', hint: 'Lets customer call rider directly' },
        { label: 'Manager: low stock', value: 'Email + dashboard banner', hint: 'When inventory drops below par level' },
        { label: 'Manager: shift drift',  value: 'Push', hint: 'When ticket time exceeds 25 min' },
        { label: 'Daily digest', value: '08:00 AM', hint: 'Yesterday\'s sales, top items, complaints — 1 email' },
        { label: 'Weekly digest', value: 'Mondays', hint: 'Week-over-week trends, best/worst days' },
        { label: 'Customer marketing opt-in', value: 'Required', hint: 'Promo blasts only sent to opted-in customers' },
      ]}
      primaryAction={{ label: 'Set up SMTP / Twilio in Integrations', href: '/settings/integrations' }}
    />
  )
}
