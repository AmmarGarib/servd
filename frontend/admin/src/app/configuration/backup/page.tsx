import { redirect } from 'next/navigation'

// Placeholder retired (D14). It described backups and exports that do not
// exist; there is no backup screen to send anyone to, so this lands on the
// Configuration hub. The gap stays recorded in lib/moduleCatalog.ts
// (Integrations, webhooks & backups).
export default function BackupConfigRedirect() {
  redirect('/configuration')
}
