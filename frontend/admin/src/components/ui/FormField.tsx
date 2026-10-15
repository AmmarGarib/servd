'use client'
// FormField — label + control + hint + error, wired for accessibility
// (UX audit ERP-FIN-3): the label is clickable (htmlFor), the hint and the
// error are announced with the control (aria-describedby), and the control
// carries aria-invalid / aria-required. The error is a role=alert line.
//
//   <FormField label="Amount" required error={err} hint="In rupees">
//     <MoneyInput value={v} onChange={setV} />
//   </FormField>
//
// The child must be one element that accepts id / aria-* props (input, Select,
// NumberField, MoneyInput, PasswordInput, textarea).

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'

export function FormField({ label, hint, error, required, className, children }: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  className?: string
  children: ReactElement
}) {
  const uid = useId()
  const child = isValidElement<Record<string, unknown>>(children) ? children : null
  const id = (child?.props['id'] as string | undefined) ?? `${uid}-f`
  const hintId = `${uid}-hint`
  const errId = `${uid}-err`
  const describedBy = [child?.props['aria-describedby'] as string | undefined, hint ? hintId : '', error ? errId : '']
    .filter(Boolean).join(' ') || undefined

  return (
    <div className={className}>
      <label htmlFor={id} className="text-xs text-white/55">
        {label}
        {required && <span aria-hidden className="ml-0.5" style={{ color: 'var(--erp-danger)' }}>*</span>}
      </label>
      <div className="mt-1">
        {child
          ? cloneElement(child, {
              id,
              'aria-describedby': describedBy,
              'aria-invalid': error ? true : child.props['aria-invalid'],
              'aria-required': required ? true : child.props['aria-required'],
            })
          : children}
      </div>
      {hint && !error && <p id={hintId} className="text-[11px] text-white/40 mt-1">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-[11px] mt-1" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
    </div>
  )
}

export default FormField
