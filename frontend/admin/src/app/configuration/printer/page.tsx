'use client'
import { ConfigStubPage } from '../_StubPage'

export default function PrinterConfigPage() {
  return (
    <ConfigStubPage
      icon="🖨"
      title="Receipt Printer"
      description="Network printer IP, ESC/POS settings, paper width."
      whyItMatters="Most kitchens still rely on thermal receipt printers for hand-off tickets and customer receipts. servd works without any hardware (browser print is fine), but configuring a network printer makes the receipt fly out automatically the moment an order lands."
      defaults={[
        { label: 'Mode',  value: 'Browser print', hint: 'Falls back to window.print() — works on any printer' },
        { label: 'Paper width',  value: '80 mm', hint: 'Standard thermal receipt size; 58 mm also supported' },
        { label: 'Logo',  value: 'Concept logo (if uploaded)', hint: 'Falls back to "servd" wordmark' },
        { label: 'Footer line',  value: '"Thank you, see you again!"', hint: 'Configurable per concept once editor is live' },
        { label: 'Auto-print on order placed', value: 'Off', hint: 'Toggle on once printer IP is set' },
        { label: 'Open cash drawer pulse', value: 'On cash payment', hint: 'ESC/POS "open drawer" command sent after cash sale' },
      ]}
      primaryAction={{ label: 'Print a test receipt from POS', href: '/pos' }}
    />
  )
}
