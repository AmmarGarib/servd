'use client'
// stackd's CLIENT sections, each split into its own chunk (next/dynamic, SSR
// kept) so a page ships only the sections it renders. Why this is a separate
// 'use client' module and not dynamic() in renderers.tsx: ../renderers.ts.
// Server sections stay static imports in ./renderers.tsx.
import dynamic from 'next/dynamic'
import type { SectionComponent } from '../types'

// `as SectionComponent`: next/dynamic types its result as ComponentType (class
// or function); these are function components, which is what the maps hold.
export const StackdSlip = dynamic(() => import('./StackdSlip').then((m) => m.StackdSlip)) as SectionComponent
export const StackdHero = dynamic(() => import('./StackdHero').then((m) => m.StackdHero)) as SectionComponent
export const StackdStickers = dynamic(() => import('./StackdStickers').then((m) => m.StackdStickers)) as SectionComponent
export const StackdRoom = dynamic(() => import('./StackdRoom').then((m) => m.StackdRoom)) as SectionComponent
export const StackdVisit = dynamic(() => import('./StackdVisit').then((m) => m.StackdVisit)) as SectionComponent
export const StackdCrossBrand = dynamic(() => import('./StackdCrossBrand').then((m) => m.StackdCrossBrand)) as SectionComponent
