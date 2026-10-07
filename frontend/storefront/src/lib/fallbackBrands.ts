import type { Concept } from './concept'

// The one copy of the brand records the storefront shows when
// /storefront/concepts can't be reached (api warmup, network blip), so the
// microsites and the home grid keep working instead of 404ing. The live
// values come from the DB (admin → Marketing → Brands); keep these in step
// with them. Only the brands that are live in production belong here.
export const FALLBACK_CONCEPTS: Record<string, Concept> = {
  simmer: {
    id: 'fallback-simmer', name: 'Simmer', slug: 'simmer', type: 'restaurant',
    description: 'Small plates and mocktails. A dark room on Ittehad, served softly.',
    email: 'simmer@gsfoods.pk',
    logoUrl: null, primaryColor: null, reservationsEnabled: true,
  },
  stackd: {
    id: 'fallback-stackd', name: 'Stackd', slug: 'stackd', type: 'restaurant',
    description: 'Scratch-cooking café and small market — sandwiches, pastries, light bites and craft mocktails.',
    email: 'stackd@gsfoods.pk',
    logoUrl: null, primaryColor: null, reservationsEnabled: false,
  },
  flipd: {
    id: 'fallback-flipd', name: 'Flipd', slug: 'flipd', type: 'restaurant',
    description: 'Gourmet smash and grilled burgers, built to a fixed spec. Same burger, every time.',
    email: 'flipd@gsfoods.pk',
    logoUrl: null, primaryColor: null, reservationsEnabled: false,
  },
}
