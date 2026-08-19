import { afterEach, describe, expect, it } from 'vitest'
import {
  makeRig,
  openSession,
  recordingInstaller,
  updatesOfKind,
  waitFor,
  type Rig,
} from './harness.ts'
import type { HarnessModelSelectionRef } from '../src/config.ts'

let rig: Rig | undefined

afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

/** Concatenate the text of every chunk update of one kind. */
function textOf(current: Rig, kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk'): string {
  return updatesOfKind(current, kind)
    .map(update => update.content.type === 'text' ? update.content.text : '')
    .join('')
}

describe('initialize', () => {
  it('reports the ACP version the smelt client pins', async () => {
    rig = makeRig()
    const response = await rig.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    expect(response.protocolVersion).toBe(1)
  })

  it('advertises image prompts only when an attachment store is composed', async () => {
    rig = makeRig()
    const without = await rig.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    expect(without.agentCapabilities?.promptCapabilities?.image).toBe(false)

    rig.ctx.installAttachments()
    const with_ = await rig.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    expect(with_.agentCapabilities?.promptCapabilities?.image).toBe(true)
  })

  it('advertises loadSession from the registry that must serve it', async () => {
    rig = makeRig()
    const response = await rig.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    expect(response.agentCapabilities?.loadSession).toBe(true)
  })
})

describe('streaming', () => {
  it('streams text deltas and reasoning on their separate channels', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'plan it' } })
      agent.emit('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } })
      agent.emit('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } })
      agent.emit('assistant/message', {
        turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello' }] },
      })
      await agent.endTurn()
    }
    const response = await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(response.stopReason).toBe('end_turn')
    await waitFor(() => textOf(current, 'agent_message_chunk') === 'Hello', 'streamed text')
    expect(textOf(current, 'agent_thought_chunk')).toBe('plan it')
  })

  it('renders the committed message when the adapter streamed nothing', async () => {
    // A non-streaming adapter emits no deltas. Suppressing the commit as well
    // would drop the answer entirely.
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('assistant/message', {
        turn: 1, step: 1, message: { content: [{ type: 'text', text: 'whole answer' }] },
      })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await waitFor(() => textOf(current, 'agent_message_chunk') === 'whole answer', 'committed text')
  })

  it('does not double-render a message that already streamed', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'once' } })
      agent.emit('assistant/message', {
        turn: 1, step: 1, message: { content: [{ type: 'text', text: 'once' }] },
      })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    await waitFor(() => updatesOfKind(current, 'agent_message_chunk').length > 0, 'a chunk')
    expect(textOf(current, 'agent_message_chunk')).toBe('once')
  })

  it('does not echo the live user prompt back to the client that sent it', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    expect(updatesOfKind(current, 'user_message_chunk')).toHaveLength(0)
  })
})

describe('tool cards', () => {
  it('maps a diff presenter onto inline ACP diff content', async () => {
    rig = makeRig()
    const current = rig
    current.ctx.installTools({
      str_replace: {
        presentCall: (args: unknown) => {
          const typed = args as { path: string; old_str?: string; new_str?: string }
          return {
            card: 'diff',
            title: `str_replace ${typed.path}`,
            diffs: [{ path: typed.path, oldText: typed.old_str ?? null, newText: typed.new_str ?? '' }],
            locations: [{ path: typed.path }],
          }
        },
        presentResult: (args: unknown) => {
          const typed = args as { path: string; new_str?: string }
          return {
            card: 'diff',
            diffs: [{ path: typed.path, oldText: null, newText: typed.new_str ?? '' }],
          }
        },
      },
    })
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('tool/call', {
        turn: 1, step: 1, callId: 'c1', name: 'str_replace',
        arguments: JSON.stringify({ path: 'src/a.ts', old_str: 'a', new_str: 'b' }),
      })
      agent.emit('tool/result', {
        turn: 1, step: 1,
        message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
      })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'edit' }] })
    await waitFor(() => updatesOfKind(current, 'tool_call_update').length > 0, 'a result card')

    const [call] = updatesOfKind(current, 'tool_call')
    expect(call).toMatchObject({
      toolCallId: 'c1',
      title: 'str_replace src/a.ts',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'src/a.ts' }],
    })
    expect(call?.content).toEqual([
      { type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' },
    ])

    const [update] = updatesOfKind(current, 'tool_call_update')
    expect(update).toMatchObject({ toolCallId: 'c1', status: 'completed' })
    expect(update?.content).toEqual([
      { type: 'diff', path: 'src/a.ts', oldText: null, newText: 'b' },
    ])
  })

  it('marks a failed call failed and still shows its output', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })
      agent.emit('tool/result', {
        turn: 1, step: 1,
        message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }] }] },
        error: { name: 'ToolError', code: 'EFAIL' },
      })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'run' }] })
    await waitFor(() => updatesOfKind(current, 'tool_call_update').length > 0, 'a result card')
    const [update] = updatesOfKind(current, 'tool_call_update')
    expect(update?.status).toBe('failed')
    expect(JSON.stringify(update?.content)).toContain('boom')
  })

  it('gives a tool with no presenter a generic card carrying its raw input', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'mystery', arguments: '{"a":1}' })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] })
    await waitFor(() => updatesOfKind(current, 'tool_call').length > 0, 'a call card')
    expect(updatesOfKind(current, 'tool_call')[0]).toMatchObject({
      title: 'mystery', kind: 'other', rawInput: { a: 1 },
    })
  })

  it('survives a throwing presenter by falling back to the generic card', async () => {
    rig = makeRig()
    const current = rig
    current.ctx.installTools({
      cursed: { presentCall: () => { throw new Error('presenter exploded') } },
    })
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'cursed', arguments: '{}' })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] })
    await waitFor(() => updatesOfKind(current, 'tool_call').length > 0, 'a call card')
    expect(updatesOfKind(current, 'tool_call')[0]?.title).toBe('cursed')
    expect(current.ctx.logs.join('\n')).toContain('presenter exploded')
  })
})

describe('plan and usage', () => {
  it('publishes the todo snapshot as a plan', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      agent.emit('todo/write', {
        todos: [
          { content: 'read code', status: 'completed' },
          { content: 'write patch', status: 'in_progress' },
        ],
      })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] })
    await waitFor(() => updatesOfKind(current, 'plan').length > 0, 'a plan')
    expect(updatesOfKind(current, 'plan')[0]?.entries).toEqual([
      { content: 'read code', priority: 'medium', status: 'completed' },
      { content: 'write patch', priority: 'medium', status: 'in_progress' },
    ])
  })

  it('publishes usage only after the route advertised its context window', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => {
      // Usage before the window is known: no denominator, no gauge.
      agent.emit('assistant/message', {
        turn: 1, step: 1, message: { content: [] }, usage: { inputTokens: 10, outputTokens: 5 },
      })
      agent.emit('request/context', { provider: 'p', model: 'm', contextWindow: 1000 })
      agent.emit('assistant/message', {
        turn: 1, step: 2, message: { content: [] },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 85 },
      })
      await agent.endTurn()
    }
    await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] })
    await waitFor(() => updatesOfKind(current, 'usage_update').length > 0, 'a usage update')
    expect(updatesOfKind(current, 'usage_update')).toEqual([
      { sessionUpdate: 'usage_update', used: 100, size: 1000 },
    ])
  })
})

describe('available commands', () => {
  it('publishes the roster when a session opens', async () => {
    rig = makeRig()
    const current = rig
    current.ctx.installCommands([{ name: 'compact', description: 'Compact history' }])
    await openSession(current)
    await waitFor(() => updatesOfKind(current, 'available_commands_update').length > 0, 'commands')
    expect(updatesOfKind(current, 'available_commands_update')[0]?.availableCommands)
      .toEqual([{ name: 'compact', description: 'Compact history' }])
  })

  it('republishes when the registry changes', async () => {
    rig = makeRig()
    const current = rig
    current.ctx.installCommands([{ name: 'a', description: 'A' }])
    await openSession(current)
    await waitFor(() => updatesOfKind(current, 'available_commands_update').length === 1, 'first roster')
    current.ctx.installCommands([{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }])
    current.ctx.emit('commands/change')
    await waitFor(() => updatesOfKind(current, 'available_commands_update').length === 2, 'second roster')
    expect(updatesOfKind(current, 'available_commands_update')[1]?.availableCommands).toHaveLength(2)
  })
})

describe('permissions', () => {
  it('asks the client and honours a one-shot allow', async () => {
    rig = makeRig()
    const current = rig
    current.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    expect(await current.requestApproval(agent, 'bash', 'c1')).toBe('allowed-once')
    expect(current.permissions).toHaveLength(1)
    expect(current.permissions[0]?.toolCall.toolCallId).toBe('c1')
    // Asked again: still one-shot, so the client is asked again.
    expect(await current.requestApproval(agent, 'bash', 'c2')).toBe('allowed-once')
    expect(current.permissions).toHaveLength(2)
  })

  it('answers later requests itself once the user chose always', async () => {
    rig = makeRig()
    const current = rig
    current.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-always' } })
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    expect(await current.requestApproval(agent, 'bash', 'c1')).toBe('allowed-once')
    expect(await current.requestApproval(agent, 'bash', 'c2')).toBe('allowed-once')
    expect(current.permissions).toHaveLength(1)
  })

  it('keeps a standing decision scoped to its own tool', async () => {
    rig = makeRig()
    const current = rig
    current.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-always' } })
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    await current.requestApproval(agent, 'bash', 'c1')
    await current.requestApproval(agent, 'write', 'c2')
    expect(current.permissions).toHaveLength(2)
  })

  it('honours a standing rejection without asking again', async () => {
    rig = makeRig()
    const current = rig
    current.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'reject-always' } })
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    expect(await current.requestApproval(agent, 'bash', 'c1')).toBe('rejected')
    expect(await current.requestApproval(agent, 'bash', 'c2')).toBe('rejected')
    expect(current.permissions).toHaveLength(1)
  })

  it('propagates a withdrawn question', async () => {
    rig = makeRig()
    const current = rig
    current.onPermission = () => ({ outcome: { outcome: 'cancelled' } })
    const sessionId = await openSession(current)
    expect(await current.requestApproval(current.agentFor(sessionId), 'bash', 'c1')).toBe('cancelled')
  })

  it('declines a question about an agent it does not own', async () => {
    rig = makeRig()
    const current = rig
    await openSession(current)
    const stranger = { id: 'x', session: { header: { id: 'nope' }, events: [] } }
    expect(await current.requestApproval(stranger as never, 'bash', 'c1')).toBe('unavailable')
    expect(current.permissions).toHaveLength(0)
  })
})

describe('prompt content', () => {
  it('refuses an image prompt with no attachment store composed', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    await expect(current.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    })).rejects.toThrow()
  })

  it('commits an image to the attachment store and delivers its reference', async () => {
    rig = makeRig()
    const current = rig
    const store = current.ctx.installAttachments()
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => { await agent.endTurn() }
    await current.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'look' },
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' },
      ],
    })
    expect(store.saved).toEqual([{ mediaType: 'image/png', bytes: 9 }])
    const delivered = agent.delivered[0]?.content as { type: string }[]
    expect(delivered?.map(block => block.type)).toEqual(['text', 'image'])
  })

  it('refuses an empty prompt', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    await expect(current.client.prompt({ sessionId, prompt: [] })).rejects.toThrow()
  })

  it('refuses a second prompt while one is in flight', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = undefined
    const pending = current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'a' }] })
    await waitFor(() => agent.delivered.length === 1, 'first delivery')
    await expect(current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'b' }] }))
      .rejects.toThrow()
    await agent.endTurn()
    await pending
  })

  it('rejects a prompt for a session that does not exist', async () => {
    rig = makeRig()
    const current = rig
    await openSession(current)
    await expect(current.client.prompt({ sessionId: 'ghost', prompt: [{ type: 'text', text: 'a' }] }))
      .rejects.toThrow()
  })
})

describe('turn endings', () => {
  it('reports a token-limit ending as an ordinary end of turn', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = async () => { await agent.endTurn('max-tokens') }
    const response = await current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] })
    expect(response.stopReason).toBe('end_turn')
  })

  it('fails the prompt when the turn ended in a model error', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = () => {
      agent.emit('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'provider down' } } })
    }
    await expect(current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] }))
      .rejects.toThrow(/provider down/u)
  })

  it('settles a cancelled prompt and stops the agent', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    agent.onPrompt = undefined
    const pending = current.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] })
    await waitFor(() => agent.delivered.length === 1, 'delivery')
    await current.client.cancel({ sessionId })
    expect(await pending).toEqual({ stopReason: 'cancelled' })
    expect(agent.cancelled).toBe(true)
  })
})

describe('MCP passthrough', () => {
  const init = {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }

  it('advertises only the transports the harness client can speak', async () => {
    rig = makeRig()
    const response = await rig.client.initialize(init)
    expect(response.agentCapabilities?.mcpCapabilities).toMatchObject({ http: true, sse: false, acp: false })
  })

  it('mounts a session server before the agent is published', async () => {
    // Mounting has to finish inside `setup`; a registration that lands after the
    // handle returns races the first prompt assembly.
    const mounted: unknown[] = []
    const current = makeRig({
      mountMcpServers: async (agentCtx, servers) => {
        // The scope must be live and empty at this point: nothing has run yet.
        expect(current.ctx.handles.size).toBe(0)
        for (const server of servers) { agentCtx.plugin({ name: 'mcp-client' }, server); mounted.push(server) }
      },
    })
    rig = current
    await rig.client.initialize(init)
    await rig.client.newSession({
      cwd: '/workspace',
      mcpServers: [{ name: 'smelt', command: 'smelt-mcp', args: ['--stdio'], env: [] }],
    })
    expect(mounted).toEqual([{
      transport: 'stdio',
      serverName: 'smelt',
      command: 'smelt-mcp',
      args: ['--stdio'],
      env: {},
      cwd: '/workspace',
    }])
    expect(rig.ctx.mountedPlugins).toHaveLength(1)
  })

  it('mounts on a resumed session too', async () => {
    const mounted: unknown[] = []
    rig = makeRig({ mountMcpServers: async (_ctx, servers) => { mounted.push(...servers) } })
    rig.ctx.persisted.set('old-session', [])
    await rig.client.initialize(init)
    await rig.client.loadSession({
      sessionId: 'old-session',
      cwd: '/workspace',
      mcpServers: [{ name: 'smelt', command: 'smelt-mcp', args: [], env: [] }],
    })
    expect(mounted).toHaveLength(1)
  })

  it('never reaches the mounter when a session carries no servers', async () => {
    let called = false
    rig = makeRig({ mountMcpServers: async () => { called = true } })
    await rig.client.initialize(init)
    await rig.client.newSession({ cwd: '/workspace', mcpServers: [] })
    expect(called).toBe(false)
  })

  it('opens the session anyway when a server cannot be reached', async () => {
    // An unreachable optional server should cost the user that server, not the
    // whole session.
    rig = makeRig({ mountMcpServers: async () => { throw new Error('connect refused') } })
    await rig.client.initialize(init)
    const session = await rig.client.newSession({
      cwd: '/workspace',
      mcpServers: [{ name: 'smelt', command: 'smelt-mcp', args: [], env: [] }],
    })
    expect(session.sessionId).toBeTypeOf('string')
    expect(rig.ctx.logs.some(line => line.includes('could not mount MCP servers'))).toBe(true)
  })

  it('warns by name about a server it had to skip', async () => {
    rig = makeRig({ mountMcpServers: async () => {} })
    await rig.client.initialize(init)
    await rig.client.newSession({
      cwd: '/workspace',
      mcpServers: [{ name: 'legacy', type: 'sse', url: 'https://example.test/sse', headers: [] }],
    })
    expect(rig.ctx.logs.some(line => line.includes('skipped MCP server legacy'))).toBe(true)
  })
})

describe('session/load', () => {
  it('replays a persisted transcript through the same projectors', async () => {
    rig = makeRig()
    const current = rig
    current.ctx.installTools({
      write: {
        presentCall: () => ({
          card: 'diff',
          title: 'Write a.ts',
          diffs: [{ path: 'a.ts', oldText: null, newText: 'x' }],
        }),
      },
    })
    current.ctx.persisted.set('old-session', [
      { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } } },
      { type: 'tool/call', seq: 1, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' } },
      { type: 'tool/result', seq: 2, time: 0, data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }] } } },
      { type: 'assistant/message', seq: 3, time: 0, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'finished' }] } } },
      { type: 'todo/write', seq: 4, time: 0, data: { todos: [{ content: 'ship', status: 'completed' }] } },
    ])
    await current.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    await current.client.loadSession({ sessionId: 'old-session', cwd: '/workspace', mcpServers: [] })

    expect(textOf(current, 'user_message_chunk')).toBe('do it')
    expect(textOf(current, 'agent_message_chunk')).toBe('finished')
    expect(updatesOfKind(current, 'tool_call')[0]).toMatchObject({ title: 'Write a.ts', kind: 'edit' })
    expect(updatesOfKind(current, 'tool_call_update')[0]).toMatchObject({ status: 'completed' })
    expect(updatesOfKind(current, 'plan')[0]?.entries).toHaveLength(1)
  })

  it('lets a resumed session take a new prompt', async () => {
    rig = makeRig()
    const current = rig
    current.ctx.persisted.set('old-session', [])
    await current.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    await current.client.loadSession({ sessionId: 'old-session', cwd: '/workspace', mcpServers: [] })
    const agent = current.agentFor('old-session')
    agent.onPrompt = async () => {
      agent.emit('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'again' } })
      await agent.endTurn()
    }
    const response = await current.client.prompt({
      sessionId: 'old-session', prompt: [{ type: 'text', text: 'continue' }],
    })
    expect(response.stopReason).toBe('end_turn')
    await waitFor(() => textOf(current, 'agent_message_chunk') === 'again', 'live text after resume')
  })

  it('answers method-not-found when the deployment keeps no transcripts', async () => {
    // A profile with no `sessionPersistence` provider has the registry method
    // and nothing to load through it. smelt classifies method-not-found as
    // UnsupportedLoad and opens a fresh session; any other error code would
    // surface as a broken agent instead.
    rig = makeRig()
    const current = rig
    current.ctx.supportsResume = false
    await current.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    await expect(current.client.loadSession({
      sessionId: 'old-session', cwd: '/workspace', mcpServers: [],
    })).rejects.toMatchObject({ code: -32601 })
  })

  it('does not advertise loadSession when it cannot serve it', async () => {
    rig = makeRig()
    const current = rig
    current.ctx.supportsResume = false
    const response = await current.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    expect(response.agentCapabilities?.loadSession).toBe(false)
  })

  it('rejects a relative cwd', async () => {
    rig = makeRig()
    const current = rig
    await current.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    await expect(current.client.newSession({ cwd: 'relative/path', mcpServers: [] })).rejects.toThrow()
  })
})

describe('teardown', () => {
  it('cancels live agents and disposes them', async () => {
    rig = makeRig()
    const current = rig
    const sessionId = await openSession(current)
    const agent = current.agentFor(sessionId)
    await current.ctx.teardown?.()
    expect(agent.cancelled).toBe(true)
    expect(current.ctx.handles.size).toBe(0)
    rig = undefined
  })
})

describe('session config options', () => {
  it('publishes no selectors to a client that never asked for them', async () => {
    const cells: HarnessModelSelectionRef[] = []
    rig = makeRig({ installModelSelection: recordingInstaller(cells) })
    const current = rig
    current.ctx.installModels({ default: { provider: 'deepseek', model: 'deepseek-chat' } })
    await current.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const created = await current.client.newSession({ cwd: '/workspace', mcpServers: [] })
    expect(created.configOptions ?? []).toEqual([])
  })

  it('returns the model selector from session/new', async () => {
    const cells: HarnessModelSelectionRef[] = []
    rig = makeRig({ installModelSelection: recordingInstaller(cells) })
    const current = rig
    current.ctx.installModels({ default: { provider: 'deepseek', model: 'deepseek-chat' } })
    await current.client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: { configOptions: {} },
      },
    })
    const created = await current.client.newSession({ cwd: '/workspace', mcpServers: [] })
    const model = (created.configOptions ?? []).find(option => option.category === 'model')
    expect(model).toBeDefined()
    expect((model as { currentValue: string }).currentValue).toBe('deepseek/deepseek-chat')
    expect(cells).toHaveLength(1)
  })

  it('publishes no selector when the coupling into the agent is unavailable', async () => {
    // A picker that cannot make a switch take effect is worse than no picker.
    rig = makeRig({ installModelSelection: recordingInstaller([], false) })
    const current = rig
    current.ctx.installModels({ default: { provider: 'deepseek', model: 'deepseek-chat' } })
    const sessionId = await openSession(current, '/workspace', { configOptions: true })
    await expect(current.client.setSessionConfigOption({
      sessionId, configId: 'model', value: 'deepseek/deepseek-reasoner',
    })).rejects.toThrow()
  })

  it('learns the route from the first resolved request and publishes then', async () => {
    // No config model and no deployment default: the bridge genuinely does not
    // know the route until the session runs one.
    const cells: HarnessModelSelectionRef[] = []
    rig = makeRig({ installModelSelection: recordingInstaller(cells) })
    const current = rig
    current.ctx.installModels()
    const sessionId = await openSession(current, '/workspace', { configOptions: true })
    expect(updatesOfKind(current, 'config_option_update')).toHaveLength(0)
    current.agentFor(sessionId).emit('request/context', {
      provider: 'deepseek', model: 'deepseek-reasoner', contextWindow: 128000,
    })
    await waitFor(
      () => updatesOfKind(current, 'config_option_update').length > 0,
      'config option update',
    )
    const published = updatesOfKind(current, 'config_option_update')[0]?.configOptions ?? []
    expect(published.map(option => option.id)).toEqual(['model', 'reasoning_effort'])
    expect(cells[0]?.current).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('never overwrites a chosen model with an observed route', async () => {
    const cells: HarnessModelSelectionRef[] = []
    rig = makeRig({ installModelSelection: recordingInstaller(cells) })
    const current = rig
    current.ctx.installModels({ default: { provider: 'deepseek', model: 'deepseek-chat' } })
    const sessionId = await openSession(current, '/workspace', { configOptions: true })
    current.agentFor(sessionId).emit('request/context', {
      provider: 'deepseek', model: 'deepseek-reasoner',
    })
    expect(cells[0]?.current).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('applies a model switch to the cell the agent routes through', async () => {
    const cells: HarnessModelSelectionRef[] = []
    rig = makeRig({ installModelSelection: recordingInstaller(cells) })
    const current = rig
    current.ctx.installModels({ default: { provider: 'deepseek', model: 'deepseek-chat' } })
    const sessionId = await openSession(current, '/workspace', { configOptions: true })
    const response = await current.client.setSessionConfigOption({
      sessionId, configId: 'model', value: 'deepseek/deepseek-reasoner',
    })
    expect(cells[0]?.current).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    // The whole roster comes back, because the effort selector only exists now.
    expect(response.configOptions.map(option => option.id)).toEqual(['model', 'reasoning_effort'])
  })

  it('rejects an unknown model as invalid params, leaving the route alone', async () => {
    const cells: HarnessModelSelectionRef[] = []
    rig = makeRig({ installModelSelection: recordingInstaller(cells) })
    const current = rig
    current.ctx.installModels({ default: { provider: 'deepseek', model: 'deepseek-chat' } })
    const sessionId = await openSession(current, '/workspace', { configOptions: true })
    await expect(current.client.setSessionConfigOption({
      sessionId, configId: 'model', value: 'deepseek/ghost',
    })).rejects.toMatchObject({ code: -32602 })
    expect(cells[0]?.current).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('applies a reasoning effort and clears it again', async () => {
    const cells: HarnessModelSelectionRef[] = []
    rig = makeRig({ installModelSelection: recordingInstaller(cells) })
    const current = rig
    current.ctx.installModels({ default: { provider: 'deepseek', model: 'deepseek-reasoner' } })
    const sessionId = await openSession(current, '/workspace', { configOptions: true })
    await current.client.setSessionConfigOption({
      sessionId, configId: 'reasoning_effort', value: 'high',
    })
    expect(cells[0]?.current?.reasoningEffort).toBe('high')
    const cleared = await current.client.setSessionConfigOption({
      sessionId, configId: 'reasoning_effort', value: '__default',
    })
    expect(cells[0]?.current?.reasoningEffort).toBeUndefined()
    const effort = cleared.configOptions.find(option => option.id === 'reasoning_effort')
    expect((effort as { currentValue: string }).currentValue).toBe('__default')
  })

  it('refuses a text-only model once the session carries an image', async () => {
    const cells: HarnessModelSelectionRef[] = []
    rig = makeRig({ installModelSelection: recordingInstaller(cells) })
    const current = rig
    current.ctx.installModels({
      providers: [{
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          { id: 'vision', name: 'Vision', modalities: ['text', 'image'] },
          { id: 'text-only', name: 'Text Only', modalities: ['text'] },
        ],
      }],
      default: { provider: 'deepseek', model: 'vision' },
    })
    const sessionId = await openSession(current, '/workspace', { configOptions: true })
    current.agentFor(sessionId).emit('user/message', {
      message: { content: [{ type: 'image', data: 'x' }] },
    })
    await expect(current.client.setSessionConfigOption({
      sessionId, configId: 'model', value: 'deepseek/text-only',
    })).rejects.toMatchObject({ code: -32602 })
    expect(cells[0]?.current?.model).toBe('vision')
  })

  it('rejects a config write for an unknown session', async () => {
    rig = makeRig({ installModelSelection: recordingInstaller([]) })
    const current = rig
    current.ctx.installModels({ default: { provider: 'deepseek', model: 'deepseek-chat' } })
    await openSession(current, '/workspace', { configOptions: true })
    await expect(current.client.setSessionConfigOption({
      sessionId: 'ghost', configId: 'model', value: 'deepseek/deepseek-chat',
    })).rejects.toMatchObject({ code: -32602 })
  })
})
