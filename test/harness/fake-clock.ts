export type ScheduledTask = Readonly<{
  dueAt: number
  sequence: number
  run: () => void
}>

/** A synchronous monotonic clock for scheduler boundary tests. */
export class FakeClock {
  #now: number
  #sequence = 0
  readonly #tasks: ScheduledTask[] = []

  constructor(now = 0) {
    this.#now = now
  }

  now(): number {
    return this.#now
  }

  schedule(delayMs: number, run: () => void): ScheduledTask {
    const task = { dueAt: this.#now + delayMs, sequence: this.#sequence, run }
    this.#sequence += 1
    this.#tasks.push(task)
    this.#tasks.sort((left, right) => left.dueAt - right.dueAt || left.sequence - right.sequence)
    return task
  }

  advanceBy(durationMs: number): void {
    if (durationMs < 0) {
      throw new RangeError('fake clock cannot move backwards')
    }
    const target = this.#now + durationMs
    for (;;) {
      const next = this.#tasks[0]
      if (next === undefined || next.dueAt > target) {
        break
      }
      this.#tasks.shift()
      this.#now = next.dueAt
      next.run()
    }
    this.#now = target
  }
}
