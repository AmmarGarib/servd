import { redirect } from 'next/navigation'

// Placeholder retired (D14): the language switch is Settings → Preferences.
export default function LanguageConfigRedirect() {
  redirect('/settings')
}
