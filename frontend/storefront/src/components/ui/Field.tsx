// The one form field on the storefront (SF-7): label above, 16px text.
// Styles live in globals.css (.sv-field, .sv-field-label, .sv-field-input).
import type { ReactNode } from 'react'

export const FIELD_INPUT_CLASS = 'sv-field-input servd-field'

export function Field({ label, error, errorId, children }: {
  label: ReactNode
  error?: string | null
  errorId?: string
  children: ReactNode
}) {
  return (
    <label className="sv-field">
      <span className="sv-field-label">{label}</span>
      {children}
      {error && <span id={errorId} role="alert" className="sv-field-error">{error}</span>}
    </label>
  )
}
