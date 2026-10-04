/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fontLicence } from '@duckcodeailabs/dql-ui/font-licence'

export default defineConfig({
  // fontLicence: Inter's licence ships beside the font files in dist/assets.
  plugins: [react(), tailwindcss(), fontLicence()],
  server: {
    port: 5174,
    // Proxy all /api/* requests to the running dql notebook server
    // Start the server first: dql notebook --no-open --port 3475
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3475',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/lang-sql',
            '@codemirror/language',
            '@codemirror/theme-one-dark',
          ],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  base: '/',
  test: {
    // Gives Node 20 the global `navigator` that Node 21+ has (see the file).
    setupFiles: ['./vitest.setup.ts'],
  },
})
