/**
 * Persistent edits to the read-only collections the state records are built from.
 *
 * Every one of these answers with a new collection and leaves its argument untouched, so a record
 * holding one can be updated by spreading rather than by mutating something a previous snapshot is
 * still holding. A removal that has nothing to remove answers with the *original* collection, which
 * is what lets a no-op transition preserve reference equality and a caller compare by identity.
 */

export const withEntry = <Key, Value>(
  map: ReadonlyMap<Key, Value>,
  key: Key,
  value: Value,
): ReadonlyMap<Key, Value> => new Map(map).set(key, value)

export const withoutEntry = <Key, Value>(
  map: ReadonlyMap<Key, Value>,
  key: Key,
): ReadonlyMap<Key, Value> => {
  if (!map.has(key)) {
    return map
  }
  const next = new Map(map)
  next.delete(key)
  return next
}

export const withMember = <Value>(set: ReadonlySet<Value>, value: Value): ReadonlySet<Value> =>
  set.has(value) ? set : new Set(set).add(value)

export const withoutMember = <Value>(set: ReadonlySet<Value>, value: Value): ReadonlySet<Value> => {
  if (!set.has(value)) {
    return set
  }
  const next = new Set(set)
  next.delete(value)
  return next
}

/** Drops oldest-first until the collection is within its cap. Insertion order is the age order. */
export const capped = <Value>(set: ReadonlySet<Value>, limit: number): ReadonlySet<Value> => {
  if (set.size <= limit) {
    return set
  }
  const next = new Set(set)
  for (const value of set) {
    if (next.size <= limit) {
      break
    }
    next.delete(value)
  }
  return next
}
