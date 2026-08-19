import { describe, expect, it } from 'vitest'
import {
  fence,
  mapCallView,
  mapResultView,
  registerCallCard,
  registerResultCard,
  toAcpToolKind,
} from '../src/cards.ts'

const context = { cwd: '/workspace', toolName: 'demo' }

/** The text of a card's single content entry. */
function bodyOf(content: readonly unknown[] | undefined): string {
  const first = content?.[0] as { content?: { text?: string } } | undefined
  return first?.content?.text ?? ''
}

describe('toAcpToolKind', () => {
  it('passes the shared vocabulary through value-for-value', () => {
    for (const kind of ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other']) {
      expect(toAcpToolKind(kind)).toBe(kind)
    }
  })

  it('degrades an unknown category to other instead of shipping it', () => {
    expect(toAcpToolKind('teleport')).toBe('other')
    expect(toAcpToolKind(undefined)).toBeUndefined()
  })
})

describe('fence', () => {
  it('widens the fence past any backtick run in the body', () => {
    expect(fence('ts', 'plain')).toBe('```ts\nplain\n```')
    expect(fence('md', 'a ``` b')).toContain('````')
  })
})

describe('generic call card', () => {
  it('carries title, kind, locations, and raw input', () => {
    const card = mapCallView({
      card: 'generic',
      title: 'Fetch job 7',
      kind: 'fetch',
      rawInput: { job: 7 },
      locations: [{ path: 'a.ts', line: 3 }, { path: 'b.ts' }],
    }, context)
    expect(card).toMatchObject({
      title: 'Fetch job 7',
      kind: 'fetch',
      rawInput: { job: 7 },
      locations: [{ path: 'a.ts', line: 3 }, { path: 'b.ts' }],
    })
  })

  it('falls back to the tool name when a presenter declares no title', () => {
    expect(mapCallView({ card: 'generic' }, context).title).toBe('demo')
  })
})

describe('diff call card', () => {
  it('renames harness diffs onto ACP diff content field-for-field', () => {
    const card = mapCallView({
      card: 'diff',
      title: 'str_replace src/a.ts',
      diffs: [{ path: 'src/a.ts', oldText: 'before', newText: 'after' }],
      locations: [{ path: 'src/a.ts' }],
    }, context)
    expect(card.kind).toBe('edit')
    expect(card.content).toEqual([
      { type: 'diff', path: 'src/a.ts', oldText: 'before', newText: 'after' },
    ])
  })

  it('preserves null oldText as the create/overwrite signal', () => {
    const card = mapCallView({
      card: 'diff',
      title: 'Write new.ts',
      diffs: [{ path: 'new.ts', oldText: null, newText: 'x' }],
    }, context)
    expect(card.content?.[0]).toEqual({ type: 'diff', path: 'new.ts', oldText: null, newText: 'x' })
  })

  it('skips a malformed diff row rather than failing the whole card', () => {
    const card = mapCallView({
      card: 'diff',
      diffs: [{ newText: 'orphan' }, { path: 'ok.ts', oldText: null, newText: 'y' }],
    } as never, context)
    expect(card.content).toHaveLength(1)
  })
})

describe('terminal cards', () => {
  it('resolves a relative cwd against the session workspace', () => {
    const card = mapCallView({
      card: 'terminal', title: 'ls -la', description: 'List files', cwd: 'sub/dir',
    }, context)
    expect(card.kind).toBe('execute')
    expect(card.title).toBe('ls -la')
    expect(bodyOf(card.content)).toContain('/workspace/sub/dir')
    expect(bodyOf(card.content)).toContain('List files')
  })

  it('uses an absolute cwd as given', () => {
    const card = mapCallView({ card: 'terminal', title: 'pwd', cwd: '/elsewhere' }, context)
    expect(bodyOf(card.content)).toContain('/elsewhere')
  })

  it('renders captured output as a console fence with an exit pill', () => {
    const card = mapResultView({ card: 'terminal', output: 'boom', exitCode: 2 }, context)
    expect(bodyOf(card?.content)).toContain('```console\nboom\n```')
    expect(bodyOf(card?.content)).toContain('exit 2')
  })

  it('reports a signal kill instead of an exit code', () => {
    const card = mapResultView({ card: 'terminal', output: 'x', signal: 'SIGTERM' }, context)
    expect(bodyOf(card?.content)).toContain('killed by SIGTERM')
  })

  it('says so explicitly when a command produced nothing', () => {
    const card = mapResultView({ card: 'terminal' }, context)
    expect(bodyOf(card?.content)).toContain('no output')
  })
})

describe('search result card', () => {
  it('groups content matches under their files', () => {
    const card = mapResultView({
      card: 'search',
      shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 12, line: 'let x = 1' }] }],
      truncated: false,
      total: 1,
    }, context)
    expect(bodyOf(card?.content)).toContain('a.ts')
    expect(bodyOf(card?.content)).toContain('12: let x = 1')
  })

  it('flags a capped page so a partial list never reads as complete', () => {
    const card = mapResultView({
      card: 'search', shape: 'paths', paths: ['a.ts'], truncated: true, total: 99,
    }, context)
    expect(bodyOf(card?.content)).toContain('99')
  })
})

describe('read result card', () => {
  it('renders a line-numbered window with its language and totals', () => {
    const card = mapResultView({
      card: 'read',
      path: 'src/a.ts',
      offset: 10,
      lines: [{ number: 10, text: 'const a = 1' }],
      totalLines: 400,
      lang: 'ts',
    }, context)
    const body = bodyOf(card?.content)
    expect(body).toContain('src/a.ts (1 of 400 lines)')
    expect(body).toContain('```ts')
    expect(body).toContain('10\tconst a = 1')
  })
})

describe('web result card', () => {
  it('lists search sources as links', () => {
    const card = mapResultView({
      card: 'web',
      kind: 'search',
      sources: [{ url: 'https://e.com', title: 'E' }],
      answer: 'short answer',
      truncated: false,
    }, context)
    expect(bodyOf(card?.content)).toContain('short answer')
    expect(bodyOf(card?.content)).toContain('[E](https://e.com)')
  })

  it('summarizes a fetch by url and status', () => {
    const card = mapResultView({
      card: 'web', kind: 'fetch', url: 'https://e.com/a', statusCode: 200, truncated: true,
    }, context)
    expect(bodyOf(card?.content)).toContain('https://e.com/a → 200')
    expect(bodyOf(card?.content)).toContain('truncated')
  })
})

describe('registry fallbacks', () => {
  it('gives a tool with no presenter the generic card', () => {
    expect(mapCallView(undefined, context)).toEqual({ title: 'demo', kind: 'other' })
  })

  it('keeps the pending card when a tool declines to present its result', () => {
    // undefined means "render the raw model-facing result", not "empty card".
    expect(mapResultView(undefined, context)).toBeUndefined()
  })

  it('renders an unknown upstream card through the generic mapper', () => {
    const card = mapCallView({ card: 'hologram', title: 'Future', kind: 'read' }, context)
    expect(card).toMatchObject({ title: 'Future', kind: 'read' })
  })
})

describe('registry extension', () => {
  it('lets a deployment teach the bridge a new call card, reversibly', () => {
    const restore = registerCallCard('hologram', view => ({
      title: `holo:${view.title ?? ''}`,
      kind: 'think',
    }))
    expect(mapCallView({ card: 'hologram', title: 'x' }, context))
      .toEqual({ title: 'holo:x', kind: 'think' })
    restore()
    expect(mapCallView({ card: 'hologram', title: 'x' }, context).title).toBe('x')
  })

  it('lets a deployment override a built-in result card and restore it', () => {
    const restore = registerResultCard('terminal', () => ({ title: 'overridden' }))
    expect(mapResultView({ card: 'terminal', output: 'x' }, context)?.title).toBe('overridden')
    restore()
    expect(bodyOf(mapResultView({ card: 'terminal', output: 'x' }, context)?.content)).toContain('x')
  })
})
