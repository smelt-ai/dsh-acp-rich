/**
 * Presentation-complete Agent Client Protocol server for deepseek-harness.
 *
 * The shipped `@deepseek-ai/dsh-acp` is automation-only by design: it
 * subscribes to `session/event` and forwards committed assistant text alone,
 * because "interactive rendering and human questions belong to the Web host and
 * client modules". Every richer signal an editor renders — token deltas,
 * reasoning, tool cards, inline diffs, plans, usage, commands — is already on
 * that same event stream; the automation bridge simply declines to carry it.
 *
 * This bridge carries it. It is a strict superset of the automation server:
 * same skeleton (`AgentSideConnection` over `ndJsonStream`, `ctx.effect`
 * teardown, one-shot permission questions, cancel), plus the presentation and
 * session-lifecycle surface an ACP editor advertises.
 *
 * Three deliberate departures from the automation server:
 *
 * - **Standing permissions.** The harness has one grant (`'allowed-once'`).
 *   ACP clients offer "always allow". {@link GrantStore} bridges the gap in
 *   session-scoped memory rather than pretending the harness has a policy.
 * - **Presentation is a registry, not a switch.** Harness cards and ACP
 *   variants are both open vocabularies; see `./cards.ts`.
 * - **The harness is read structurally.** dsh is a developer preview with
 *   declaration-merged event and content vocabularies; see `./harness.ts`.
 *
 * @module @smelt-ai/dsh-acp-rich
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type StopReason,
  type Stream,
  type ToolCallContent,
  type ToolCallStatus,
} from '@agentclientprotocol/sdk'
import { mapCallView, mapResultView, toAcpToolContent, type CardContext } from './cards.ts'
import {
  chunkToUpdate,
  messageIdFor,
  promptHasUnsupportedContent,
  splitPrompt,
  toAcpMessageBlocks,
  todosToPlanEntries,
  turnEndToStopReason,
  usageToUpdate,
  type PromptPart,
} from './codec.ts'
import {
  applySessionConfigOption,
  ConfigRejected,
  defaultSelectionInstaller,
  listSessionConfigOptions,
  type HarnessLlmService,
  type HarnessModelSelection,
  type HarnessModelSelectionRef,
  type SelectionInstaller,
  type SessionConfigScope,
} from './config.ts'
import { GrantStore, interpretPermission, PERMISSION_OPTIONS } from './grants.ts'
import { createRuntimeGate, type LoaderLike } from './readiness.ts'
import {
  defaultMcpMounter,
  mapMcpServers,
  type AcpMcpServer,
  type McpMounter,
} from './mcp.ts'
import {
  readAssistantChunk,
  readAssistantMessage,
  readRequestContext,
  readToolCall,
  readToolResult,
  readTodoWrite,
  readTurnEnd,
  readUserMessage,
  type HarnessAgent,
  type HarnessAgentHandle,
  type HarnessAgentRegistry,
  type HarnessAgentSetup,
  type HarnessApprovalOutcome,
  type HarnessApprovalRequest,
  type HarnessAttachmentStore,
  type HarnessCommandRegistry,
  type HarnessContentBlock,
  type HarnessContinuableDrain,
  type HarnessSession,
  type HarnessSessionEvent,
  type HarnessToolRegistry,
  type HarnessTurnEndReason,
} from './harness.ts'

export { GrantStore, PERMISSION_OPTIONS, interpretPermission } from './grants.ts'
export {
  registerCallCard,
  registerResultCard,
  type CallCardMapper,
  type ResultCardMapper,
} from './cards.ts'
export * from './codec.ts'
export {
  registerSessionConfig,
  EFFORT_CONFIG_ID,
  EFFORT_DEFAULT_VALUE,
  MODEL_CONFIG_ID,
  type SessionConfigProvider,
} from './config.ts'

/** Cordis service name of this plugin. */
export const name = 'acp-rich'

/**
 * `agents` is the only hard requirement: it creates and owns every session.
 *
 * MUST stay a flat array. This loader's `Inject.resolve` accepts an array or a
 * `name -> intercept config` map and nothing else, so the `{ required, optional }`
 * form that other cordis versions accept is read here as two services literally
 * named `required` and `optional` — the entry then waits forever for them and
 * boot fails with `1 entry did not activate`, long after every unit test has
 * passed. There is no "optional" tier to declare against: every other service
 * this bridge uses (`tools`, `commands`, `attachments`, `llm`,
 * `agentDefaultModel`, `sessionPersistence`, `subagents`) is read lazily through
 * `ctx.get`, which is also what keeps a service appearing or disappearing from
 * reloading the plugin and tearing down every live ACP session mid-turn.
 */
export const inject = ['agents']

/** A minimally-typed cordis context: this bridge programs against services, not internals. */
interface BridgeContext {
  agents: HarnessAgentRegistry
  logger: { warn: (message: string) => void; error?: (message: string) => void }
  get: (name: string) => unknown
  on: (event: string, listener: (...args: never[]) => unknown) => unknown
  effect: (setup: () => (() => unknown) | Promise<() => unknown>, label?: string) => unknown
}

interface HarnessSessionHeader {
  id: string
  createdAt: number
  cwd?: string
}

interface HarnessSessionPersistence {
  list: (signal?: AbortSignal) => Promise<HarnessSessionHeader[]>
}

/** Harness user-message factory; see {@link AcpRichConfig.createUserMessage}. */
export type UserMessageFactory = (input: {
  content: HarnessContentBlock[]
  source: { kind: string }
}) => unknown

/** Plugin configuration. */
export interface AcpRichConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /**
   * Override the harness user-message factory.
   *
   * The default reproduces `@deepseek-ai/dsh-llm`'s `createUserMessage`
   * contract (fresh `id`, `role: 'user'`, frozen) without importing it, so this
   * package builds and unit-tests with no harness workspace. A deployment that
   * wants the harness's own factory — and its future invariants — passes it
   * here rather than patching this file.
   */
  createUserMessage?: UserMessageFactory
  /**
   * Override how MCP servers from a session request are mounted.
   *
   * The default loads `@deepseek-ai/dsh-mcp-client` dynamically. A deployment
   * that bundles its own MCP bridge, or one that must deny client-supplied
   * servers outright, replaces this rather than patching the bridge.
   */
  mountMcpServers?: McpMounter
  /**
   * Override how a session's model selection is coupled to its agent.
   *
   * The default loads `@deepseek-ai/dsh-agent` dynamically. Supplying one is
   * how a deployment with its own routing seam keeps the model picker working;
   * returning false from it turns the picker off rather than making it lie.
   */
  installModelSelection?: SelectionInstaller
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

/** Default user-message factory mirroring the harness contract. */
const defaultCreateUserMessage: UserMessageFactory = input => Object.freeze({
  id: randomUUID(),
  role: 'user' as const,
  content: input.content,
  source: input.source,
})

/** Per-session bridge state. */
interface SessionRecord {
  readonly sessionId: string
  agent: HarnessAgent
  dispose: () => Promise<void>
  readonly cwd: string
  /** Latest advertised context window for the active route; the usage gauge's denominator. */
  contextWindow: number | undefined
  /** Parsed `tool/call` arguments, keyed by call id, so a result can reach its presenter. */
  readonly calls: Map<string, { name: string; args: unknown }>
  /** Steps that already streamed at least one text delta, so a commit does not double-render. */
  readonly streamedSteps: Set<string>
  /** True while replaying persisted history for `session/load`. */
  replaying: boolean
  /**
   * The session's live model selection, present only when the coupling into
   * the agent actually installed. Absent means the model selector is not
   * published: this bridge would have no way to make a switch take effect.
   */
  selection: HarnessModelSelectionRef | undefined
  inflight: InflightPrompt | undefined
}

/** One in-flight `session/prompt` awaiting whole-agent quiescence. */
interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string
  turn: number | undefined
  endReason: HarnessTurnEndReason | undefined
}

/** Preserve invalid-parameter detail on the wire. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failure detail on the wire. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * Mount the presentation-complete ACP server.
 * @param ctx - cordis context carrying the agent factory and session events.
 * @param config - provider/model selection and optional test transport.
 */
export function apply(ctx: BridgeContext, config: AcpRichConfig = {}): void {
  // ACP handlers run outside this plugin's injection scope, so capture the
  // injected services now rather than reading them lazily in a callback.
  const agents = ctx.agents
  const logger = ctx.logger
  const createUserMessage = config.createUserMessage ?? defaultCreateUserMessage
  const sessions = new Map<string, SessionRecord>()
  const grants = new GrantStore()
  let closed = false
  let clientWantsConfigOptions = false
  let conn: AgentSideConnection

  const tools = (): HarnessToolRegistry | undefined => ctx.get('tools') as HarnessToolRegistry | undefined
  const commands = (): HarnessCommandRegistry | undefined => ctx.get('commands') as HarnessCommandRegistry | undefined
  const attachments = (): HarnessAttachmentStore | undefined => ctx.get('attachments') as HarnessAttachmentStore | undefined

  /**
   * Serve nothing from a half-composed runtime.
   *
   * This plugin's `apply` runs mid-boot and binds stdio at once, so a client
   * already waiting on the pipe can be answered before the settings-backed
   * plugins have registered their sections. A session opened in that window
   * snapshots a model catalog holding only composition defaults, which is how a
   * user-declared provider route ends up permanently missing from its picker.
   */
  const awaitRuntime = createRuntimeGate(
    () => ctx.get('loader') as LoaderLike | undefined,
    {
      onTimeout: unsettled => {
        logger.warn(
          `acp-rich: serving requests before the runtime settled; still activating: ${unsettled.join(', ')}`,
        )
      },
    },
  )

  /**
   * Whether this deployment can actually serve `session/load`.
   *
   * BOTH conditions matter. `agents.resume` is a registry method that exists
   * whenever the loop is composed, but it loads the persisted log through
   * `sessionPersistence` — a profile that composes no persistence provider has
   * the method and no history to give it. Advertising `loadSession` on the
   * method alone would turn "this deployment keeps no transcripts" into a
   * mid-restore internal error, where smelt can only report a broken agent.
   * Reported honestly, smelt classifies it as `UnsupportedLoad` and opens a
   * fresh session instead.
   */
  const canLoadSession = (): boolean =>
    typeof agents.resume === 'function' && ctx.get('sessionPersistence') !== undefined

  const persistence = (): HarnessSessionPersistence | undefined => {
    const service = ctx.get('sessionPersistence') as Partial<HarnessSessionPersistence> | undefined
    return typeof service?.list === 'function' ? service as HarnessSessionPersistence : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: string): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** The bridge-owned record for an agent, rejecting a same-id impostor. */
  const ownedRecord = (agent: HarnessAgent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.header.id)
    return record?.agent === agent ? record : undefined
  }

  /** Send one update without letting a disconnected client fail an agent turn. */
  const notify = (sessionId: string, update: SessionUpdate): void => {
    const notification: SessionNotification = { sessionId, update }
    void conn.sessionUpdate(notification).catch((error: unknown) => {
      logger.warn(`acp-rich: session/update failed: ${String(error)}`)
    })
  }

  const cardContext = (record: SessionRecord, toolName: string): CardContext => ({
    cwd: record.cwd,
    toolName,
  })

  // -------------------------------------------------------------------------
  // Session-event projection
  //
  // A dispatch table rather than an if-chain: each entry owns exactly one
  // harness event type, so adding an event the harness grows later is one row,
  // and an event nobody claims is silently ignored (which is the correct
  // behaviour for an open, declaration-merged vocabulary).
  // -------------------------------------------------------------------------

  type EventProjector = (record: SessionRecord, event: HarnessSessionEvent) => void

  const projectAssistantChunk: EventProjector = (record, event) => {
    const parsed = readAssistantChunk(event)
    if (parsed === undefined) return
    const messageId = messageIdFor(record.sessionId, parsed.turn, parsed.step)
    if (parsed.chunk.type === 'text-delta') record.streamedSteps.add(messageId)
    const update = chunkToUpdate(parsed.chunk, messageId)
    if (update !== undefined) notify(record.sessionId, update)
  }

  const projectAssistantMessage: EventProjector = (record, event) => {
    const parsed = readAssistantMessage(event)
    if (parsed === undefined) return
    const messageId = messageIdFor(record.sessionId, parsed.turn, parsed.step)
    // Normally the deltas already rendered this text and the commit adds only
    // accounting. A non-streaming adapter (or a replayed log whose chunks were
    // pruned) produces no deltas at all, and dropping the commit too would lose
    // the answer entirely — so the commit renders exactly when nothing streamed.
    if (!record.streamedSteps.has(messageId)) {
      for (const block of toAcpMessageBlocks(parsed.content)) {
        notify(record.sessionId, { sessionUpdate: 'agent_message_chunk', content: block, messageId })
      }
    }
    record.streamedSteps.delete(messageId)
    if (parsed.usage !== undefined) {
      const update = usageToUpdate(parsed.usage, record.contextWindow)
      if (update !== undefined) notify(record.sessionId, update)
    }
  }

  const projectUserMessage: EventProjector = (record, event) => {
    // Live user messages are the prompt this bridge just delivered (the client
    // already rendered it) or a synthetic context injection the harness makes
    // on the model's behalf; echoing either would duplicate or clutter the
    // transcript. Replay is the case the client genuinely has nothing for.
    if (!record.replaying) return
    const parsed = readUserMessage(event)
    if (parsed === undefined) return
    for (const block of toAcpMessageBlocks(parsed.content)) {
      notify(record.sessionId, { sessionUpdate: 'user_message_chunk', content: block })
    }
  }

  const projectToolCall: EventProjector = (record, event) => {
    const parsed = readToolCall(event)
    if (parsed === undefined) return
    let args: unknown
    try {
      args = JSON.parse(parsed.rawArguments)
    } catch {
      // The model produced unparseable arguments. The call still happened and
      // must still appear; it just gets the generic card.
      args = undefined
    }
    record.calls.set(parsed.callId, { name: parsed.name, args })
    const view = safePresent(() => tools()?.get(parsed.name, record.agent)?.presentCall?.(args), parsed.name, 'presentCall')
    const card = mapCallView(view, cardContext(record, parsed.name))
    notify(record.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: parsed.callId,
      title: card.title ?? parsed.name,
      name: parsed.name,
      status: 'pending' satisfies ToolCallStatus,
      ...card.kind === undefined ? {} : { kind: card.kind },
      ...card.content === undefined ? {} : { content: card.content },
      ...card.locations === undefined ? {} : { locations: card.locations },
      ...card.rawInput === undefined ? { rawInput: args } : { rawInput: card.rawInput },
    })
  }

  const projectToolResult: EventProjector = (record, event) => {
    const parsed = readToolResult(event)
    if (parsed === undefined) return
    const call = record.calls.get(parsed.callId)
    record.calls.delete(parsed.callId)
    const toolName = call?.name ?? 'tool'
    const view = call === undefined
      ? undefined
      : safePresent(
        () => tools()?.get(call.name, record.agent)?.presentResult?.(call.args, {
          content: parsed.content,
          isError: parsed.isError,
          ...parsed.meta === undefined ? {} : { meta: parsed.meta },
        }),
        toolName,
        'presentResult',
      )
    const card = mapResultView(view, cardContext(record, toolName))
    // No presenter (or a presenter that declined) means the client should see
    // the model-facing result verbatim rather than an empty completed card.
    const content: ToolCallContent[] = card?.content ?? toAcpToolContent(parsed.content)
    notify(record.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: parsed.callId,
      status: (parsed.isError ? 'failed' : 'completed') satisfies ToolCallStatus,
      ...card?.title === undefined ? {} : { title: card.title },
      content,
    })
  }

  const projectTodoWrite: EventProjector = (record, event) => {
    const todos = readTodoWrite(event)
    if (todos === undefined) return
    notify(record.sessionId, { sessionUpdate: 'plan', entries: todosToPlanEntries(todos) })
  }

  const projectRequestContext: EventProjector = (record, event) => {
    const parsed = readRequestContext(event)
    if (parsed === undefined) return
    if (parsed.contextWindow !== undefined) record.contextWindow = parsed.contextWindow
    // A deployment that names no model in config and composes no default leaves
    // the bridge genuinely ignorant of the route — so the picker stays hidden
    // rather than guessing. The first resolved request is where that ignorance
    // ends: adopt what the session actually ran and publish the selector then.
    // Only when still unknown, so this can never overwrite a user's choice.
    const selection = record.selection
    if (
      selection === undefined
      || selection.current !== undefined
      || parsed.provider === undefined
      || parsed.model === undefined
    ) return
    selection.current = { provider: parsed.provider, model: parsed.model }
    if (record.replaying) return
    void publishConfigOptions(record).catch((error: unknown) => {
      logger.warn(`acp-rich: could not publish config options: ${String(error)}`)
    })
  }

  const PROJECTORS: ReadonlyMap<string, EventProjector> = new Map([
    ['assistant/chunk', projectAssistantChunk],
    ['assistant/message', projectAssistantMessage],
    ['user/message', projectUserMessage],
    ['tool/call', projectToolCall],
    ['tool/result', projectToolResult],
    ['todo/write', projectTodoWrite],
    ['request/context', projectRequestContext],
  ])

  /** Run a presenter without letting it break event delivery. */
  function safePresent<T>(present: () => T, toolName: string, hook: string): T | undefined {
    try {
      return present()
    } catch (error: unknown) {
      logger.warn(`acp-rich: ${hook} failed for tool "${toolName}", falling back to generic: ${String(error)}`)
      return undefined
    }
  }

  /** Project one harness event onto the ACP wire; never throws into the emitter. */
  function project(record: SessionRecord, event: HarnessSessionEvent): void {
    const projector = PROJECTORS.get(event.type)
    if (projector === undefined) return
    try {
      projector(record, event)
    } catch (error: unknown) {
      logger.warn(`acp-rich: projecting ${event.type} failed: ${String(error)}`)
    }
  }

  ctx.on('session/event', ((session: HarnessSession, event: HarnessSessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      project(record, event)
    } finally {
      if (event.type === 'turn/end') settleTurnEnd(record, event)
    }
  }) as never)

  /** Arm or fail an in-flight prompt from its correlated turn ending. */
  function settleTurnEnd(record: SessionRecord, event: HarnessSessionEvent): void {
    const inflight = record.inflight
    const parsed = readTurnEnd(event)
    if (inflight === undefined || parsed === undefined || inflight.turn !== parsed.turn) return
    if (parsed.reason.kind === 'error') {
      // A model failure surfaces immediately as a prompt error; every ordinary
      // ending waits for whole-agent idle so later turns are not cut short.
      record.inflight = undefined
      inflight.reject(internalError(`turn failed: ${parsed.reason.error?.message ?? 'unknown error'}`))
    } else {
      inflight.endReason = parsed.reason
    }
  }

  ctx.on('agent/inbox/claimed', ((payload: { agent: HarnessAgent; message: { id: string }; turn: number }) => {
    const inflight = ownedRecord(payload.agent)?.inflight
    if (inflight !== undefined && inflight.messageId === payload.message.id) inflight.turn = payload.turn
  }) as never)

  ctx.on('agent/error', ((payload: { agent: HarnessAgent; turn: number; error: unknown }) => {
    const record = ownedRecord(payload.agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === payload.turn) return
    record.inflight = undefined
    inflight.reject(internalError(`turn failed: ${String(payload.error)}`))
  }) as never)

  // Slash commands are per-agent (a preset composes its own), so publish them
  // per session and republish the whole roster whenever the registry changes.
  const publishCommands = (record: SessionRecord): void => {
    const registry = commands()
    if (registry === undefined) return
    try {
      notify(record.sessionId, {
        sessionUpdate: 'available_commands_update',
        availableCommands: registry.list(record.agent).map(command => ({
          name: command.name,
          description: command.description,
          ...command.input === undefined ? {} : { input: { hint: command.input.hint } },
        })),
      })
    } catch (error: unknown) {
      logger.warn(`acp-rich: listing commands failed: ${String(error)}`)
    }
  }

  ctx.on('commands/change', (() => {
    for (const record of sessions.values()) publishCommands(record)
  }) as never)

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  ctx.on('approval/request', ((
    request: HarnessApprovalRequest,
    next: () => Promise<HarnessApprovalOutcome>,
  ): Promise<HarnessApprovalOutcome> => {
    const record = ownedRecord(request.agent)
    if (record === undefined) return next()
    const standing = grants.lookup(record.sessionId, request.toolName)
    if (standing !== undefined) {
      return Promise.resolve(standing === 'allowed' ? 'allowed-once' : 'rejected')
    }
    return conn.requestPermission({
      sessionId: record.sessionId,
      // The tool call the question is about, so the client attaches the prompt
      // to the card it already streamed. Without a call id the question still
      // carries the tool's identity as its title.
      toolCall: request.callId === undefined
        ? { toolCallId: `approval-${randomUUID()}`, title: request.toolName, name: request.toolName }
        : { toolCallId: request.callId, ...request.reason === undefined ? {} : { title: request.reason } },
      options: [...PERMISSION_OPTIONS],
    }).then(({ outcome }) => {
      const decision = interpretPermission(outcome)
      if (decision.remember !== undefined) {
        grants.remember(record.sessionId, request.toolName, decision.remember)
      }
      return decision.outcome
    }, (error: unknown) => {
      // A transport failure must fail closed, never silently authorize.
      logger.warn(`acp-rich: permission request failed, rejecting: ${String(error)}`)
      return 'rejected' as const
    })
  }) as never)

  // -------------------------------------------------------------------------
  // Prompt assembly
  // -------------------------------------------------------------------------

  /** Commit image parts to the attachment store and assemble harness content. */
  async function assembleContent(parts: readonly PromptPart[]): Promise<HarnessContentBlock[]> {
    const store = attachments()
    const blocks: HarnessContentBlock[] = []
    for (const part of parts) {
      if (part.kind === 'text') {
        if (part.text.length > 0) blocks.push({ type: 'text', text: part.text })
        continue
      }
      if (store === undefined) throw invalidParams('image prompts require an attachment store')
      let attachment
      try {
        attachment = await store.saveImage({
          data: Buffer.from(part.data, 'base64'),
          mediaType: part.mediaType,
          ...part.name === undefined ? {} : { name: part.name },
        })
      } catch (error: unknown) {
        throw invalidParams(`image attachment rejected: ${String(error)}`)
      }
      blocks.push({ type: 'image', attachment })
    }
    return blocks
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /** Register one freshly created or resumed agent as an ACP session. */
  function adopt(
    sessionId: string,
    handle: HarnessAgentHandle,
    cwd: string,
    selection: HarnessModelSelectionRef | undefined,
  ): SessionRecord {
    const record: SessionRecord = {
      sessionId,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      cwd,
      contextWindow: undefined,
      calls: new Map(),
      streamedSteps: new Set(),
      replaying: false,
      selection,
      inflight: undefined,
    }
    sessions.set(sessionId, record)
    return record
  }

  /**
   * Replay a persisted log onto the wire so a reconnecting client rebuilds the
   * transcript. Uses the same projectors as the live path, so a replayed
   * conversation renders identically to the one the client watched happen.
   */
  function replay(record: SessionRecord): void {
    record.replaying = true
    try {
      for (const event of record.agent.session.events) project(record, event)
    } finally {
      record.replaying = false
      // Chunk-level deltas replay alongside their commits; clear the per-step
      // marks so the first LIVE commit after a resume is judged on its own
      // streaming, not on history.
      record.streamedSteps.clear()
    }
  }

  /** Reject session features outside this bridge's contract. */
  function validateCwd(cwd: string): void {
    if (!isAbsolute(cwd)) throw invalidParams(`cwd must be an absolute path: ${cwd}`)
  }

  /**
   * Build the `setup` hook that mounts a session's MCP servers.
   *
   * Mounting happens inside `setup` — not after the handle returns — because
   * that is the only window the registry guarantees is closed before the loop
   * starts. Registering tools afterwards races the first prompt assembly, which
   * would make the bus intermittently invisible to the model's opening turn.
   *
   * A mount failure is downgraded to a warning: an unreachable optional server
   * should not cost the user the session. Anything the mapper refused is
   * reported by name so an operator can see which server went missing.
   */
  function mcpSetup(servers: readonly AcpMcpServer[] | undefined, cwd: string): HarnessAgentSetup | undefined {
    if (servers === undefined || servers.length === 0) return undefined
    const { mounted, rejected } = mapMcpServers(servers, cwd)
    for (const entry of rejected) {
      logger.warn(`acp-rich: skipped MCP server ${entry.name}: ${entry.reason}`)
    }
    if (mounted.length === 0) return undefined
    const mount = config.mountMcpServers ?? defaultMcpMounter
    return async agentCtx => {
      try {
        await mount(agentCtx, mounted)
      } catch (error) {
        logger.warn(`acp-rich: could not mount MCP servers: ${String(error)}`)
      }
    }
  }

  /**
   * `setup` as a spreadable fragment.
   *
   * `exactOptionalPropertyTypes` makes `{ setup: undefined }` a different thing
   * from an absent key, and the registry checks presence.
   */
  function mcpOption(servers: readonly AcpMcpServer[] | undefined, cwd: string): { setup?: HarnessAgentSetup } {
    const setup = mcpSetup(servers, cwd)
    return setup === undefined ? {} : { setup }
  }

  /** `ctx.llm` — the model catalog. Absent service publishes no model selector. */
  const llm = (): HarnessLlmService | undefined => ctx.get('llm') as HarnessLlmService | undefined

  /**
   * The selection a fresh session starts on.
   *
   * Plugin config wins, then the deployment default. Neither present yields
   * undefined, and that is reported rather than papered over: this bridge then
   * genuinely does not know what route the agent will take, and a picker
   * showing a guessed "current" model is a lie a user acts on.
   *
   * `agentDefaultModel` is read only here, at creation. It is the default for
   * *future* agents, so re-reading it later would let an unrelated settings
   * write appear to have changed this session's model.
   */
  function initialSelection(): HarnessModelSelection | undefined {
    if (config.provider !== undefined && config.model !== undefined) {
      return { provider: config.provider, model: config.model }
    }
    const defaults = ctx.get('agentDefaultModel') as
      | { currentSelection?: () => HarnessModelSelection }
      | undefined
    try {
      return defaults?.currentSelection?.()
    } catch (error) {
      logger.warn(`acp-rich: could not read the default model selection: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Give the loop its initial route as well as coupling the mutable selector.
   *
   * `installModelSelection()` only overrides the request waterfall after the
   * agent scope starts. If that optional coupling is unavailable, omitting the
   * route here leaves `agent.options.model` undefined: the stock deployment
   * persona then cannot render `{{model}}` before the request can even reach
   * the adapter. The default model is therefore a startup requirement, while
   * live model switching remains an optional capability.
   */
  function agentOptions(selection: HarnessModelSelection | undefined): Record<string, unknown> {
    if (selection !== undefined) {
      return {
        provider: selection.provider,
        model: selection.model,
      }
    }
    return {
      ...config.provider === undefined ? {} : { provider: config.provider },
      ...config.model === undefined ? {} : { model: config.model },
    }
  }

  /**
   * Everything this bridge composes into a new agent's scope, plus the cell it
   * keeps a handle on.
   *
   * MCP mounting and model-selection coupling share one `setup` because the
   * registry accepts one, and both need the same window: the scope is closed
   * before the loop starts, which is the last moment a registration is
   * guaranteed visible to the first prompt.
   *
   * The returned `selection` is undefined unless the coupling reported success,
   * so a deployment missing `@deepseek-ai/dsh-agent` loses the model picker
   * instead of gaining one that changes nothing.
   */
  function agentSetup(servers: readonly AcpMcpServer[] | undefined, cwd: string): {
    option: { setup?: HarnessAgentSetup }
    selected: () => HarnessModelSelectionRef | undefined
    initial: HarnessModelSelection | undefined
  } {
    const mcp = mcpSetup(servers, cwd)
    const start = initialSelection()
    const install = config.installModelSelection ?? defaultSelectionInstaller
    const cell: HarnessModelSelectionRef = { current: start, assembled: undefined }
    let live = false
    const setup: HarnessAgentSetup = async agentCtx => {
      if (mcp !== undefined) await mcp(agentCtx)
      try {
        live = await install(agentCtx, cell)
      } catch (error) {
        logger.warn(`acp-rich: the model selector is unavailable: ${String(error)}`)
      }
    }
    return { option: { setup }, selected: () => (live ? cell : undefined), initial: start }
  }

  /** The scope a config contributor reads, for one session. */
  function configScope(record: SessionRecord): SessionConfigScope | undefined {
    const selection = record.selection
    if (selection === undefined) return undefined
    return {
      sessionId: record.sessionId,
      session: record.agent.session,
      selection,
      llm: llm(),
      warn: message => logger.warn(message),
    }
  }

  /**
   * The selectors to publish for a session.
   *
   * Gated on the client having advertised `session.configOptions`: sending
   * options a client never asked for invites it to render a picker it has no
   * `session/set_config_option` path to honour.
   */
  async function currentConfigOptions(record: SessionRecord): Promise<SessionConfigOption[]> {
    if (!clientWantsConfigOptions) return []
    const scope = configScope(record)
    if (scope === undefined) return []
    return listSessionConfigOptions(scope)
  }

  /** Re-publish a session's selectors after something changed them. */
  async function publishConfigOptions(record: SessionRecord): Promise<void> {
    const configOptions = await currentConfigOptions(record)
    if (configOptions.length === 0) return
    notify(record.sessionId, { sessionUpdate: 'config_option_update', configOptions })
  }

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      async initialize(params: InitializeRequest): Promise<InitializeResponse> {
        // Capabilities are read from the composed tree, so they must not be
        // answered before that tree exists.
        await awaitRuntime()
        // Selectors are only published to a client that asked for them: an
        // unasked-for picker has no `session/set_config_option` path home.
        clientWantsConfigOptions = params.clientCapabilities?.session?.configOptions != null
        // Capabilities are reported from what the deployment actually composed,
        // never from what this package can do in principle: an advertised
        // capability the runtime cannot serve turns a graceful degradation into
        // a mid-turn protocol error.
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'deepseek-harness-acp-rich', version: '0.1.0' },
          agentCapabilities: {
            loadSession: canLoadSession(),
            listSessions: persistence() === undefined ? undefined : {},
            promptCapabilities: {
              image: attachments() !== undefined,
              audio: false,
              embeddedContext: true,
            },
            mcpCapabilities: {
              // stdio is the untagged default variant and needs no flag; these
              // three are the tagged transports, and only Streamable HTTP has a
              // counterpart in the harness MCP client.
              http: true,
              sse: false,
              acp: false,
            },
          },
          authMethods: [],
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve()
      },

      async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
        assertOpen()
        await awaitRuntime()
        const store = persistence()
        if (store === undefined) throw RequestError.methodNotFound('session/list')
        if (params.cursor != null) {
          throw invalidParams('dsh session listing does not use cursors')
        }
        const sessions = (await store.list())
          .filter(header => params.cwd == null || header.cwd === params.cwd)
          .map(header => ({
            sessionId: header.id,
            cwd: header.cwd ?? '/',
          }))
        return { sessions }
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        // A session's config options are snapshotted here and never rebuilt
        // from a later catalog, so this is the one await that decides whether
        // the user's own provider routes exist for the life of the session.
        await awaitRuntime()
        validateCwd(params.cwd)
        const sessionId = randomUUID()
        const setup = agentSetup(params.mcpServers as AcpMcpServer[] | undefined, params.cwd)
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(setup.initial),
          ...setup.option,
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        const record = adopt(sessionId, handle, params.cwd, setup.selected())
        publishCommands(record)
        const configOptions = await currentConfigOptions(record)
        return { sessionId, ...configOptions.length === 0 ? {} : { configOptions } }
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        assertOpen()
        await awaitRuntime()
        validateCwd(params.cwd)
        const resume = agents.resume
        if (!canLoadSession() || typeof resume !== 'function') {
          throw RequestError.methodNotFound('session/load')
        }
        const existing = sessions.get(params.sessionId)
        if (existing !== undefined) {
          // Reloading a session this connection already owns is a transcript
          // request, not a second resume: replaying the live log is both
          // cheaper and the only answer that cannot fork the identity.
          replay(existing)
          publishCommands(existing)
          const reloaded = await currentConfigOptions(existing)
          return reloaded.length === 0 ? {} : { configOptions: reloaded }
        }
        const setup = agentSetup(params.mcpServers as AcpMcpServer[] | undefined, params.cwd)
        const handle = await resume.call(agents, {
          resumeSessionId: params.sessionId,
          agentOptions: agentOptions(setup.initial),
          ...setup.option,
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/load')
        }
        const record = adopt(params.sessionId, handle, params.cwd, setup.selected())
        replay(record)
        publishCommands(record)
        const configOptions = await currentConfigOptions(record)
        return configOptions.length === 0 ? {} : { configOptions }
      },

      /**
       * Apply a selector the client wrote.
       *
       * The response carries the FULL roster, not just the option that moved,
       * because selectors are coupled: choosing a model changes which reasoning
       * efforts exist, and returning the model alone would leave the client
       * showing efforts belonging to the previous route.
       */
      async setSessionConfigOption(
        params: SetSessionConfigOptionRequest,
      ): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        const record = requireSession(params.sessionId)
        const scope = configScope(record)
        if (scope === undefined) {
          throw invalidParams('this session publishes no configuration options')
        }
        const value = 'value' in params ? params.value : undefined
        if (typeof value !== 'string' && typeof value !== 'boolean') {
          throw invalidParams(`missing value for config option ${params.configId}`)
        }
        try {
          await applySessionConfigOption(scope, params.configId, value)
        } catch (error) {
          if (error instanceof ConfigRejected) throw invalidParams(error.message)
          throw internalError(String(error))
        }
        return { configOptions: await currentConfigOptions(record) }
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const record = requireSession(params.sessionId)
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt, attachments() !== undefined)) {
          throw invalidParams('unsupported prompt content')
        }
        const parts = splitPrompt(params.prompt)
        const content = await assembleContent(parts)
        if (content.length === 0) throw invalidParams('empty prompt')

        // An agent-loop reload disposes the loop's agents while this record
        // survives; a disposed machine would accept the item silently, so
        // validate against the live registry before sending.
        if (agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({ content, source: { kind: 'user' } }) as { id: string }
        return {
          stopReason: await new Promise<StopReason>((resolve, reject) => {
            // Arm the slot before followup() so a listener-driven synchronous
            // turn cannot slip past correlation.
            const inflight: InflightPrompt = {
              resolve, reject, messageId: message.id, turn: undefined, endReason: undefined,
            }
            record.inflight = inflight
            try {
              record.agent.followup(message)
            } catch (error: unknown) {
              record.inflight = undefined
              throw internalError(`prompt was not queued: ${String(error)}`)
            }
            // Settlement waits for whole-agent idle: a correlated turn/end arms
            // `endReason`, while a turnless slot (admission discarded the
            // prompt) stays cancelled.
            void record.agent.whenIdle().then(() => {
              if (record.inflight !== inflight) return
              record.inflight = undefined
              const end = inflight.endReason
              if (end === undefined) {
                inflight.resolve('cancelled')
              } else {
                // A token-limit ending is a turn fact, not a prompt-level stop.
                inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end))
              }
            })
          }),
        }
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(params.sessionId)
        if (record === undefined) return Promise.resolve()
        record.agent.cancel({ kind: 'user' })
        const inflight = record.inflight
        if (inflight !== undefined) {
          record.inflight = undefined
          inflight.resolve('cancelled')
        }
        return Promise.resolve()
      },
    }
  }

  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    grants.clear()
    // Stop the bridge's own work before any await: a descendant drain can block
    // on persistence, and the top-level agents must not keep running model and
    // tool calls for its whole duration.
    for (const record of records) {
      record.agent.cancel({ kind: 'user' })
      const inflight = record.inflight
      if (inflight !== undefined) {
        record.inflight = undefined
        inflight.resolve('cancelled')
      }
    }
    quiescing = (async () => {
      // Continuable subagents outlive the turn that started them and own their
      // descendants' teardown. Drain those forests child-first BEFORE disposing
      // the top-level agents, so no descendant holds a runtime its owner
      // already released.
      const subagents = ctx.get('subagents') as HarnessContinuableDrain | undefined
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map(record => record.agent))
        } catch (error: unknown) {
          logger.warn(`acp-rich: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const disposals = await Promise.allSettled(records.map(record => record.dispose()))
      const failures = disposals.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${failures.map(String).join('; ')}`,
        )
      }
    })()
    return quiescing
  }

  void conn.closed
    .catch((error: unknown) => {
      logger.warn(`acp-rich: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp-rich: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, 'acp-rich.connection')
}

// No default export, deliberately. Cordis's loader takes a module's `default`
// as the whole plugin when one is present, and a bare `apply` function carries
// neither `name` nor `inject` — the tree then starts the bridge before the
// agent spine has published `agents` and dies with `cannot get property
// "agents" without inject`. Every first-party harness plugin exports the named
// triple and nothing else; this one matches.
