import { useId } from 'react'
import type { ReactElement } from 'react'

import styles from './button.module.css'

export type ButtonProps = Readonly<{
  label: string
  onClick?: () => void
  disabledReason?: string
  busy?: boolean
  busyLabel?: string
  variant?: 'primary' | 'secondary'
}>

// aria-disabled keeps the reason discoverable by keyboard; activation is guarded here.
export const Button = ({
  label,
  onClick,
  disabledReason,
  busy = false,
  busyLabel = 'Working…',
  variant = 'primary',
}: ButtonProps): ReactElement => {
  const reasonId = useId()
  const unavailable = disabledReason !== undefined || busy
  return (
    <div className={styles['field']}>
      <button
        type="button"
        className={styles['button']}
        data-variant={variant}
        aria-disabled={unavailable || undefined}
        aria-busy={busy || undefined}
        aria-describedby={disabledReason === undefined ? undefined : reasonId}
        onClick={unavailable ? undefined : onClick}
      >
        {busy ? busyLabel : label}
      </button>
      {disabledReason !== undefined && (
        <p id={reasonId} className={styles['reason']}>
          {disabledReason}
        </p>
      )}
    </div>
  )
}
