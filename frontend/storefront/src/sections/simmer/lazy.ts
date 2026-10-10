'use client'
// simmer's CLIENT sections, each split into its own chunk (next/dynamic, SSR
// kept) so a page ships only the sections it renders. Why this is a separate
// 'use client' module and not dynamic() in renderers.tsx: ../renderers.ts.
// Server sections stay static imports in ./renderers.tsx.
import dynamic from 'next/dynamic'
import type { SectionComponent } from '../types'

// `as SectionComponent`: next/dynamic types its result as ComponentType (class
// or function); these are function components, which is what the maps hold.
// FridgeHero imports ./simmer.css; next/dynamic links it from the server
// render (<link rel="stylesheet">) on the pages that show the hero.
export const FridgeHero = dynamic(() => import('./FridgeHero').then((m) => m.FridgeHero)) as SectionComponent
export const Elsewhere = dynamic(() => import('./Elsewhere').then((m) => m.Elsewhere)) as SectionComponent
