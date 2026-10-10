'use client'
// flipd's CLIENT sections, each split into its own chunk (next/dynamic, SSR
// kept) so a page ships only the sections it renders. Why this is a separate
// 'use client' module and not dynamic() in renderers.tsx: ../renderers.ts.
// Server sections stay static imports in ./renderers.tsx.
import dynamic from 'next/dynamic'
import type { SectionComponent } from '../types'

// `as SectionComponent`: next/dynamic types its result as ComponentType (class
// or function); these are function components, which is what the maps hold.
export const FlipdSpecHeroSection = dynamic(() => import('./SpecHero').then((m) => m.FlipdSpecHeroSection)) as SectionComponent
// ./HomeSections exports six sections: one dynamic() each, one shared chunk.
export const FlipdChecker = dynamic(() => import('./HomeSections').then((m) => m.FlipdChecker)) as SectionComponent
export const FlipdMission = dynamic(() => import('./HomeSections').then((m) => m.FlipdMission)) as SectionComponent
export const FlipdValues = dynamic(() => import('./HomeSections').then((m) => m.FlipdValues)) as SectionComponent
export const FlipdVisit = dynamic(() => import('./HomeSections').then((m) => m.FlipdVisit)) as SectionComponent
export const FlipdCrossBrand = dynamic(() => import('./HomeSections').then((m) => m.FlipdCrossBrand)) as SectionComponent
export const FlipdSignOff = dynamic(() => import('./HomeSections').then((m) => m.FlipdSignOff)) as SectionComponent
