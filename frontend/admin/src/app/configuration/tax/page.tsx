'use client'
import { ConfigStubPage } from '../_StubPage'

export default function TaxConfigPage() {
  return (
    <ConfigStubPage
      icon="🧾"
      title="Tax & FBR Compliance"
      description="GST rates, FBR e-invoice integration, and per-item tax classification."
      whyItMatters="In Pakistan, restaurants must register POS sales with FBR within 24 hours. Misclassified items invite penalties and trigger audits. Your tax setup is what makes the difference between clean compliance and quarterly headaches."
      defaults={[
        { label: 'Default GST rate (standard items)', value: '17%', hint: 'Applied to all menu items unless overridden' },
        { label: 'Reduced rate (basic food)', value: '5%',  hint: 'Tagged as taxClassification = "reduced"' },
        { label: 'Zero-rated (exports / specific exemptions)', value: '0%' },
        { label: 'Exempt items (outside GST regime)', value: 'No tax', hint: 'taxClassification = "exempt"' },
        { label: 'FBR submission cadence', value: '5 min',  hint: 'Worker batches and posts every 5 minutes' },
        { label: 'FBR retry policy', value: '3× back-off', hint: 'Failed submissions retry with exponential delay' },
      ]}
      primaryAction={{ label: 'Set per-item tax in Menu Editor', href: '/menu' }}
    />
  )
}
