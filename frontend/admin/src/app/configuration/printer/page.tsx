import { redirect } from 'next/navigation'

// Placeholder retired (D14): printer IP, paper width and drawer kick are set
// on Configuration → Receipts (/setup/receipt-config).
export default function PrinterConfigRedirect() {
  redirect('/configuration/receipts')
}
