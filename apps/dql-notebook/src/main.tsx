import React from 'react'
import { createRoot } from 'react-dom/client'
import '@duckcodeailabs/dql-ui/styles'
import { resolveAskRunLink } from './components/home/ask-run-link'
import { installChunkReload } from './chunk-reload'
import { loadInterfaceFonts } from './interface-fonts'

// A lazy part of the app that cannot load once the session ended reloads the page once (to sign-in), not an error.
installChunkReload(window)

// Both Inter files load while the app's code does, so no layout runs against a file that is still loading
// (interface-fonts.ts says why that can stop the page). A missing file never holds the app back for long.
const interfaceFonts = loadInterfaceFonts(typeof document === 'undefined' ? undefined : document.fonts)

// A link to one answer resolves to its conversation before the app reads the URL.
void resolveAskRunLink().finally(async () => {
  const [{ App }] = await Promise.all([import('./App'), interfaceFonts])
  createRoot(document.getElementById('root')!).render(<App />)
})
