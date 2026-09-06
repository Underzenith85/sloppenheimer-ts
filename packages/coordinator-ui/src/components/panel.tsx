import { useId } from 'react'
import type { ReactElement, ReactNode } from 'react'

import styles from './panel.module.css'

export type PanelProps = Readonly<{
  title: string
  description?: string
  headingLevel?: 2 | 3
  children: ReactNode
}>

export const Panel = ({
  title,
  description,
  headingLevel = 2,
  children,
}: PanelProps): ReactElement => {
  const titleId = useId()
  const descriptionId = useId()
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <section
      className={styles['panel']}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
    >
      <Heading id={titleId}>{title}</Heading>
      {description !== undefined && <p id={descriptionId}>{description}</p>}
      <div className={styles['content']}>{children}</div>
    </section>
  )
}
