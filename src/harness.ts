/**
 * Structural snapshot of the deepseek-harness surfaces this bridge consumes.
 *
 * Why structural rather than `import type` from the harness packages: dsh is a
 * developer preview that promises compatibility-breaking changes, and
 * `SessionEventMap` / `ContentBlockMap` / `ToolCallView` are declaration-merged
 * OPEN vocabularies — an upstream addition never reaches us as a compile error
 * anyway. Restating exactly the fields we read (and nothing else) buys three
 * things a hard dependency does not:
 *
 * 1. the bridge builds and unit-tests without a dsh workspace checkout,
 * 2. an upstream field rename fails in ONE file (here) with a runtime guard,
 *    not in scattered mapping code,
 * 3. every consumer below is forced through {@link isRecord}-style narrowing,
 *    so an unrecognized event shape degrades to "no card" instead of throwing
 *    inside a session-event listener.
 *
 * The single runtime coupling is `createUserMessage` (peer dep), because a
 * user message's identity/freezing contract is the harness's to own.
 *
 * @module @smelt-ai/dsh-acp-rich/harness
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Narrow an unknown to an index-readable object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read a string field, or undefined when absent/mistyped. */
export function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a finite number field, or undefined when absent/mistyped. */
export function readNumber(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read an array field, or undefined when absent/mistyped. */
export function readArray(source: unknown, key: string): unknown[] | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return Array.isArray(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Session log vocabulary (packages/core/session/src/types.ts)
// ---------------------------------------------------------------------------

/** One raw model stream chunk (`assistant/chunk`). */
export type HarnessStreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: string; [key: string]: unknown }

/** Token accounting reported with an assembled assistant message. */
export interface HarnessTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** One entry of the whole-list `todo/write` snapshot. */
export interface HarnessTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Harness-side content block (`ContentBlockMap`, merge-extensible). */
export type HarnessContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: HarnessImageAttachmentRef }
  | { type: string; [key: string]: unknown }

/** Durable image reference minted by the attachment store. */
export interface HarnessImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** Why a turn ended (`TurnEndReasonMap`, merge-extensible). */
export interface HarnessTurnEndReason {
  kind: string
  error?: { message?: string }
  [key: string]: unknown
}

/** One appended session event; `data` is narrowed per `type` by the readers below. */
export interface HarnessSessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/** The live session object carried by `session/event`. */
export interface HarnessSession {
  header: { id: string; [key: string]: unknown }
  events: readonly HarnessSessionEvent[]
}

// ---------------------------------------------------------------------------
// Tool presentation vocabulary (packages/core/tools/src/presentation.ts)
// ---------------------------------------------------------------------------

/** Category a tool declares for its call; the ACP `ToolKind` vocabulary minus `think`/`switch_mode`. */
export type HarnessToolCallKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/** A file a tool reads or modifies, for editor follow-along. */
export interface HarnessFileLocation {
  path: string
  line?: number
}

/** A single-file change; `oldText: null` marks a create/overwrite with no before-image. */
export interface HarnessFileDiff {
  path: string
  oldText: string | null
  newText: string
}

/**
 * A pending-call render intent. Left open (`card: string`) on purpose: a
 * harness plugin may ship a card this bridge has never heard of, and the card
 * registry answers that with its documented generic fallback.
 */
export interface HarnessToolCallView {
  card: string
  title?: string
  kind?: HarnessToolCallKind
  rawInput?: unknown
  content?: HarnessContentBlock[]
  locations?: HarnessFileLocation[]
  diffs?: HarnessFileDiff[]
  description?: string
  cwd?: string
  [key: string]: unknown
}

/** A completed-call render intent (generic | terminal | diff | search | read | web). */
export interface HarnessToolResultView {
  card: string
  title?: string
  content?: HarnessContentBlock[]
  [key: string]: unknown
}

/** The completed outcome handed to `presentResult`. */
export interface HarnessToolResult {
  content: HarnessContentBlock[]
  isError: boolean
  meta?: unknown
}

/** The registry entry `ctx.tools.get()` answers with. */
export interface HarnessToolDefinition {
  name?: string
  presentCall?: (args: unknown) => HarnessToolCallView | undefined
  presentResult?: (args: unknown, result: HarnessToolResult) => HarnessToolResultView | undefined
}

// ---------------------------------------------------------------------------
// Services (read structurally through `ctx.get(...)`, so an absent service is
// a capability we simply do not advertise rather than a boot failure)
// ---------------------------------------------------------------------------

/** A live harness agent. */
export interface HarnessAgent {
  id: string
  session: HarnessSession
  ctx?: unknown
  followup: (message: unknown) => void
  cancel: (reason: { kind: string }) => void
  whenIdle: () => Promise<unknown>
}

/** An owned agent plus its capability-scoped disposer. */
export interface HarnessAgentHandle {
  agent: HarnessAgent
  dispose: () => Promise<void>
}

/** `ctx.agents` — the only service this bridge hard-requires. */
/**
 * The unpublished per-agent cordis scope handed to `CreateAgentOptions.setup`.
 *
 * Only `plugin` is restated: everything the bridge does at this seam is mount
 * per-agent plugins, and disposal is the registry's job, not ours.
 */
export interface HarnessAgentContext {
  plugin: (plugin: unknown, config?: unknown) => unknown
  /**
   * Scoped event/waterfall registration.
   *
   * Only needed because `installModelSelection` writes through it; listeners
   * registered here die with the agent, which is why neither it nor this
   * bridge tracks the disposer.
   */
  on?: (event: string, listener: (...args: never[]) => unknown) => unknown
}

/**
 * Compose an unpublished agent scope before it is announced.
 *
 * The registry awaits this before the loop starts, which is the only window in
 * which a tool registration is guaranteed visible to the agent's first prompt.
 */
export type HarnessAgentSetup = (agentCtx: HarnessAgentContext) => void | Promise<void>

export interface HarnessAgentRegistry {
  create: (options: {
    sessionId: string
    meta?: { cwd?: string }
    agentOptions?: Record<string, unknown>
    setup?: HarnessAgentSetup
  }) => Promise<HarnessAgentHandle>
  resume?: (options: {
    resumeSessionId: string
    agentOptions?: Record<string, unknown>
    setup?: HarnessAgentSetup
  }) => Promise<HarnessAgentHandle>
  get: (id: string) => HarnessAgent | undefined
}

/** `ctx.tools` — presenters. Absent registry means every card falls back to generic. */
export interface HarnessToolRegistry {
  get: (name: string, scope?: unknown) => HarnessToolDefinition | undefined
}

/** `ctx.commands` — slash-command discovery. */
export interface HarnessCommandRegistry {
  list: (agent: HarnessAgent) => readonly { name: string; description: string; input?: { hint: string } }[]
}

/** `ctx.attachments` — durable image storage, the gate on `promptCapabilities.image`. */
export interface HarnessAttachmentStore {
  saveImage: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<HarnessImageAttachmentRef>
  imageLimits?: { mediaTypes?: readonly string[] }
}

/** `ctx.approval` request put to the answerer waterfall. */
export interface HarnessApprovalRequest {
  agent: HarnessAgent
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

/** The closed outcome vocabulary; `allowed-once` is the harness's only grant. */
export type HarnessApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The one continuable-subagent teardown hook the bridge needs, read structurally. */
export interface HarnessContinuableDrain {
  drainContinuableDescendants: (parents: readonly HarnessAgent[]) => Promise<void>
}

// ---------------------------------------------------------------------------
// Typed readers for the exact events the bridge subscribes to. Each returns
// undefined when the payload does not match, so a renamed/reshaped upstream
// event silently stops producing cards instead of throwing mid-turn.
// ---------------------------------------------------------------------------

/** `assistant/chunk` — raw stream delta with its turn/step coordinates. */
export function readAssistantChunk(
  event: HarnessSessionEvent,
): { turn: number; step: number; chunk: HarnessStreamChunk } | undefined {
  const { data } = event
  if (!isRecord(data) || !isRecord(data['chunk'])) return undefined
  const chunk = data['chunk'] as HarnessStreamChunk
  if (typeof chunk.type !== 'string') return undefined
  return { turn: readNumber(data, 'turn') ?? 0, step: readNumber(data, 'step') ?? 0, chunk }
}

/** `assistant/message` — assembled message plus optional token accounting. */
export function readAssistantMessage(
  event: HarnessSessionEvent,
): { turn: number; step: number; content: HarnessContentBlock[]; usage?: HarnessTokenUsage } | undefined {
  const { data } = event
  if (!isRecord(data)) return undefined
  const content = readArray(data['message'], 'content') as HarnessContentBlock[] | undefined
  if (content === undefined) return undefined
  const usage = isRecord(data['usage']) ? data['usage'] as unknown as HarnessTokenUsage : undefined
  return {
    turn: readNumber(data, 'turn') ?? 0,
    step: readNumber(data, 'step') ?? 0,
    content,
    ...usage === undefined ? {} : { usage },
  }
}

/** `user/message` — the model-visible user-role message (human prompt or injected context). */
export function readUserMessage(
  event: HarnessSessionEvent,
): { content: HarnessContentBlock[]; sourceKind: string | undefined } | undefined {
  const content = readArray(event.data, 'content') as HarnessContentBlock[] | undefined
  if (content === undefined) return undefined
  const source = isRecord(event.data) ? event.data['source'] : undefined
  return { content, sourceKind: readString(source, 'kind') }
}

/** `tool/call` — the model's requested invocation with its unparsed argument JSON. */
export function readToolCall(
  event: HarnessSessionEvent,
): { callId: string; name: string; rawArguments: string } | undefined {
  const callId = readString(event.data, 'callId')
  const name = readString(event.data, 'name')
  const rawArguments = readString(event.data, 'arguments')
  if (callId === undefined || name === undefined) return undefined
  return { callId, name, rawArguments: rawArguments ?? '{}' }
}

/** `tool/result` — the completed call's model-facing result and failure identity. */
export function readToolResult(
  event: HarnessSessionEvent,
): { callId: string; content: HarnessContentBlock[]; isError: boolean; meta?: unknown } | undefined {
  const { data } = event
  if (!isRecord(data) || !isRecord(data['message'])) return undefined
  const message = data['message']
  const callId = readString(message['source'], 'callId')
  if (callId === undefined) return undefined
  // The tool-result message carries exactly one tool-result block whose own
  // `content` holds the blocks; fall back to the message content when a future
  // shape flattens it.
  const outer = readArray(message, 'content') ?? []
  const first = outer[0]
  const inner = readArray(first, 'content') as HarnessContentBlock[] | undefined
  const isError = isRecord(first) && first['isError'] === true
  return {
    callId,
    content: inner ?? outer as HarnessContentBlock[],
    isError: isError || isRecord(data['error']),
    ...'meta' in data ? { meta: data['meta'] } : {},
  }
}

/** `todo/write` — the whole-list plan snapshot (last write wins). */
export function readTodoWrite(event: HarnessSessionEvent): HarnessTodoItem[] | undefined {
  const todos = readArray(event.data, 'todos')
  if (todos === undefined) return undefined
  return todos.flatMap((item): HarnessTodoItem[] => {
    const content = readString(item, 'content')
    const status = readString(item, 'status')
    if (content === undefined) return []
    return [{
      content,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
    }]
  })
}

/**
 * `request/context` — registration-bound metadata for one resolved route.
 *
 * Carries the route the request actually took, which is the only place a
 * session reveals its provider/model without the bridge having chosen them.
 */
export function readRequestContext(
  event: HarnessSessionEvent,
): { contextWindow?: number; provider?: string; model?: string } | undefined {
  if (!isRecord(event.data)) return undefined
  const contextWindow = readNumber(event.data, 'contextWindow')
  const provider = readString(event.data, 'provider')
  const model = readString(event.data, 'model')
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...provider === undefined || model === undefined ? {} : { provider, model },
  }
}

/** `turn/end` — the turn number and why it ended. */
export function readTurnEnd(
  event: HarnessSessionEvent,
): { turn: number; reason: HarnessTurnEndReason } | undefined {
  const turn = readNumber(event.data, 'turn')
  if (turn === undefined) return undefined
  const raw = isRecord(event.data) ? event.data['reason'] : undefined
  const kind = readString(raw, 'kind') ?? 'completed'
  return { turn, reason: { ...isRecord(raw) ? raw : {}, kind } }
}
