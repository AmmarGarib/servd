'use client'
// The legal group's CLIENT section (the contact form), split into its own
// chunk so privacy and terms ship none of it. See ../renderers.ts for why this
// is a separate 'use client' module.
import dynamic from 'next/dynamic'
import type { SectionComponent } from '../types'

export const ContactForm = dynamic(() => import('../../components/contact/ContactForm').then((m) => m.ContactForm)) as SectionComponent
