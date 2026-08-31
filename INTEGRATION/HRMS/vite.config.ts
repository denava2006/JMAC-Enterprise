/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // jsdom rather than node because these tests exercise routing and portal
    // decisions, which read from a DOM-shaped environment.
    environment: 'jsdom',
    globals: true,
    // Edge Function code is included so the PayMongo webhook signature check
    // is actually tested rather than reviewed. The shared module uses only Web
    // Crypto, so it runs unchanged in Deno and here.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'supabase/functions/**/*.test.ts'],
  },
})
