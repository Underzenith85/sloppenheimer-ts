import { QueryClientProvider } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactElement } from 'react'

import styles from './app.module.css'

type AppProps = Readonly<{ queryClient: QueryClient }>

// The bootstrap surface reports no fleet state until the coordinator API exists.
export const App = ({ queryClient }: AppProps): ReactElement => (
  <QueryClientProvider client={queryClient}>
    <main className={styles['shell']}>
      <h1>Sloppenheimer coordinator</h1>
      <p>The coordinator console is being built. Instance data is not connected yet.</p>
    </main>
  </QueryClientProvider>
)
