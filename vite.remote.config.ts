import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/remote'),
  base: '/',
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 1422,
    strictPort: true
  },
  build: {
    outDir: resolve(__dirname, 'dist-remote'),
    emptyOutDir: true,
    target: 'es2022'
  }
})
