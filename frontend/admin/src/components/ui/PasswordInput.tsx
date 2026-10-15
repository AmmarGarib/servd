'use client'
// PasswordInput — an <input> with a Show / Hide eye (UX audit CODE-FIELDS-1).
// Same toggle as the storefront's LoginForm: type flip, 44px button,
// aria-label "Show password" / "Hide password", aria-pressed. Every normal
// input prop passes through (autoComplete="current-password" / "new-password",
// name, required, value, onChange, className …).
//
// `numeric` is for PINs: inputMode numeric and masked by default; the eye
// still reveals it.

import { forwardRef, useState, type InputHTMLAttributes } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  numeric?: boolean
  /** Classes for the relative wrapper (width, margin). */
  wrapperClassName?: string
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { numeric, wrapperClassName, className, inputMode, ...rest }, ref,
) {
  const [shown, setShown] = useState(false)
  return (
    <div className={`relative ${wrapperClassName ?? ''}`}>
      <input
        {...rest}
        ref={ref}
        type={shown ? 'text' : 'password'}
        inputMode={inputMode ?? (numeric ? 'numeric' : undefined)}
        className={`${className ?? 's-input'} pr-12`}
      />
      <button type="button" onClick={() => setShown((v) => !v)} disabled={rest.disabled}
        aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}
        className="absolute right-0 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-lg text-white/50 hover:text-white/80 transition-colors">
        {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </button>
    </div>
  )
})

export default PasswordInput
