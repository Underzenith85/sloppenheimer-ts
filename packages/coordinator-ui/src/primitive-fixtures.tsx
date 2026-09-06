import { useState } from 'react'
import type { ReactElement } from 'react'

import { Button } from './components/button.js'
import { Dialog } from './components/dialog.js'
import { Panel } from './components/panel.js'
import { StatusChip } from './components/status-chip.js'
import styles from './app.module.css'

export const PrimitiveFixtures = (): ReactElement => {
  const [message, setMessage] = useState('No sample action taken.')
  const recordAction = (): void => {
    setMessage('Sample action complete.')
  }
  return (
    <div className={styles['fixtures']}>
      <Panel title="Controls" description="Sample states only. Use Tab to inspect keyboard focus.">
        <Button label="Try sample action" onClick={recordAction} />
        <Button label="Focus example" variant="secondary" />
        <Button
          label="Unavailable action"
          disabledReason="Connect an instance before using this action."
        />
        <Button label="Save sample" busy busyLabel="Saving sample…" />
        <output>{message}</output>
      </Panel>
      <Panel
        title="Status text"
        description="Every state has a text label, including when colors are unavailable."
      >
        <StatusChip tone="neutral" />
        <StatusChip tone="busy" detail="Sample operation" />
        <StatusChip tone="success" detail="Sample completed" />
        <StatusChip tone="warning" detail="Sample needs attention" />
        <StatusChip tone="failure" detail="Sample could not complete" />
      </Panel>
      <Panel
        title="Dialog example"
        description="Open with Enter or Space; close with Escape or the Close button."
      >
        <Dialog
          triggerLabel="Review sample"
          title="Review sample action"
          description="This example changes no instance data."
        >
          <StatusChip tone="warning" detail="Review before continuing" />
          <Button label="Unavailable confirmation" disabledReason="This is a demonstration only." />
        </Dialog>
      </Panel>
    </div>
  )
}
