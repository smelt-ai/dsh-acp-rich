import { describe, expect, it } from 'vitest'

import { joinAgentPreset } from '../src/presets.ts'
import type { HarnessAgentContext } from '../src/harness.ts'

const agentCtx = {} as HarnessAgentContext

/** A host context exposing exactly one service lookup. */
function hostWith(service: unknown) {
  return { get: (name: string) => (name === 'agentPresets' ? service : undefined) }
}

describe('joinAgentPreset', () => {
  it('mounts the deployment default when no preset is configured', async () => {
    const calls: unknown[][] = []
    const result = await joinAgentPreset(
      hostWith({ mount: async (...args: unknown[]) => void calls.push(args) }),
      agentCtx,
    )
    expect(result).toEqual({ joined: true })
    expect(calls).toEqual([[agentCtx, undefined]])
  })

  it('mounts the configured preset by id', async () => {
    const calls: unknown[][] = []
    await joinAgentPreset(
      hostWith({ mount: async (...args: unknown[]) => void calls.push(args) }),
      agentCtx,
      'code',
    )
    expect(calls).toEqual([[agentCtx, 'code']])
  })

  // A rosterless deployment puts the model-facing rows in the host composition,
  // so there is nothing to join and nothing to warn about.
  it('reports an absent registry without treating it as a failure', async () => {
    expect(await joinAgentPreset(hostWith(undefined), agentCtx)).toEqual({
      joined: false,
      reason: 'absent',
    })
  })

  it('treats a service without mount as absent', async () => {
    expect(await joinAgentPreset(hostWith({ mount: 'not a function' }), agentCtx)).toEqual({
      joined: false,
      reason: 'absent',
    })
  })

  // Failing the mount would cost the user the whole session, and running
  // without a preset is what this bridge already did; report it instead.
  it('reports a mount failure instead of throwing', async () => {
    const error = new Error('unknown preset')
    const result = await joinAgentPreset(
      hostWith({
        mount: async () => {
          throw error
        },
      }),
      agentCtx,
    )
    expect(result).toEqual({ joined: false, reason: 'failed', error })
  })
})
