import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ReactElement, ReactNode } from 'react'

import buttonStyles from './button.module.css'
import styles from './dialog.module.css'

export type DialogProps = Readonly<{
  triggerLabel: string
  title: string
  description: string
  children: ReactNode
}>

export const Dialog = ({
  triggerLabel,
  title,
  description,
  children,
}: DialogProps): ReactElement => (
  <DialogPrimitive.Root>
    <DialogPrimitive.Trigger className={buttonStyles['button']}>
      {triggerLabel}
    </DialogPrimitive.Trigger>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={styles['overlay']} />
      <DialogPrimitive.Content className={styles['dialog']}>
        <DialogPrimitive.Title className={styles['title']}>{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description className={styles['description']}>
          {description}
        </DialogPrimitive.Description>
        {children}
        <DialogPrimitive.Close className={buttonStyles['button']}>Close</DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
)
