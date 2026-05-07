'use client'
import { ConfigStubPage } from '../_StubPage'

export default function LanguageConfigPage() {
  return (
    <ConfigStubPage
      icon="🌐"
      title="Language & Localisation"
      description="Bilingual KDS, currency display, date format."
      whyItMatters="Most kitchen staff in Pakistan are more comfortable in Urdu than English. Toggling the KDS to Urdu in one tap means fewer mis-fires, faster onboarding for new cooks, and dignity for the people running the line."
      defaults={[
        { label: 'KDS language toggle', value: 'EN / اردو', hint: 'Per-device, persisted in localStorage' },
        { label: 'Item names: Urdu translations', value: 'Optional per item', hint: 'Field: nameUrdu in Menu Editor' },
        { label: 'Cooking instructions: Urdu', value: 'Optional per item', hint: 'Field: instructionsUrdu — shown on tap' },
        { label: 'Recipe steps: Urdu', value: 'Optional per recipe', hint: 'Field: stepsUrdu in Recipe Costing' },
        { label: 'Currency', value: 'PKR', hint: 'All money displayed as PKR; cents stored as integer' },
        { label: 'Date format', value: 'en-PK locale', hint: 'DD-MM-YYYY for display; ISO 8601 in DB' },
        { label: 'Number format',  value: 'Indian numbering (lakhs)',  hint: 'PKR 1,00,000 instead of 100,000 (roadmap)' },
        { label: 'Storefront language', value: 'English (default)',  hint: 'Customer-side bilingual storefront on roadmap' },
      ]}
      primaryAction={{ label: 'Edit Urdu names in Menu Editor', href: '/menu' }}
    />
  )
}
