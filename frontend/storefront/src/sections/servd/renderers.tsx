// servd sections — renderers, keyed by variant. See ../README.md.
// Server sections are static imports (they never ship to the browser); client
// sections come from ./lazy so each page loads only the ones it renders.
import type { SectionComponent } from '../types'
import { Footer } from './Footer'
import { PageHeader } from './PageHeader'
import { PressCards } from './PressCards'
import { ReservePicker } from './ReservePicker'
import { WaitlistSignup } from './WaitlistSignup'
import { LocationHero } from './LocationHero'
import { LocationDetails } from './LocationDetails'
import { AboutIntro } from './About'
import { Faq } from './Faq'
import {
  ScrollHero, Kitchens, HowItWorks, Insiders, Visit, WaitlistStrip, Nav, Feedback,
} from './lazy'

export const renderers: Record<string, SectionComponent> = {
  'servd.scrollHero': ScrollHero,
  'servd.kitchens': Kitchens,
  'servd.howItWorks': HowItWorks,
  'servd.insiders': Insiders,
  'servd.visit': Visit,
  'servd.waitlistStrip': WaitlistStrip,
  'servd.nav': Nav,
  'servd.footer': Footer,
  'servd.feedback': Feedback,
  'servd.pageHeader': PageHeader,
  'servd.pressCards': PressCards,
  'servd.reservePicker': ReservePicker,
  'servd.waitlistSignup': WaitlistSignup,
  'servd.locationHero': LocationHero,
  'servd.locationDetails': LocationDetails,
  'servd.aboutIntro': AboutIntro,
  'servd.faq': Faq,
}
