/** The stamp exists to end an argument, so it has to be right.
 *
 * Four hosted attempts at the F3 smoke test left no server-side trace, and
 * nothing on screen could distinguish "this build refused" from "this tab is
 * talking to somewhere else". These check that the three facts it shows are
 * derived rather than asserted — and that no secret is among them.
 */
import { describe, it, expect } from 'vitest'
import { describeBuild, environmentLabel, supabaseRef, truncateRef } from './buildInfo'

describe('which environment', () => {
  it.each([
    ['production', 'PROD'],
    ['preview', 'PREVIEW'],
    ['development', 'LOCAL'],
    [undefined, 'LOCAL'],
    ['', 'LOCAL'],
    ['something-else', 'LOCAL'],
  ])('%s reads as %s', (raw, expected) => {
    expect(environmentLabel(raw as string | undefined)).toBe(expected)
  })

  it('never calls anything PROD that Vercel did not call production', () => {
    // The whole value of the stamp is that PROD means PROD.
    for (const raw of ['prod', 'Production', 'preview', 'staging', undefined]) {
      expect(environmentLabel(raw), String(raw)).not.toBe(
        raw === 'production' ? 'not-reached' : 'PROD',
      )
    }
  })
})

describe('which database', () => {
  it('takes the ref from the URL the app will actually call', () => {
    expect(supabaseRef('https://joffopwzqmlqpsrbivfq.supabase.co')).toBe('joffopwzqmlqpsrbivfq')
  })

  it('names a local stack as local rather than as a project', () => {
    expect(supabaseRef('http://127.0.0.1:55321')).toBe('local')
    expect(supabaseRef('http://localhost:54321')).toBe('local')
  })

  it('says so when it is unset or unreadable', () => {
    expect(supabaseRef(undefined)).toBe('unset')
    expect(supabaseRef('')).toBe('unset')
    expect(supabaseRef('not a url')).toBe('unknown')
  })

  it('distinguishes two different projects', () => {
    // The exact confusion this was built to rule out.
    expect(supabaseRef('https://tmvdiqeluqyretmemwsr.supabase.co')).not.toBe(
      supabaseRef('https://joffopwzqmlqpsrbivfq.supabase.co'),
    )
  })
})

describe('the compact line', () => {
  it('reads PROD · commit · ref', () => {
    const build = describeBuild({
      env: 'production',
      commit: 'ab11a56',
      supabaseUrl: 'https://joffopwzqmlqpsrbivfq.supabase.co',
    })
    expect(build.short).toBe('PROD · ab11a56 · joffopwz…')
  })

  it('makes a preview build obvious at a glance', () => {
    const build = describeBuild({
      env: 'preview',
      commit: 'deadbee',
      supabaseUrl: 'https://joffopwzqmlqpsrbivfq.supabase.co',
    })
    expect(build.short.startsWith('PREVIEW')).toBe(true)
  })

  it('makes a localhost tab obvious at a glance', () => {
    const build = describeBuild({ commit: 'deadbee', supabaseUrl: 'http://127.0.0.1:55321' })
    expect(build.short).toBe('LOCAL · deadbee · local')
  })

  it('admits an unknown commit rather than inventing a version', () => {
    expect(describeBuild({ env: 'production' }).commit).toBe('unknown')
  })

  it('shortens only what needs shortening', () => {
    expect(truncateRef('joffopwzqmlqpsrbivfq')).toBe('joffopwz…')
    expect(truncateRef('local')).toBe('local')
  })
})

describe('nothing secret is on screen', () => {
  it('carries no key, token or password field', () => {
    const build = describeBuild({
      env: 'production',
      commit: 'ab11a56',
      supabaseUrl: 'https://joffopwzqmlqpsrbivfq.supabase.co',
      origin: 'https://jmac-enterprise.vercel.app',
    })
    const serialised = JSON.stringify(build).toLowerCase()
    for (const forbidden of ['key', 'secret', 'token', 'password', 'jwt', 'anon', 'service_role']) {
      expect(serialised, forbidden).not.toContain(forbidden)
    }
  })
})
