'use client'
import Link from 'next/link'
import { ApAging } from '../../../components/finance/ApAging'

export default function ApAgingPage() {
  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
        <h1 className="text-xl font-bold text-s-text">Accounts Payable Aging</h1>
      </header>
      <div className="p-6 max-w-6xl mx-auto">
        <ApAging />
      </div>
    </div>
  )
}
