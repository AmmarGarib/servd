'use client'
// brand's CLIENT sections, each split into its own chunk (next/dynamic, SSR
// kept) so a page ships only the sections it renders. Why this is a separate
// 'use client' module and not dynamic() in renderers.tsx: ../renderers.ts.
// Server sections stay static imports in ./renderers.tsx.
import dynamic from 'next/dynamic'
import type { SectionComponent } from '../types'

// `as SectionComponent`: next/dynamic types its result as ComponentType (class
// or function); these are function components, which is what the maps hold.
export const BrandHeader = dynamic(() => import('./BrandHeader').then((m) => m.BrandHeader)) as SectionComponent
export const BrandFooter = dynamic(() => import('./BrandFooter').then((m) => m.BrandFooter)) as SectionComponent
export const GenericHero = dynamic(() => import('./GenericHero').then((m) => m.GenericHero)) as SectionComponent
