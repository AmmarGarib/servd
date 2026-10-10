// servd sections — renderers, keyed by variant. See ../README.md.
import type { SectionComponent } from '../types'
import { ScrollHero } from './ScrollHero'
import { Kitchens } from './Kitchens'
import { HowItWorks } from './HowItWorks'
import { Insiders } from './Insiders'
import { Visit } from './Visit'
import { WaitlistStrip } from './WaitlistStrip'
import { Nav } from './Nav'
import { Footer } from './Footer'
import { Feedback } from './Feedback'
import { PageHeader } from './PageHeader'
import { PressCards } from './PressCards'
import { ReservePicker } from './ReservePicker'
import { WaitlistSignup } from './WaitlistSignup'
import { LocationHero } from './LocationHero'
import { LocationDetails } from './LocationDetails'

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
}
