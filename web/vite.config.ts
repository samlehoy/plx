import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The site shows the CLI's version, and the root package.json is the project's one version
// (scripts/sync-version.mjs), so it is read from there at build time instead of being hardcoded.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __PLX_VERSION__: JSON.stringify(version) },
})
