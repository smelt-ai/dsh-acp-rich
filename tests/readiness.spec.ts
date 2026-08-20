import { describe, expect, it } from 'vitest'

import { createRuntimeGate, type LoaderEntryLike, type LoaderLike } from '../src/readiness.ts'

const ACTIVE = 2
const PENDING = 0
const LOADING = 1
const FAILED = 3

/** A Loader whose entries the test mutates between polls. */
function loaderOf(entries: LoaderEntryLike[]): LoaderLike {
  return { entries: () => entries }
}

describe('createRuntimeGate', () => {
  it('resolves immediately when no loader is composed', async () => {
    let slept = 0
    const gate = createRuntimeGate(() => undefined, { sleep: async () => { slept += 1 } })
    await gate()
    expect(slept).toBe(0)
  })

  it('waits until every enabled entry leaves the pending and loading states', async () => {
    const entries: LoaderEntryLike[] = [
      { options: { name: 'settings' }, fiber: { state: PENDING } },
      { options: { name: 'llm-pi-ai' }, fiber: { state: LOADING } },
      { options: { name: 'acp-rich' }, fiber: { state: ACTIVE } },
    ]
    let polls = 0
    const gate = createRuntimeGate(() => loaderOf(entries), {
      sleep: async () => {
        polls += 1
        if (polls === 1) entries[0]!.fiber = { state: ACTIVE }
        if (polls === 2) entries[1]!.fiber = { state: ACTIVE }
      },
    })
    await gate()
    expect(polls).toBe(2)
  })

  it('ignores disabled rows and accepts failed ones as settled', async () => {
    const gate = createRuntimeGate(() => loaderOf([
      { options: { name: 'webserver' }, disabled: true, fiber: { state: PENDING } },
      { options: { name: 'web-runtime' }, disabled: true },
      { options: { name: 'session-query-sqlite' }, fiber: { state: FAILED } },
    ]), {
      sleep: async () => { throw new Error('must not poll') },
    })
    await expect(gate()).resolves.toBeUndefined()
  })

  it('treats a row with no fiber yet as unsettled', async () => {
    const entries: LoaderEntryLike[] = [{ options: { name: 'credentials' } }]
    let polls = 0
    const gate = createRuntimeGate(() => loaderOf(entries), {
      sleep: async () => {
        polls += 1
        entries[0]!.fiber = { state: ACTIVE }
      },
    })
    await gate()
    expect(polls).toBe(1)
  })

  it('releases on the deadline and names what never settled', async () => {
    let clock = 0
    const timedOut: string[][] = []
    const gate = createRuntimeGate(() => loaderOf([
      { options: { name: 'stuck' }, fiber: { state: PENDING } },
    ]), {
      timeoutMs: 100,
      now: () => clock,
      sleep: async () => { clock += 40 },
      onTimeout: unsettled => { timedOut.push([...unsettled]) },
    })
    await gate()
    expect(timedOut).toEqual([['stuck']])
  })

  it('polls once for all callers and stays resolved afterwards', async () => {
    const entries: LoaderEntryLike[] = [{ options: { name: 'settings' }, fiber: { state: PENDING } }]
    let polls = 0
    const gate = createRuntimeGate(() => loaderOf(entries), {
      sleep: async () => {
        polls += 1
        entries[0]!.fiber = { state: ACTIVE }
      },
    })
    await Promise.all([gate(), gate()])
    entries[0]!.fiber = { state: PENDING }
    await gate()
    expect(polls).toBe(1)
  })
})
