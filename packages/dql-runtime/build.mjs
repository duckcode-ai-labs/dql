import { build } from 'esbuild';

// Build the runtime as a single IIFE bundle for browser embedding
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'DQLRuntime',
  outfile: 'dist/dql-runtime.browser.js',
  minify: false,
  sourcemap: false,
  target: ['es2020'],
  platform: 'browser',
});

// Also build a minified version
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'DQLRuntime',
  outfile: 'dist/dql-runtime.browser.min.js',
  minify: true,
  sourcemap: false,
  target: ['es2020'],
  platform: 'browser',
});

// ESM build for module consumers
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/dql-runtime.esm.js',
  minify: false,
  sourcemap: true,
  target: ['es2020'],
  platform: 'browser',
});

console.log('[ZLens Runtime] Build complete');
