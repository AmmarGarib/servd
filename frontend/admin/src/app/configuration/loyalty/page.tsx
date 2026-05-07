'use client'
import { ConfigStubPage } from '../_StubPage'

export default function LoyaltyConfigPage() {
  return (
    <ConfigStubPage
      icon="⭐"
      title="Loyalty Program"
      description="Earn rate, redemption rate, expiry, and tier thresholds."
      whyItMatters="Repeat customers spend 67% more than first-timers. A well-tuned loyalty program turns one-time orders into a habit — but only if the math is honest. These defaults match what high-margin Pakistani concepts use; tweak them once you have 30 days of data."
      defaults={[
        { label: 'Earn rate', value: '1 point / PKR 100', hint: 'Customer earns 1 point per 100 rupees spent (post-tax)' },
        { label: 'Redemption rate', value: '1 point = PKR 1', hint: 'Direct cash discount at checkout' },
        { label: 'Minimum redeem', value: '50 points', hint: 'Stops dust-redemption clutter' },
        { label: 'Earn lock-in', value: '24 hours', hint: 'Points credit only after order is finalised + non-cancellable' },
        { label: 'Expiry', value: '12 months', hint: 'Unused points expire 1 year from earning date' },
        { label: 'Birthday bonus', value: '500 points',  hint: 'Auto-credited on birthday if customer profile has DOB' },
        { label: 'Tier: Silver',  value: '5,000 lifetime spent (PKR)', hint: '5% extra earn, free delivery 1×/month' },
        { label: 'Tier: Gold',    value: '25,000 lifetime spent (PKR)', hint: '10% extra earn, priority queue, surprise gift' },
        { label: 'Tier: Platinum', value: '100,000 lifetime spent (PKR)', hint: '15% extra earn, dedicated WhatsApp support' },
      ]}
      primaryAction={{ label: 'View loyalty members in CRM', href: '/crm' }}
    />
  )
}
