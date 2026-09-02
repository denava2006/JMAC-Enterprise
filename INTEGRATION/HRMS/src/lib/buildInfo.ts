/**
 * Which build is running, and which database it is pointed at.
 *
 * Four hosted attempts at the F3 smoke test left no trace on the server, and
 * nothing on screen could distinguish "this build refused" from "this tab is
 * talking to somewhere else". A commit SHA, an environment name and a Supabase
 * project ref answer that from a screenshot.
 *
 * Nothing here is a secret. The project ref is in the URL of every request the
 * browser already makes; the anon key, service-role key and any credential are
 * deliberately absent and must stay that way.
 */

declare const __BUILD_COMMIT__: string
declare const __BUILD_ENV__: string
declare const __BUILD_TIME__: string

export type BuildEnvironment = 'PROD' | 'PREVIEW' | 'LOCAL'

/** Vercel says production | preview | development; anything else is a laptop. */
export function environmentLabel(raw: string | undefined): BuildEnvironment {
  if (raw === 'production') return 'PROD'
  if (raw === 'preview') return 'PREVIEW'
  return 'LOCAL'
}

/**
 * The project ref out of a Supabase URL.
 *
 * https://joffopwzqmlqpsrbivfq.supabase.co -> joffopwzqmlqpsrbivfq
 * http://127.0.0.1:55321                   -> local
 *
 * Reading it from the configured URL rather than from a separate variable is
 * the point: it names what the app will ACTUALLY talk to, not what somebody
 * meant to configure.
 */
export function supabaseRef(url: string | undefined): string {
  if (!url) return 'unset'
  try {
    const { hostname } = new URL(url)
    if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return 'local'
    const [ref] = hostname.split('.')
    return ref || 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface BuildInfo {
  environment: BuildEnvironment
  commit: string
  supabase: string
  builtAt: string
  origin: string
  /** PROD · ab11a56 · joffopwz… */
  short: string
}

export function truncateRef(ref: string, keep = 8): string {
  return ref.length > keep ? `${ref.slice(0, keep)}…` : ref
}

export function describeBuild(input: {
  env?: string
  commit?: string
  supabaseUrl?: string
  builtAt?: string
  origin?: string
}): BuildInfo {
  const environment = environmentLabel(input.env)
  const commit = input.commit || 'unknown'
  const supabase = supabaseRef(input.supabaseUrl)
  return {
    environment,
    commit,
    supabase,
    builtAt: input.builtAt || 'unknown',
    origin: input.origin || 'unknown',
    short: `${environment} · ${commit} · ${truncateRef(supabase)}`,
  }
}

/** The running build. Read once — none of it changes while the page is open. */
export const BUILD: BuildInfo = describeBuild({
  env: typeof __BUILD_ENV__ === 'string' ? __BUILD_ENV__ : undefined,
  commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : undefined,
  builtAt: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : undefined,
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  origin: typeof window !== 'undefined' ? window.location.origin : undefined,
})
