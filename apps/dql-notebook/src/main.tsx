import React from 'react'
import { createRoot } from 'react-dom/client'
import '@duckcodeailabs/dql-ui/styles'
import { resolveAskRunLink } from './components/home/ask-run-link'
import { installChunkReload } from './chunk-reload'

// A lazy part of the app that cannot load once the session ended reloads the page once (to sign-in), not an error.
installChunkReload(window)

// A link to one answer resolves to its conversation before the app reads the URL.
void resolveAskRunLink().finally(async () => {
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(<App />)
})
