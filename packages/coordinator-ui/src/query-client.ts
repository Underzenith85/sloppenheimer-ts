import { QueryClient } from '@tanstack/react-query'

// One cache per mounted application. A lost mutation response cannot establish whether the
// instance performed the action, so control requests must never retry automatically.
export const makeQueryClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { mutations: { retry: false } } })
