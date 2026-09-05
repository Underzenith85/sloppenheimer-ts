import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app.js'
import { makeQueryClient } from './query-client.js'
import './styles/tokens.css'
import './styles/reset.css'

const container = document.getElementById('root')

if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App queryClient={makeQueryClient()} />
    </StrictMode>,
  )
}
