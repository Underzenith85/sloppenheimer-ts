// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../../packages/coordinator-ui/src/app.js'
import { makeQueryClient } from '../../packages/coordinator-ui/src/query-client.js'
import { accessibilityFindings } from '../harness/accessibility.js'

describe('coordinator UI infrastructure', () => {
  it('mounts the provider and shell without claiming any observed instance state', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const queryClient = makeQueryClient()
    const auditWindow = new Window()
    try {
      await act(async () => {
        root.render(createElement(App, { queryClient }))
      })
      expect(container.querySelector('h1')?.textContent).toBe('Sloppenheimer coordinator')
      expect(container.textContent).toContain('Instance data is not connected yet.')
      auditWindow.document.body.innerHTML = container.innerHTML
      expect(accessibilityFindings(auditWindow.document)).toStrictEqual([])
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      queryClient.clear()
      await auditWindow.happyDOM.close()
      vi.unstubAllGlobals()
    }
  })

  it('isolates query caches between application mounts', () => {
    const first = makeQueryClient()
    const second = makeQueryClient()
    try {
      first.setQueryData(['instances'], ['one'])
      expect(second.getQueryData(['instances'])).toBeUndefined()
    } finally {
      first.clear()
      second.clear()
    }
  })

  it('does not replay a mutation when its response is lost', async () => {
    const queryClient = makeQueryClient()
    const failure = new Error('Response lost')
    const mutationFunction = vi.fn((): Promise<never> => Promise.reject(failure))
    try {
      const mutation = queryClient.getMutationCache().build(queryClient, {
        mutationFn: mutationFunction,
      })
      await expect(mutation.execute(undefined)).rejects.toBe(failure)
      expect(mutationFunction).toHaveBeenCalledTimes(1)
    } finally {
      queryClient.clear()
    }
  })
})
