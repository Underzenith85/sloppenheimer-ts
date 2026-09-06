// @vitest-environment happy-dom
import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { describe, expect, it, vi } from 'vitest'

import { Button } from '../../packages/coordinator-ui/src/components/button.js'
import { Panel } from '../../packages/coordinator-ui/src/components/panel.js'
import { PrimitiveFixtures } from '../../packages/coordinator-ui/src/primitive-fixtures.js'
import { accessibilityFindings } from '../harness/accessibility.js'

const withRendered = async (
  element: ReactElement,
  verify: (container: HTMLDivElement) => Promise<void>,
): Promise<void> => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(element)
    })
    await verify(container)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
  }
}

const buttonNamed = (container: ParentNode, label: string): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  )
  if (button === undefined) {
    throw new Error(`Missing button: ${label}`)
  }
  return button
}

describe('coordinator primitives', () => {
  it('blocks unavailable and busy actions while retaining visible, associated reasons', async () => {
    const onClick = vi.fn()
    await withRendered(
      <>
        <Button label="Available" onClick={onClick} />
        <Button label="Unavailable" onClick={onClick} disabledReason="Connection required." />
        <Button label="Save" busy busyLabel="Saving…" onClick={onClick} />
      </>,
      async (container) => {
        const unavailable = buttonNamed(container, 'Unavailable')
        const busy = buttonNamed(container, 'Saving…')
        expect(unavailable.getAttribute('aria-disabled')).toBe('true')
        expect(unavailable.disabled).toBe(false)
        unavailable.focus()
        expect(document.activeElement).toBe(unavailable)
        const reasonId = unavailable.getAttribute('aria-describedby') ?? ''
        expect(document.getElementById(reasonId)?.textContent).toBe('Connection required.')
        expect(busy.getAttribute('aria-busy')).toBe('true')
        await act(async () => {
          unavailable.click()
          busy.click()
        })
        expect(onClick).not.toHaveBeenCalled()
        await act(async () => {
          buttonNamed(container, 'Available').click()
        })
        expect(onClick).toHaveBeenCalledOnce()
        expect(buttonNamed(container, 'Available').type).toBe('button')
      },
    )
  })

  it('names panels with unique headings and associates optional descriptions', async () => {
    await withRendered(
      <>
        <Panel title="Outer" description="Details">
          <Panel title="Inner" headingLevel={3}>
            Content
          </Panel>
        </Panel>
        <Panel title="Sibling">Other content</Panel>
      </>,
      async (container) => {
        const sections = Array.from(container.querySelectorAll('section'))
        const names = sections.map((section) => section.getAttribute('aria-labelledby'))
        expect(new Set(names).size).toBe(3)
        expect(
          sections.map(
            (section) =>
              document.getElementById(section.getAttribute('aria-labelledby') ?? '')?.textContent,
          ),
        ).toStrictEqual(['Outer', 'Inner', 'Sibling'])
        expect(container.querySelector('h3')?.textContent).toBe('Inner')
        expect(container.querySelector('section')?.getAttribute('aria-describedby')).toBeTruthy()
      },
    )
  })

  it('renders explicit sample status text and passes structural accessibility checks', async () => {
    await withRendered(
      <main>
        <h1>Fixtures</h1>
        <PrimitiveFixtures />
      </main>,
      async (container) => {
        for (const label of ['Ready', 'In progress', 'Success', 'Warning', 'Failure']) {
          expect(container.textContent).toContain(label)
        }
        const auditWindow = new Window()
        try {
          auditWindow.document.body.innerHTML = container.innerHTML
          expect(accessibilityFindings(auditWindow.document)).toStrictEqual([])
        } finally {
          await auditWindow.happyDOM.close()
        }
        await act(async () => {
          buttonNamed(container, 'Try sample action').click()
        })
        expect(container.querySelector('output')?.textContent).toBe('Sample action complete.')
      },
    )
  })
  it('labels the modal, dismisses with Escape and restores its trigger focus', async () => {
    await withRendered(<PrimitiveFixtures />, async (container) => {
      const trigger = buttonNamed(container, 'Review sample')
      trigger.focus()
      await act(async () => {
        trigger.click()
      })
      const dialog = document.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      expect(
        document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent,
      ).toBe('Review sample action')
      expect(
        document.getElementById(dialog?.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toBe('This example changes no instance data.')
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )
      })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(trigger)
      })
    })
  })
})
