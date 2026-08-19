/**
 * Card registry: harness render intents → ACP tool-call presentation.
 *
 * A registry rather than a `switch` because both vocabularies are open. dsh's
 * `ToolCallView`/`ToolResultView` are plugin-extensible (a harness plugin can
 * ship a card this bridge has never seen) and ACP grows variants on its own
 * clock. Registration keeps "teach the bridge a new card" a one-call change in
 * the deployment that owns the new card, instead of a patch to this file and a
 * release of this package.
 *
 * Every mapper is pure: view in, ACP fields out. No I/O, no clock, no session
 * state — which is what makes the whole presentation layer unit-testable
 * without a harness runtime.
 *
 * @module @smelt-ai/dsh-acp-rich/cards
 */

import type { ContentBlock, ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import {
  isRecord,
  readArray,
  readNumber,
  readString,
  type HarnessContentBlock,
  type HarnessToolCallView,
  type HarnessToolResultView,
} from './harness.ts'

/** ACP fields a call-card mapper produces for `session/update: tool_call`. */
export interface AcpCallCard {
  title?: string
  kind?: ToolKind
  content?: ToolCallContent[]
  locations?: ToolCallLocation[]
  rawInput?: unknown
}

/** ACP fields a result-card mapper produces for `session/update: tool_call_update`. */
export interface AcpResultCard {
  title?: string
  content?: ToolCallContent[]
}

/** Ambient facts a mapper may need that are not on the view itself. */
export interface CardContext {
  /** Session workspace, used to resolve a terminal card's relative `cwd`. */
  cwd: string
  /** The harness tool name, the fallback title source. */
  toolName: string
}

/** Maps one harness call view to ACP call fields. */
export type CallCardMapper = (view: HarnessToolCallView, context: CardContext) => AcpCallCard
/** Maps one harness result view to ACP update fields. */
export type ResultCardMapper = (view: HarnessToolResultView, context: CardContext) => AcpResultCard

/** Every ACP tool kind, for validating a harness-declared category. */
const ACP_TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind>([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
])

/**
 * Translate a harness `ToolCallKind` to an ACP `ToolKind`. The two vocabularies
 * were designed against each other and overlap value-for-value, so this is a
 * validated passthrough; an unknown value degrades to `other` rather than
 * shipping a string the client cannot render.
 * @param kind - harness-declared category, when the tool declared one.
 * @returns the ACP kind, or undefined so the client applies its own default.
 */
export function toAcpToolKind(kind: string | undefined): ToolKind | undefined {
  if (kind === undefined) return undefined
  return ACP_TOOL_KINDS.has(kind) ? kind as ToolKind : 'other'
}

/** Wrap text in a fenced block, guarding against a body that already fences. */
export function fence(lang: string, body: string): string {
  const ticks = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1))
  return `${ticks}${lang}\n${body.endsWith('\n') ? body : `${body}\n`}${ticks}`
}

function longestBacktickRun(text: string): number {
  let longest = 0
  let run = 0
  for (const char of text) {
    run = char === '`' ? run + 1 : 0
    if (run > longest) longest = run
  }
  return longest
}

/** An ACP text content entry. */
export function textContent(text: string): ToolCallContent {
  return { type: 'content', content: { type: 'text', text } }
}

/**
 * Project harness content blocks onto ACP content blocks. `reasoning` folds
 * into text (a tool card has no thought channel) and an `image` block becomes a
 * textual reference: the bytes live behind the attachment store and a presenter
 * carries only the durable reference, so inlining them would need an async read
 * this pure layer must not do.
 * @param blocks - harness blocks from a view or a raw result.
 * @returns the ACP blocks, dropping anything with no textual projection.
 */
export function toAcpContentBlocks(blocks: readonly HarnessContentBlock[] | undefined): ContentBlock[] {
  if (blocks === undefined) return []
  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type === 'text' || block.type === 'reasoning') {
      const text = readString(block, 'text')
      return text === undefined || text.length === 0 ? [] : [{ type: 'text', text }]
    }
    if (block.type === 'image') {
      const name = readString(block['attachment'], 'name')
        ?? readString(block['attachment'], 'attachmentId')
        ?? 'image'
      return [{ type: 'text', text: `[image attachment ${name}]` }]
    }
    return []
  })
}

/** Project harness blocks straight into ACP tool-call content entries. */
export function toAcpToolContent(blocks: readonly HarnessContentBlock[] | undefined): ToolCallContent[] {
  return toAcpContentBlocks(blocks).map(content => ({ type: 'content', content }))
}

/** Project the harness file locations a UI follows along with. */
export function toAcpLocations(view: HarnessToolCallView): ToolCallLocation[] | undefined {
  const locations = view.locations
  if (locations === undefined || locations.length === 0) return undefined
  return locations.flatMap((location): ToolCallLocation[] => {
    const path = readString(location, 'path')
    if (path === undefined) return []
    const line = readNumber(location, 'line')
    return [{ path, ...line === undefined ? {} : { line } }]
  })
}

/**
 * Project harness file diffs onto ACP diff content. The two shapes are
 * field-for-field identical (`path` / `oldText` / `newText`, with `null`
 * meaning "no before-image"), which is what makes inline diffs a rename rather
 * than a rendering.
 * @param diffs - harness diff entries from a call or result view.
 * @returns ACP diff content entries, skipping malformed rows.
 */
export function toAcpDiffs(diffs: unknown): ToolCallContent[] {
  if (!Array.isArray(diffs)) return []
  return diffs.flatMap((diff): ToolCallContent[] => {
    const path = readString(diff, 'path')
    if (path === undefined) return []
    const newText = readString(diff, 'newText') ?? ''
    const oldText = isRecord(diff) && typeof diff['oldText'] === 'string' ? diff['oldText'] : null
    return [{ type: 'diff', path, oldText, newText }]
  })
}

// ---------------------------------------------------------------------------
// Built-in call cards
// ---------------------------------------------------------------------------

const genericCall: CallCardMapper = (view, context) => ({
  title: view.title ?? context.toolName,
  ...toAcpToolKind(view.kind) === undefined ? {} : { kind: toAcpToolKind(view.kind) as ToolKind },
  ...view.content === undefined ? {} : { content: toAcpToolContent(view.content) },
  ...toAcpLocations(view) === undefined ? {} : { locations: toAcpLocations(view) as ToolCallLocation[] },
  ...'rawInput' in view && view.rawInput !== undefined ? { rawInput: view.rawInput } : {},
})

/**
 * A shell command. ACP's `terminal` content variant addresses a terminal the
 * CLIENT created through `terminal/create`; a bridge cannot mint a
 * `terminalId` for a command the harness already owns and runs itself. So the
 * pending card carries the command as its title (plus the resolved cwd and the
 * presenter's one-line description as a header), and the completed card carries
 * the captured output as a ```console block — exactly the fallback dsh's own
 * presentation contract documents for a client without the terminal capability.
 */
const terminalCall: CallCardMapper = (view, context) => {
  const command = view.title ?? context.toolName
  const cwd = resolveCwd(view.cwd, context.cwd)
  const header = [view.description, `$ ${command}`, `(in ${cwd})`]
    .filter((line): line is string => typeof line === 'string' && line.length > 0)
    .join('\n')
  return {
    title: command,
    kind: 'execute',
    content: [textContent(header)],
  }
}

/** Resolve a presenter's optional cwd against the session workspace. */
function resolveCwd(declared: string | undefined, sessionCwd: string): string {
  if (declared === undefined || declared.length === 0) return sessionCwd
  if (declared.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(declared)) return declared
  return `${sessionCwd.replace(/[\\/]+$/u, '')}/${declared}`
}

const diffCall: CallCardMapper = (view, context) => ({
  title: view.title ?? context.toolName,
  kind: toAcpToolKind(view.kind) ?? 'edit',
  content: toAcpDiffs(view.diffs),
  ...toAcpLocations(view) === undefined ? {} : { locations: toAcpLocations(view) as ToolCallLocation[] },
})

// ---------------------------------------------------------------------------
// Built-in result cards
// ---------------------------------------------------------------------------

const genericResult: ResultCardMapper = view => ({
  ...view.title === undefined ? {} : { title: view.title },
  ...view.content === undefined ? {} : { content: toAcpToolContent(view.content) },
})

const terminalResult: ResultCardMapper = (view) => {
  const output = readString(view, 'output') ?? ''
  const exitCode = readNumber(view, 'exitCode')
  const signal = readString(view, 'signal')
  const status = signal !== undefined
    ? `killed by ${signal}`
    : exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : undefined
  const body = output.length > 0 ? fence('console', output) : '_(no output)_'
  return {
    ...view.title === undefined ? {} : { title: view.title },
    content: [textContent(status === undefined ? body : `${body}\n${status}`)],
  }
}

const diffResult: ResultCardMapper = view => ({
  ...view.title === undefined ? {} : { title: view.title },
  content: toAcpDiffs(view['diffs']),
})

const searchResult: ResultCardMapper = (view) => {
  const truncated = view['truncated'] === true
  const total = readNumber(view, 'total')
  const lines: string[] = []
  if (readString(view, 'shape') === 'paths') {
    for (const path of readArray(view, 'paths') ?? []) {
      if (typeof path === 'string') lines.push(path)
    }
  } else {
    for (const file of readArray(view, 'files') ?? []) {
      const path = readString(file, 'path')
      if (path === undefined) continue
      lines.push(path)
      for (const match of readArray(file, 'matches') ?? []) {
        const lineNumber = readNumber(match, 'lineNumber')
        const line = readString(match, 'line') ?? ''
        lines.push(`  ${lineNumber ?? '?'}: ${line}`)
      }
    }
  }
  const body = lines.length > 0 ? lines.join('\n') : '_(no matches)_'
  const footer = truncated && total !== undefined ? `\n_(showing a capped page of ${total})_` : ''
  return {
    ...view.title === undefined ? {} : { title: view.title },
    content: [textContent(`${body}${footer}`)],
  }
}

const readResult: ResultCardMapper = (view) => {
  const path = readString(view, 'path') ?? ''
  const lang = readString(view, 'lang') ?? ''
  const totalLines = readNumber(view, 'totalLines')
  const rows = (readArray(view, 'lines') ?? []).flatMap((row): string[] => {
    const text = readString(row, 'text')
    if (text === undefined) return []
    const number = readNumber(row, 'number')
    return [`${number === undefined ? '' : `${number}\t`}${text}`]
  })
  const header = totalLines === undefined
    ? path
    : `${path} (${rows.length} of ${totalLines} lines)`
  const body = rows.length > 0 ? fence(lang, rows.join('\n')) : '_(empty window)_'
  return {
    ...view.title === undefined ? {} : { title: view.title },
    content: [textContent(`${header}\n${body}`)],
  }
}

const webResult: ResultCardMapper = (view) => {
  if (readString(view, 'kind') === 'fetch') {
    const url = readString(view, 'url') ?? ''
    const status = readNumber(view, 'statusCode')
    const truncated = view['truncated'] === true ? ' (truncated)' : ''
    return {
      ...view.title === undefined ? {} : { title: view.title },
      content: [textContent(`${url} → ${status ?? '?'}${truncated}`)],
    }
  }
  const lines = (readArray(view, 'sources') ?? []).flatMap((source): string[] => {
    const url = readString(source, 'url')
    if (url === undefined) return []
    const title = readString(source, 'title')
    return [title === undefined ? `- ${url}` : `- [${title}](${url})`]
  })
  const answer = readString(view, 'answer')
  const body = [answer, lines.join('\n')]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n\n')
  return {
    ...view.title === undefined ? {} : { title: view.title },
    content: [textContent(body.length > 0 ? body : '_(no sources)_')],
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const callCards = new Map<string, CallCardMapper>([
  ['generic', genericCall],
  ['terminal', terminalCall],
  ['diff', diffCall],
])

const resultCards = new Map<string, ResultCardMapper>([
  ['generic', genericResult],
  ['terminal', terminalResult],
  ['diff', diffResult],
  ['search', searchResult],
  ['read', readResult],
  ['web', webResult],
])

/**
 * Teach the bridge a pending-call card a harness plugin ships.
 * @param card - the view's `card` discriminant.
 * @param mapper - pure mapper to ACP call fields.
 * @returns a disposer restoring the previous registration.
 */
export function registerCallCard(card: string, mapper: CallCardMapper): () => void {
  const previous = callCards.get(card)
  callCards.set(card, mapper)
  return () => {
    if (previous === undefined) callCards.delete(card)
    else callCards.set(card, previous)
  }
}

/**
 * Teach the bridge a completed-call card a harness plugin ships.
 * @param card - the view's `card` discriminant.
 * @param mapper - pure mapper to ACP update fields.
 * @returns a disposer restoring the previous registration.
 */
export function registerResultCard(card: string, mapper: ResultCardMapper): () => void {
  const previous = resultCards.get(card)
  resultCards.set(card, mapper)
  return () => {
    if (previous === undefined) resultCards.delete(card)
    else resultCards.set(card, previous)
  }
}

/**
 * Map a pending call view through the registry.
 * @param view - the harness view, or undefined when the tool declares no presenter.
 * @param context - workspace and tool identity for fallbacks.
 * @returns ACP call fields; an unregistered card falls back to the generic mapper.
 */
export function mapCallView(
  view: HarnessToolCallView | undefined,
  context: CardContext,
): AcpCallCard {
  if (view === undefined || typeof view.card !== 'string') {
    return { title: context.toolName, kind: 'other' }
  }
  return (callCards.get(view.card) ?? genericCall)(view, context)
}

/**
 * Map a completed call view through the registry.
 * @param view - the harness view, or undefined when the tool declares no presenter.
 * @param context - workspace and tool identity for fallbacks.
 * @returns ACP update fields; undefined means "keep the pending card, render raw result".
 */
export function mapResultView(
  view: HarnessToolResultView | undefined,
  context: CardContext,
): AcpResultCard | undefined {
  if (view === undefined || typeof view.card !== 'string') return undefined
  return (resultCards.get(view.card) ?? genericResult)(view, context)
}
