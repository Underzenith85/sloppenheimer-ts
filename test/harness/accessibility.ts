import type { Document, Element } from 'happy-dom'

/**
 * A deterministic structural accessibility audit.
 *
 * It is not a substitute for a manual review, and it is deliberately not a browser-engine scan:
 * the console's test environment is happy-dom, which has no layout or computed styles, so a
 * scanner that depends on either would report on a page nobody sees. What it does check is the
 * class of defect that a redesign actually regresses — a control that lost its name, a panel that
 * lost its label, a duplicated id, an input with no label, a tab order forced out of document
 * order, a heading level skipped — over whatever states the caller renders.
 */
export type AccessibilityFinding = Readonly<{
  rule: string
  detail: string
}>

const describe = (node: Element): string => {
  const id = node.getAttribute('id')
  const className = node.getAttribute('class')
  return (
    node.tagName.toLowerCase() +
    (id === null ? '' : `#${id}`) +
    (className === null ? '' : `.${className.split(' ').join('.')}`)
  )
}

const isHidden = (node: Element): boolean => {
  let current: Element | null = node
  while (current !== null) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
      return true
    }
    current = current.parentElement
  }
  return false
}

const accessibleName = (document: Document, node: Element): string => {
  const label = node.getAttribute('aria-label')
  if (label !== null && label.trim().length > 0) {
    return label.trim()
  }
  const labelledBy = node.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const referenced = labelledBy
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
    if (referenced.length > 0) {
      return referenced
    }
  }
  const title = node.getAttribute('title')
  if (title !== null && title.trim().length > 0) {
    return title.trim()
  }
  return (node.textContent ?? '').trim()
}

export const accessibilityFindings = (document: Document): readonly AccessibilityFinding[] => {
  const findings: AccessibilityFinding[] = []
  const add = (rule: string, detail: string): void => {
    findings.push({ rule, detail })
  }

  const seen = new Set<string>()
  for (const node of document.querySelectorAll('[id]')) {
    const id = node.getAttribute('id') ?? ''
    if (seen.has(id)) {
      add('duplicate-id', `more than one element has id "${id}"`)
    }
    seen.add(id)
  }

  for (const node of document.querySelectorAll('button, a[href], select, input, [role="tab"]')) {
    if (isHidden(node)) {
      continue
    }
    if (node.tagName.toLowerCase() === 'input' || node.tagName.toLowerCase() === 'select') {
      const id = node.getAttribute('id')
      const labelled =
        (id !== null && document.querySelector(`label[for="${id}"]`) !== null) ||
        node.closest('label') !== null ||
        node.getAttribute('aria-label') !== null ||
        node.getAttribute('aria-labelledby') !== null
      if (!labelled) {
        add('control-without-label', `${describe(node)} has no associated label`)
      }
      continue
    }
    if (accessibleName(document, node).length === 0) {
      add('control-without-name', `${describe(node)} has no accessible name`)
    }
  }

  for (const node of document.querySelectorAll('[tabindex]')) {
    const value = Number(node.getAttribute('tabindex'))
    if (Number.isFinite(value) && value > 0) {
      add('positive-tabindex', `${describe(node)} forces tab order with tabindex=${String(value)}`)
    }
  }

  for (const node of document.querySelectorAll('[role="tabpanel"]')) {
    const labelledBy = node.getAttribute('aria-labelledby')
    if (labelledBy === null || document.getElementById(labelledBy) === null) {
      add('tabpanel-without-tab', `${describe(node)} is not labelled by a tab`)
    }
  }

  for (const node of document.querySelectorAll('[role="tab"]')) {
    const controls = node.getAttribute('aria-controls')
    if (controls === null || document.getElementById(controls) === null) {
      add('tab-without-panel', `${describe(node)} controls no panel`)
    }
    if (node.getAttribute('aria-selected') === null) {
      add('tab-without-selection', `${describe(node)} does not report aria-selected`)
    }
  }

  for (const node of document.querySelectorAll('img')) {
    if (node.getAttribute('alt') === null && node.getAttribute('aria-hidden') !== 'true') {
      add('image-without-text', `${describe(node)} has neither alt text nor aria-hidden`)
    }
  }

  const dialogs = document.querySelectorAll('[role="dialog"]')
  for (const dialog of dialogs) {
    if (isHidden(dialog)) {
      continue
    }
    if (accessibleName(document, dialog).length === 0) {
      add('dialog-without-name', `${describe(dialog)} has no accessible name`)
    }
  }

  let previous = 0
  for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (isHidden(heading)) {
      continue
    }
    const level = Number(heading.tagName.slice(1))
    if (previous !== 0 && level > previous + 1) {
      add(
        'heading-level-skipped',
        `${describe(heading)} jumps from h${String(previous)} to h${String(level)}`,
      )
    }
    previous = level
  }

  if (document.querySelectorAll('main').length !== 1) {
    add('landmark-main', 'the page does not have exactly one main landmark')
  }

  return findings
}
