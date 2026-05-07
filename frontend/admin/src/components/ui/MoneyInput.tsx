'use client'
// MoneyInput — comma-formatted PKR input that stores cents (paisa) externally.
//
// Why this exists: <input type="number"> doesn't allow commas, and operators
// in Pakistan write large numbers like 1,00,000 (Indian-style grouping) or
// 100,000 (Western-style). Forcing them to type plain digits is friction.
//
// Behaviour:
//   • Display value is rupees, comma-formatted (en-PK locale grouping).
//   • Internal value is cents (integer paisa) so backend math stays correct.
//   • Typing strips non-digits/dots, parses to rupees, multiplies by 100.
//   • On blur, re-formats to canonical comma-separated form.

import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number                       // cents/paisa (integer)
  onChange: (cents: number) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  disabled?: boolean
  ariaLabel?: string
}

export function MoneyInput({ value, onChange, placeholder, className, autoFocus, disabled, ariaLabel }: Props) {
  const [text, setText] = useState(formatRupees(value))
  const lastValueRef = useRef(value)

  // Sync text from external value when it changes from outside (form reset,
  // hydrate from existing record). Skip resyncs caused by our own onChange.
  useEffect(() => {
    if (value === lastValueRef.current) return
    lastValueRef.current = value
    setText(formatRupees(value))
  }, [value])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    // Allow digits, commas, single dot. Strip everything else.
    const cleaned = raw.replace(/[^\d,.]/g, '')
    setText(cleaned)
    const cents = parseToCents(cleaned)
    lastValueRef.current = cents
    onChange(cents)
  }

  function handleBlur() {
    setText(formatRupees(value))
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      placeholder={placeholder ?? '0'}
      className={className}
      autoFocus={autoFocus}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  )
}

// Helpers exported so other inputs (e.g. variance previews) can reuse them.
export function parseToCents(text: string): number {
  if (!text) return 0
  const cleaned = text.replace(/,/g, '').trim()
  const rupees = parseFloat(cleaned)
  if (!Number.isFinite(rupees)) return 0
  return Math.round(rupees * 100)
}

export function formatRupees(cents: number): string {
  if (!cents || !Number.isFinite(cents)) return ''
  // en-PK uses Indian-style grouping (1,00,000) — matches how operators write
  // large numbers in PK. Drop trailing .00 for whole rupees.
  const rupees = cents / 100
  if (Math.round(rupees) === rupees) {
    return rupees.toLocaleString('en-PK')
  }
  return rupees.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
