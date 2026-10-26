import { redirect } from 'next/navigation'

// Backups live on CEO → Backups (owner S13, 2026-10-26): the weekly encrypted
// database backup file, CEO only.
export default function BackupConfigRedirect() {
  redirect('/ceo/backups')
}
