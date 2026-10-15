import type { SectionComponent } from '../types'
import { LegalDocument } from './LegalDocument'
import { ContactDetails } from './ContactDetails'
import { ContactForm } from './lazy'

export const renderers: Record<string, SectionComponent> = {
  'legal.document': LegalDocument,
  'legal.contactDetails': ContactDetails,
  'legal.contactForm': ContactForm,
}
