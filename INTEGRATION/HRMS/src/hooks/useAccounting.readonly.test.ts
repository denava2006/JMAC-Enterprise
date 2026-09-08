import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as accounting from '@/hooks/useAccounting'

/**
 * F8 observes; it does not originate.
 *
 * The database is the real guarantee — journal_entries carries no insert,
 * update or delete policy, and the posting function is revoked from every
 * client role, so a mutation written here would simply be refused. This test
 * exists so that refusal is never discovered in production: a hook that
 * offered to create or adjust an entry would ship a button that cannot work
 * and imply an accounting process JMAC does not have.
 */
describe('the accounting data layer', () => {
  // Read from disk rather than import.meta.url: under Vite that is an http URL.
  const source = readFileSync(resolve(process.cwd(), 'src/hooks/useAccounting.ts'), 'utf8')

  it('exports queries only — no mutation hook of any kind', () => {
    const exported = Object.keys(accounting)
    expect(exported.length).toBeGreaterThan(0)
    for (const name of exported) {
      expect(name).toMatch(/^use(JournalEntries|JournalEntryLines|LedgerLines|TrialBalance)$/)
    }
  })

  it('never calls useMutation, and never writes through supabase', () => {
    expect(source).not.toMatch(/useMutation/)
    expect(source).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })

  // The posting function is the one path that creates an entry, and it belongs
  // to the database trigger that fires when money moves. A client that could
  // call it could post a journal for a transaction that never happened.
  it('never invokes the posting function', () => {
    expect(source).not.toMatch(/post_treasury_movement_journal/)
  })
})
