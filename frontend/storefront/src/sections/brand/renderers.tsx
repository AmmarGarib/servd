// brand sections — renderers, keyed by variant. See ../README.md.
import type { SectionComponent } from '../types'
import { BrandHeader } from './BrandHeader'
import { BrandFooter } from './BrandFooter'
import { AboutHero, Pillars, ImageBreak, CtaBand } from './AboutSections'
import { PageHeader, VisitInfo, Faq } from './VisitSections'
import { BrandMenu } from './BrandMenu'
import { GenericHero } from './GenericHero'
import { Signatures, Story, Reviews, CrossBrand, BottomCta } from './GenericSections'

export const renderers: Record<string, SectionComponent> = {
  'brand.header': BrandHeader,
  'brand.footer': BrandFooter,
  'brand.aboutHero': AboutHero,
  'brand.pillars': Pillars,
  'brand.imageBreak': ImageBreak,
  'brand.ctaBand': CtaBand,
  'brand.pageHeader': PageHeader,
  'brand.visitInfo': VisitInfo,
  'brand.faq': Faq,
  'brand.menu': BrandMenu,
  'brand.genericHero': GenericHero,
  'brand.signatures': Signatures,
  'brand.story': Story,
  'brand.reviews': Reviews,
  'brand.crossBrand': CrossBrand,
  'brand.bottomCta': BottomCta,
}
