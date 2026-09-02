/// <reference types="vitest/config" />
import path from 'node:path'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Which build is this, and what is it talking to?
 *
 * Four hosted attempts at the F3 smoke test produced no server-side trace at
 * all, and the logs could not distinguish "the app refused" from "this tab is
 * not talking to production". Neither could a screenshot. These three constants
 * are baked in at build time so the running app can answer it out loud.
 *
 * Vercel's system variables are not VITE_-prefixed, so they cannot be read from
 * import.meta.env -- they are injected here instead. None of this is secret: a
 * commit SHA, an environment name, and a project ref that is already in every
 * request URL the browser sends.
 */
function commitSha(): string {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA
  if (fromVercel) return fromVercel.slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // A build from a tarball with no git history. Better to say so than to
    // invent a version number that looks real.
    return 'unknown'
  }
}

/** production | preview | development, straight from Vercel; anything else is
 *  somebody's machine. */
function buildEnvironment(): string {
  return process.env.VERCEL_ENV ?? 'local'
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(commitSha()),
    __BUILD_ENV__: JSON.stringify(buildEnvironment()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
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
