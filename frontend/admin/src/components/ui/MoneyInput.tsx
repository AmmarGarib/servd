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
//   • Typing keeps digits and ONE dot with at most 2 decimals (commas are
//     dropped while typing), parses to rupees, multiplies by 100.
//   • Text is selected on focus; `allowNegative` permits a leading minus.
//   • On blur, re-formats to canonical comma-separated form.

import { useEffect, useRef, useState } from 'react'
import { useSelectOnFocus } from './NumberField'

interface Props {
  value: number                       // cents/paisa (integer)
  onChange: (cents: number) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  disabled?: boolean
  ariaLabel?: string
  id?: string
  name?: string
  required?: boolean
  allowNegative?: boolean             // credits, balances, adjustments
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  'aria-invalid'?: boolean | 'true' | 'false'
  'aria-describedby'?: string
}

/** One dot, at most 2 decimals, no commas (they are regrouped on blur). */
function sanitiseMoney(raw: string, allowNegative: boolean): string {
  let out = ''
  let dot = false
  let decs = 0
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') {
      if (dot) { if (decs >= 2) continue; decs++ }
      out += ch
    } else if (ch === '.' && !dot) { dot = true; out += ch }
    else if (ch === '-' && allowNegative && out === '') out += ch
  }
  return out
}

export function MoneyInput({
  value, onChange, placeholder, className, autoFocus, disabled, ariaLabel, id, name, required, allowNegative = false,
  onBlur, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedBy,
}: Props) {
  const [text, setText] = useState(formatRupees(value))
  const lastValueRef = useRef(value)
  const sel = useSelectOnFocus()

  // Sync text from external value when it changes from outside (form reset,
  // hydrate from existing record). Skip resyncs caused by our own onChange.
  useEffect(() => {
    if (value === lastValueRef.current) return
    lastValueRef.current = value
    setText(formatRupees(value))
  }, [value])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const cleaned = sanitiseMoney(e.target.value, allowNegative)
    setText(cleaned)
    const cents = parseToCents(cleaned)
    lastValueRef.current = cents
    onChange(cents)
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    setText(formatRupees(value))
    onBlur?.(e)
  }

  return (
    <input
      type="text"
      inputMode={allowNegative ? 'text' : 'decimal'}
      autoComplete="off"
      id={id}
      name={name}
      required={required}
      value={text}
      onChange={handleChange}
      onFocus={sel.onFocus}
      onMouseUp={sel.onMouseUp}
      onBlur={handleBlur}
      placeholder={placeholder ?? '0'}
      className={className}
      autoFocus={autoFocus}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
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
