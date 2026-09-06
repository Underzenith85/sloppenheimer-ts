import type { ReactElement } from 'react'

import styles from './status-chip.module.css'

export type StatusTone = 'neutral' | 'busy' | 'success' | 'warning' | 'failure'
export type StatusChipProps = Readonly<{ tone: StatusTone; detail?: string }>

const labels: Readonly<Record<StatusTone, string>> = {
  neutral: 'Ready',
  busy: 'In progress',
  success: 'Success',
  warning: 'Warning',
  failure: 'Failure',
}

// Static status text, not a live region: parents own announcements of changing data.
export const StatusChip = ({ tone, detail }: StatusChipProps): ReactElement => (
  <span className={styles['chip']} data-tone={tone}>
    {labels[tone]}
    {detail === undefined ? '' : `: ${detail}`}
  </span>
)
