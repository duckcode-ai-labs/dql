import React from 'react'
import { createRoot } from 'react-dom/client'
import '@duckcodeailabs/dql-ui/styles'
import { resolveAskRunLink } from './components/home/ask-run-link'

// A link to one answer resolves to its conversation before the app reads the URL.
void resolveAskRunLink().finally(async () => {
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(<App />)
})
