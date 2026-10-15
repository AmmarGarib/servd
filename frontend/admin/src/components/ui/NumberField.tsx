'use client'
// NumberField — a number input that behaves (UX audit CODE-FIELDS-2).
//
// Why not <input type=number>: the wheel changes it, spinners overlap narrow
// cells, phones show the wrong keyboard, "e" and "+" are accepted, and a React
// number state eats half-typed text ("1." → 1). This keeps what the person
// typed as a string, accepts only digits (+ one dot, + a leading minus when
// allowNegative), and reports a number (or null when empty) on every valid
// change. Min / max clamp on blur only, so typing "5" on the way to "50" is
// never fought. The text is selected on focus; the wheel never changes it.

import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type FocusEvent, type MouseEvent } from 'react'

/** Select-all on focus that survives the mouse-up which would clear it. */
export function useSelectOnFocus() {
  const justFocused = useRef(false)
  return {
    onFocus: (e: FocusEvent<HTMLInputElement>) => {
      justFocused.current = true
      e.currentTarget.select()
    },
    onMouseUp: (e: MouseEvent<HTMLInputElement>) => {
      if (justFocused.current) e.preventDefault()
      justFocused.current = false
    },
  }
}

export type NumberFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step'> & {
  value: number | null | undefined
  onValueChange: (value: number | null) => void
  /** Digits allowed after the dot. 0 (default) = whole numbers. */
  decimals?: number
  min?: number
  max?: number
  allowNegative?: boolean
}

function sanitise(raw: string, decimals: number, allowNegative: boolean): string {
  let out = ''
  let dot = false
  let decs = 0
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') {
      if (dot) { if (decs >= decimals) continue; decs++ }
      out += ch
    } else if (ch === '.' && decimals > 0 && !dot) { dot = true; out += ch }
    else if (ch === '-' && allowNegative && out === '') out += ch
  }
  return out
}

const show = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '' : String(v))

export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  { value, onValueChange, decimals = 0, min, max, allowNegative = false, onFocus, onBlur, onMouseUp, onWheel, className, ...rest }, ref,
) {
  const [text, setText] = useState(show(value))
  const focused = useRef(false)
  const sel = useSelectOnFocus()

  // Outside changes (form reset, loaded record) — but never while typing.
  useEffect(() => {
    if (!focused.current) setText(show(value))
  }, [value])

  function change(raw: string) {
    const next = sanitise(raw, decimals, allowNegative)
    setText(next)
    if (next === '') { onValueChange(null); return }
    if (next === '-' || next === '.' || next === '-.') return // half-typed: wait
    const n = Number(next)
    if (Number.isFinite(n)) onValueChange(n)
  }

  function blur(e: FocusEvent<HTMLInputElement>) {
    focused.current = false
    const n = text === '' || text === '-' || text === '.' || text === '-.' ? null : Number(text)
    if (n == null) { setText(''); if (text !== '') onValueChange(null) }
    else {
      let c = n
      if (min != null && c < min) c = min
      if (max != null && c > max) c = max
      setText(String(c))
      if (c !== n) onValueChange(c)
    }
    onBlur?.(e)
  }

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode={allowNegative ? 'text' : decimals > 0 ? 'decimal' : 'numeric'}
      autoComplete={rest.autoComplete ?? 'off'}
      value={text}
      className={className ?? 's-input'}
      onChange={(e) => change(e.target.value)}
      onFocus={(e) => { focused.current = true; sel.onFocus(e); onFocus?.(e) }}
      onMouseUp={(e) => { sel.onMouseUp(e); onMouseUp?.(e) }}
      onBlur={blur}
      onWheel={(e) => { e.currentTarget.blur(); onWheel?.(e) }}
    />
  )
})

export default NumberField
