import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In development the browser loads Vite directly. Native/API traffic is proxied to
// the windowless Rust tray host on its stable development port.
const host = process.env.TAURI_DEV_HOST
const hostServer = process.env.DEVTREES_HOST_URL ?? 'http://127.0.0.1:1430'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: '/',
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
    host: host || '127.0.0.1',
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    proxy: {
      '/api': { target: hostServer, changeOrigin: false },
      '/events': { target: hostServer, changeOrigin: false, ws: true }
    },
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
