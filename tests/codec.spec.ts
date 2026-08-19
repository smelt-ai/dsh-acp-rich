import { describe, expect, it } from 'vitest'
import {
  chunkToUpdate,
  messageIdFor,
  promptHasUnsupportedContent,
  splitPrompt,
  toAcpMessageBlocks,
  todosToPlanEntries,
  turnEndToStopReason,
  usageToUpdate,
} from '../src/codec.ts'

describe('turnEndToStopReason', () => {
  it('maps the harness vocabulary onto ACP stop reasons', () => {
    expect(turnEndToStopReason({ kind: 'completed' })).toBe('end_turn')
    expect(turnEndToStopReason({ kind: 'max-tokens' })).toBe('max_tokens')
    expect(turnEndToStopReason({ kind: 'interrupted' })).toBe('cancelled')
  })

  it('reports an unowned abort as ordinary quiescence, not client cancellation', () => {
    // `cancelled` belongs to session/cancel alone; a hook-aborted turn is the
    // agent finishing, and reporting it as cancelled would make a client show
    // an interruption the user never asked for.
    expect(turnEndToStopReason({ kind: 'aborted' })).toBe('end_turn')
    expect(turnEndToStopReason({ kind: 'blocked' })).toBe('end_turn')
    expect(turnEndToStopReason({ kind: 'error' })).toBe('end_turn')
  })

  it('falls through an unknown upstream ending rather than throwing', () => {
    expect(turnEndToStopReason({ kind: 'some-future-reason' })).toBe('end_turn')
  })
})

describe('chunkToUpdate', () => {
  it('routes text deltas to the message channel and reasoning to the thought channel', () => {
    expect(chunkToUpdate({ type: 'text-delta', index: 0, text: 'hi' }, 'm1')).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
      messageId: 'm1',
    })
    expect(chunkToUpdate({ type: 'reasoning-delta', index: 0, text: 'think' }, 'm1')).toEqual({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'think' },
      messageId: 'm1',
    })
  })

  it('drops tool-call deltas, empty text, and unknown chunk types', () => {
    expect(chunkToUpdate(
      { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{"a"' },
      'm1',
    )).toBeUndefined()
    expect(chunkToUpdate({ type: 'text-delta', index: 0, text: '' }, 'm1')).toBeUndefined()
    expect(chunkToUpdate({ type: 'future-delta', text: 'x' }, 'm1')).toBeUndefined()
  })

  it('scopes message ids per session, turn, and step', () => {
    expect(messageIdFor('s', 2, 3)).toBe('s:2:3')
    expect(messageIdFor('s', 2, 3)).not.toBe(messageIdFor('s', 2, 4))
  })
})

describe('todosToPlanEntries', () => {
  it('carries the identical status vocabulary through unchanged', () => {
    expect(todosToPlanEntries([
      { content: 'read', status: 'completed' },
      { content: 'write', status: 'in_progress' },
      { content: 'test', status: 'pending' },
    ])).toEqual([
      { content: 'read', priority: 'medium', status: 'completed' },
      { content: 'write', priority: 'medium', status: 'in_progress' },
      { content: 'test', priority: 'medium', status: 'pending' },
    ])
  })

  it('reports a uniform priority the harness never expressed', () => {
    const [entry] = todosToPlanEntries([{ content: 'x', status: 'pending' }])
    expect(entry?.priority).toBe('medium')
  })
})

describe('usageToUpdate', () => {
  it('sums the disjoint counts into occupied context', () => {
    expect(usageToUpdate(
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 30 },
      64_000,
    )).toEqual({ sessionUpdate: 'usage_update', used: 650, size: 64_000 })
  })

  it('suppresses the gauge when the route advertised no window', () => {
    // A denominator-free gauge would render as a bogus percentage; no update at
    // all leaves the client's previous (correct) reading in place.
    expect(usageToUpdate({ inputTokens: 1, outputTokens: 1 }, undefined)).toBeUndefined()
    expect(usageToUpdate({ inputTokens: 1, outputTokens: 1 }, 0)).toBeUndefined()
  })
})

describe('splitPrompt', () => {
  it('merges adjacent text blocks', () => {
    expect(splitPrompt([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])).toEqual([{ kind: 'text', text: 'ab' }])
  })

  it('renders a resource link as an explicit reference instead of dropping it', () => {
    const [part] = splitPrompt([
      { type: 'resource_link', name: 'main.rs', uri: 'file:///src/main.rs' },
    ])
    expect(part).toMatchObject({ kind: 'text' })
    expect((part as { text: string }).text).toContain('file:///src/main.rs')
    expect((part as { text: string }).text).toContain('main.rs')
  })

  it('inlines an embedded resource\u2019s text under its uri', () => {
    const [part] = splitPrompt([
      { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello', mimeType: 'text/plain' } },
    ])
    expect((part as { text: string }).text).toContain('file:///a.txt')
    expect((part as { text: string }).text).toContain('hello')
  })

  it('keeps images as unresolved parts for the async attachment write', () => {
    expect(splitPrompt([
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ])).toEqual([{ kind: 'image', data: 'AAAA', mediaType: 'image/png' }])
  })
})

describe('promptHasUnsupportedContent', () => {
  it('always refuses audio', () => {
    expect(promptHasUnsupportedContent([{ type: 'audio', data: 'x', mimeType: 'audio/wav' }], true)).toBe(true)
  })

  it('refuses images only when no attachment store is composed', () => {
    const prompt = [{ type: 'image' as const, data: 'x', mimeType: 'image/png' }]
    expect(promptHasUnsupportedContent(prompt, false)).toBe(true)
    expect(promptHasUnsupportedContent(prompt, true)).toBe(false)
  })

  it('accepts the ACP baseline every agent must take', () => {
    expect(promptHasUnsupportedContent([
      { type: 'text', text: 'hi' },
      { type: 'resource_link', name: 'a', uri: 'file:///a' },
    ], false)).toBe(false)
  })
})

describe('toAcpMessageBlocks', () => {
  it('folds reasoning into text and references images by name', () => {
    expect(toAcpMessageBlocks([
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'b' },
      { type: 'image', attachment: { attachmentId: 'x1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'shot.png' } },
      { type: 'tool-call', id: 'c', name: 'n', arguments: '{}' },
    ])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: '[image attachment shot.png]' },
    ])
  })

  it('drops empty text rather than emitting blank bubbles', () => {
    expect(toAcpMessageBlocks([{ type: 'text', text: '' }])).toEqual([])
  })
})
