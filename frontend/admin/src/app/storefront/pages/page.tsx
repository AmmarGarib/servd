// /storefront/pages has no list of its own: the Pages tab of the Storefront hub is it.
import { redirect } from 'next/navigation'

export default function StorefrontPagesIndex(): never {
  redirect('/storefront?tab=pages')
}
