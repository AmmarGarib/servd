'use client'

// The storefront's ONE phone field (owner, 2026-10-26: "Put an international
// number picker as well. And the preset should change accordingly. Make
// pakistan the default option tho"). A native country select (dial code)
// beside the number; the placeholder is that country's example. The parent
// keeps the country + typed text and sends toE164(country, typed) to the API
// (lib/phoneCountries.ts). Native <select>: it opens as the phone's own
// picker, so it never runs off screen.

import type { CSSProperties, FocusEvent } from 'react'
import { PHONE_COUNTRIES, type PhoneCountry } from '../../lib/phoneCountries'

export function PhoneInput({
  id, country, onCountryChange, value, onChange, onBlur, onFocus,
  inputClassName, inputStyle, selectStyle, error, autoFocus, required, name = 'tel',
}: {
  id: string
  country: PhoneCountry
  onCountryChange: (c: PhoneCountry) => void
  value: string
  onChange: (v: string) => void
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  onFocus?: (e: FocusEvent<HTMLInputElement>) => void
  inputClassName?: string
  inputStyle?: CSSProperties
  selectStyle?: CSSProperties
  error?: string
  autoFocus?: boolean
  required?: boolean
  name?: string
}) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch', minWidth: 0 }}>
      <select
        id={`${id}-country`}
        aria-label="Country code"
        value={country.iso}
        onChange={(e) => onCountryChange(PHONE_COUNTRIES.find((c) => c.iso === e.target.value) ?? PHONE_COUNTRIES[0]!)}
        autoComplete="tel-country-code"
        className="servd-field"
        style={{
          flex: '0 0 auto', width: '6.5rem', minHeight: 48, borderRadius: '0.75rem',
          padding: '0 0.5rem', fontWeight: 700, fontSize: '0.95rem',
          background: '#fff', border: '1px solid var(--servd-line)', color: 'var(--servd-ink)',
          ...selectStyle,
        }}
      >
        {PHONE_COUNTRIES.map((c) => (
          <option key={c.iso} value={c.iso}>{`${c.iso} +${c.dial}`}{c.iso === country.iso ? '' : ` · ${c.name}`}</option>
        ))}
      </select>
      <input
        id={id}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onFocus={onFocus}
        placeholder={country.example}
        autoFocus={autoFocus}
        required={required}
        maxLength={24}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
        className={inputClassName}
        style={{ flex: '1 1 auto', minWidth: 0, ...inputStyle }}
      />
    </div>
  )
}
