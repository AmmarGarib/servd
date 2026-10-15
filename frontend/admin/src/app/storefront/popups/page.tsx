// /storefront/popups has no list of its own: the Pop-ups tab of the Storefront hub is it.
import { redirect } from 'next/navigation'

export default function StorefrontPopupsIndex(): never {
  redirect('/storefront?tab=popups')
}
