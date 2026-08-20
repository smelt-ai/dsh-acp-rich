import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireSessionLease,
  apply,
  releaseSessionLease,
} from '../src/lease.ts'
import type { HarnessSession } from '../src/harness.ts'

describe.sequential('cross-host session leases', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-lease-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('rejects a second owner for the same session', () => {
    const lease = acquireSessionLease('session-1')
    expect(() => acquireSessionLease('session-1')).toThrow(/already active/)
    releaseSessionLease(lease)
  })

  it('releases the lease when the live session is disposed', () => {
    const listeners = new Map<string, (session: HarnessSession) => void>()
    let cleanup = (): void => {}
    apply({
      on(event, listener) {
        listeners.set(event, listener)
      },
      effect(factory) {
        cleanup = factory()
      },
    })
    const session = { header: { id: 'session-2' }, events: [] }
    listeners.get('session/created')?.(session)
    expect(() => acquireSessionLease('session-2')).toThrow(/already active/)
    listeners.get('session/disposed')?.(session)
    const lease = acquireSessionLease('session-2')
    releaseSessionLease(lease)
    cleanup()
  })
})
