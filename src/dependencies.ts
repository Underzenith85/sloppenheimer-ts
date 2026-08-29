import { normalizeState, type Issue } from './domain.js'

export type DependencyCycle = Readonly<{
  members: readonly string[]
  message: string
}>

export const unresolvedBlockers = (
  issue: Issue,
  terminalStates: readonly string[],
): Issue['blockedBy'] => {
  const terminal = new Set(terminalStates.map(normalizeState))
  return issue.blockedBy.filter((blocker) => !terminal.has(normalizeState(blocker.state)))
}

export const findDependencyCycles = (issues: readonly Issue[]): readonly DependencyCycle[] => {
  const identifiers = new Set(issues.map((issue) => String(issue.identifier)))
  const adjacency = new Map<string, readonly string[]>(
    issues.map((issue) => [
      String(issue.identifier),
      issue.blockedBy
        .map((blocker) => String(blocker.identifier))
        .filter((identifier) => identifiers.has(identifier))
        .sort(),
    ]),
  )
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const groups: string[][] = []
  let nextIndex = 0

  const visit = (identifier: string): void => {
    const index = nextIndex
    nextIndex += 1
    indices.set(identifier, index)
    lowLinks.set(identifier, index)
    stack.push(identifier)
    onStack.add(identifier)

    for (const blocker of adjacency.get(identifier) ?? []) {
      if (!indices.has(blocker)) {
        visit(blocker)
        lowLinks.set(
          identifier,
          Math.min(lowLinks.get(identifier) ?? index, lowLinks.get(blocker) ?? index),
        )
      } else if (onStack.has(blocker)) {
        lowLinks.set(
          identifier,
          Math.min(lowLinks.get(identifier) ?? index, indices.get(blocker) ?? index),
        )
      }
    }

    if (lowLinks.get(identifier) !== indices.get(identifier)) {
      return
    }
    const group: string[] = []
    for (;;) {
      const member = stack.pop()
      if (member === undefined) {
        break
      }
      onStack.delete(member)
      group.push(member)
      if (member === identifier) {
        break
      }
    }
    const onlyMember = group[0] ?? ''
    const selfCycle = group.length === 1 && (adjacency.get(onlyMember) ?? []).includes(onlyMember)
    if (group.length > 1 || selfCycle) {
      groups.push(group.sort())
    }
  }

  for (const identifier of [...identifiers].sort()) {
    if (!indices.has(identifier)) {
      visit(identifier)
    }
  }
  return groups
    .sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''))
    .map((members) => ({
      members,
      message: `Dependency cycle members: ${members.join(', ')}`,
    }))
}

export const cyclicIssueIdentifiers = (issues: readonly Issue[]): ReadonlySet<string> =>
  new Set(findDependencyCycles(issues).flatMap((cycle) => cycle.members))
