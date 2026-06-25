import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Standard Vite config for the Tauri build. The React renderer lives in src/renderer
// (unchanged from the Electron layout); Tauri serves it from the dev server in
// development and from the static `dist-web` build in production.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  // Tauri expects a relative base so assets resolve under the custom app protocol.
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()],

  // Prevent Vite from obscuring Rust errors during `tauri dev`.
  clearScreen: false,
  // Tauri-specific env vars should be exposed to the client.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // Don't watch the Rust source tree from the Vite dev server.
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    // WebView2 on Windows 10/11 supports modern ES; align with Tauri defaults.
    target: 'esnext',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG
  }
})
