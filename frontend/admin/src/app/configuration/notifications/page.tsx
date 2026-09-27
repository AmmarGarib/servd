import { redirect } from 'next/navigation'

// Placeholder retired (D14): the working editor for what customers receive
// is Configuration → Templates (with the Email and WhatsApp channel pages).
export default function NotificationsConfigRedirect() {
  redirect('/configuration/templates')
}
