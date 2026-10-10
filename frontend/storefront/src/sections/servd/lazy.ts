'use client'
// servd's CLIENT sections, each split into its own chunk (next/dynamic, SSR
// kept) so a page ships only the sections it renders. Why this is a separate
// 'use client' module and not dynamic() in renderers.tsx: ../renderers.ts.
// Server sections stay static imports in ./renderers.tsx.
import dynamic from 'next/dynamic'
import type { SectionComponent } from '../types'

// `as SectionComponent`: next/dynamic types its result as ComponentType (class
// or function); these are function components, which is what the maps hold.
export const ScrollHero = dynamic(() => import('./ScrollHero').then((m) => m.ScrollHero)) as SectionComponent
export const Kitchens = dynamic(() => import('./Kitchens').then((m) => m.Kitchens)) as SectionComponent
export const HowItWorks = dynamic(() => import('./HowItWorks').then((m) => m.HowItWorks)) as SectionComponent
export const Insiders = dynamic(() => import('./Insiders').then((m) => m.Insiders)) as SectionComponent
export const Visit = dynamic(() => import('./Visit').then((m) => m.Visit)) as SectionComponent
export const WaitlistStrip = dynamic(() => import('./WaitlistStrip').then((m) => m.WaitlistStrip)) as SectionComponent
export const Nav = dynamic(() => import('./Nav').then((m) => m.Nav)) as SectionComponent
export const Feedback = dynamic(() => import('./Feedback').then((m) => m.Feedback)) as SectionComponent
