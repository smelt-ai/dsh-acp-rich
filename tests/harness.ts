/**
 * In-memory test rig: a fake harness runtime plus a real ACP client wired to
 * the bridge over cross-connected byte streams.
 *
 * The fake runtime is the point. The bridge reads dsh structurally, so its
 * whole contract can be exercised — streaming, cards, diffs, plans, usage,
 * permissions, replay, cancel — against a scripted event log, with no harness
 * install, no model, and no network.
 */

import { randomUUID } from 'node:crypto'
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import { apply, type AcpRichConfig } from '../src/index.ts'
import type {
  HarnessAgent,
  HarnessAgentContext,
  HarnessAgentHandle,
  HarnessAgentSetup,
  HarnessSessionEvent,
  HarnessToolDefinition,
} from '../src/harness.ts'
import type { HarnessModelSelectionRef, SelectionInstaller } from '../src/config.ts'

type Listener = (...args: never[]) => unknown

/** A scriptable stand-in for one live harness agent. */
export class FakeAgent implements HarnessAgent {
  readonly id = randomUUID()
  readonly session: { header: { id: string }; events: HarnessSessionEvent[] }
  turn = 0
  cancelled = false
  readonly delivered: { id: string; content: unknown }[] = []
  private seq = 0
  private readonly idle: (() => void)[] = []

  constructor(
    sessionId: string,
    private readonly bus: FakeContext,
    seed: HarnessSessionEvent[] = [],
  ) {
    this.session = { header: { id: sessionId }, events: [...seed] }
    this.seq = seed.length
  }

  /** Script run on each delivered prompt, set per test. */
  onPrompt: ((agent: FakeAgent) => Promise<void> | void) | undefined

  followup(message: unknown): void {
    const claimed = message as { id: string; content: unknown }
    this.delivered.push(claimed)
    this.turn += 1
    this.bus.emit('agent/inbox/claimed', { agent: this, message: claimed, turn: this.turn })
    queueMicrotask(() => { void Promise.resolve(this.onPrompt?.(this)) })
  }

  cancel(_reason: { kind: string }): void {
    this.cancelled = true
  }

  whenIdle(): Promise<void> {
    return new Promise<void>(resolve => { this.idle.push(resolve) })
  }

  /** Append one event to the log and dispatch it as the harness would. */
  emit(type: string, data: unknown): void {
    const event: HarnessSessionEvent = { type, seq: this.seq++, time: Date.now(), data }
    this.session.events.push(event)
    this.bus.emit('session/event', this.session, event)
  }

  /** Close the current turn and let every awaited `whenIdle()` settle. */
  async endTurn(kind = 'completed'): Promise<void> {
    this.emit('turn/end', { turn: this.turn, reason: { kind } })
    const waiters = this.idle.splice(0, this.idle.length)
    for (const resolve of waiters) resolve()
    await Promise.resolve()
  }
}

/** One model in the fake catalog. */
export interface FakeModel {
  id: string
  name: string
  /** Reasoning efforts this model advertises; absent means none. */
  efforts?: string[]
  /** Explicit input modalities; absent models an adapter that declares none. */
  modalities?: string[]
}

/** A minimal cordis-shaped context carrying only the services the bridge reads. */
export class FakeContext {
  readonly logs: string[] = []
  readonly logger = {
    warn: (message: string) => { this.logs.push(message) },
    error: (message: string) => { this.logs.push(message) },
  }

  readonly listeners = new Map<string, Listener[]>()
  readonly services = new Map<string, unknown>()
  readonly handles = new Map<string, HarnessAgentHandle>()
  teardown: (() => unknown) | undefined
  /** Set false to model a profile that composes no `sessionPersistence` provider. */
  supportsResume = true
  /** Seed logs keyed by session id, served by `agents.resume`. */
  readonly persisted = new Map<string, HarnessSessionEvent[]>()

  /** Plugins mounted on the per-agent scope, in mount order. */
  readonly mountedPlugins: { plugin: unknown; config: unknown }[] = []

  /** Stand-in for the unpublished per-agent cordis scope. */
  readonly agentCtx: HarnessAgentContext = {
    plugin: (plugin: unknown, config?: unknown) => {
      this.mountedPlugins.push({ plugin, config })
      return undefined
    },
  }

  readonly agents = {
    create: async (options: { sessionId: string; setup?: HarnessAgentSetup }): Promise<HarnessAgentHandle> => {
      await options.setup?.(this.agentCtx)
      const agent = new FakeAgent(options.sessionId, this)
      const handle: HarnessAgentHandle = { agent, dispose: async () => { this.handles.delete(options.sessionId) } }
      this.handles.set(options.sessionId, handle)
      return handle
    },
    resume: async (options: { resumeSessionId: string; setup?: HarnessAgentSetup }): Promise<HarnessAgentHandle> => {
      await options.setup?.(this.agentCtx)
      const agent = new FakeAgent(options.resumeSessionId, this, this.persisted.get(options.resumeSessionId) ?? [])
      const handle: HarnessAgentHandle = { agent, dispose: async () => { this.handles.delete(options.resumeSessionId) } }
      this.handles.set(options.resumeSessionId, handle)
      return handle
    },
    get: (id: string): HarnessAgent | undefined => {
      for (const handle of this.handles.values()) if (handle.agent.id === id) return handle.agent
      return undefined
    },
  }

  get(name: string): unknown {
    if (name === 'agents') return this.agents
    // The registry method always exists (it is a class method on the real
    // registry); what a bare profile lacks is the persistence provider it
    // loads through.
    if (name === 'sessionPersistence') return this.supportsResume ? { load: () => undefined } : undefined
    return this.services.get(name)
  }

  on(event: string, listener: Listener): () => void {
    const bucket = this.listeners.get(event) ?? []
    bucket.push(listener)
    this.listeners.set(event, bucket)
    return () => {
      const index = bucket.indexOf(listener)
      if (index >= 0) bucket.splice(index, 1)
    }
  }

  /** Dispatch a plain event to every listener. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...rest: unknown[]) => unknown)(...args)
    }
  }

  /**
   * Dispatch a waterfall event, returning the first listener's answer.
   * Mirrors cordis' `approval/request` contract closely enough for the bridge.
   */
  async waterfall<T>(event: string, payload: unknown, fallback: T): Promise<T> {
    for (const listener of this.listeners.get(event) ?? []) {
      const result = await (listener as (...rest: unknown[]) => Promise<T>)(
        payload,
        () => Promise.resolve(fallback),
      )
      if (result !== undefined) return result
    }
    return fallback
  }

  effect(setup: () => (() => unknown) | Promise<() => unknown>): void {
    const result = setup()
    if (typeof result === 'function') this.teardown = result
  }

  /** Register a tool registry answering with the given presenters. */
  installTools(definitions: Record<string, HarnessToolDefinition>): void {
    this.services.set('tools', { get: (name: string) => definitions[name] })
  }

  /** Register a slash-command registry. */
  installCommands(list: { name: string; description: string; input?: { hint: string } }[]): void {
    this.services.set('commands', { list: () => list })
  }

  /**
   * Register a model catalog and, optionally, the deployment default a fresh
   * session starts on.
   */
  installModels(options: {
    providers?: { id: string; name: string; models: FakeModel[] }[]
    default?: { provider: string; model: string } | undefined
    failing?: string
  } = {}): { id: string; name: string; models: FakeModel[] }[] {
    const providers = options.providers ?? [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', efforts: ['low', 'high'] },
      ],
    }]
    const find = (provider: string, model: string): FakeModel | undefined =>
      providers.find(entry => entry.id === provider)?.models.find(entry => entry.id === model)
    this.services.set('llm', {
      listProviders: () => providers.map(entry => ({ id: entry.id, name: entry.name })),
      listModels: async (provider: string) => {
        if (provider === options.failing) throw new Error('route is down')
        const group = providers.find(entry => entry.id === provider)
        return (group?.models ?? []).map(model => ({
          provider,
          id: model.id,
          name: model.name,
          ...model.modalities === undefined ? {} : { inputModalities: model.modalities },
        }))
      },
      resolveModelInfo: async (provider: string, model: string) => {
        const found = find(provider, model)
        if (found === undefined) throw new Error(`unknown model ${provider}/${model}`)
        return {
          ...found.modalities === undefined ? {} : { inputModalities: found.modalities },
          ...found.efforts === undefined
            ? {}
            : { reasoning: { efforts: found.efforts.map(id => ({ id, name: id.toUpperCase() })) } },
        }
      },
    })
    if (options.default !== undefined) {
      this.services.set('agentDefaultModel', { currentSelection: () => options.default })
    }
    return providers
  }

  installAttachments(): { saved: { mediaType: string; bytes: number }[] } {
    const saved: { mediaType: string; bytes: number }[] = []
    this.services.set('attachments', {
      saveImage: async (input: { data: Uint8Array; mediaType: string }) => {
        saved.push({ mediaType: input.mediaType, bytes: input.data.byteLength })
        return {
          attachmentId: `att-${saved.length}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
        }
      },
    })
    return { saved }
  }
}

/** The mounted bridge plus the client that talks to it. */
export interface Rig {
  ctx: FakeContext
  client: ClientSideConnection
  updates: { sessionId: string; update: SessionNotification['update'] }[]
  permissions: RequestPermissionRequest[]
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  agentFor: (sessionId: string) => FakeAgent
  /** Answer the harness approval waterfall as the harness would. */
  requestApproval: (agent: FakeAgent, toolName: string, callId?: string) => Promise<string>
  dispose: () => Promise<void>
}

/** Mount the bridge against a fake runtime and a real ACP client. */
/**
 * A {@link SelectionInstaller} that records every cell the bridge couples.
 *
 * Writing through a recorded cell is how a test proves a config change reached
 * the agent's routing rather than only the wire.
 *
 * @param cells - sink for coupled cells, in creation order.
 * @param live - false models a deployment where the coupling is unavailable.
 */
export function recordingInstaller(
  cells: HarnessModelSelectionRef[],
  live = true,
): SelectionInstaller {
  return async (_agentCtx, cell) => {
    if (live) cells.push(cell)
    return live
  }
}

/**
 * The installer a rig uses unless a test supplies one.
 *
 * Reports failure rather than reaching for the real `@deepseek-ai/dsh-agent`,
 * which no test workspace installs: an unmodelled dynamic import would make
 * every session log a warning about a package it was never meant to load.
 */
const absentInstaller: SelectionInstaller = async () => false

export function makeRig(config: Partial<AcpRichConfig> = {}): Rig {
  const ctx = new FakeContext()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({ write: chunk => clientWriter.write(chunk) })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)

  const updates: Rig['updates'] = []
  const permissions: RequestPermissionRequest[] = []
  const rig: Rig = {
    ctx,
    updates,
    permissions,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    client: undefined as unknown as ClientSideConnection,
    agentFor: (sessionId: string) => {
      const handle = ctx.handles.get(sessionId)
      if (handle === undefined) throw new Error(`no agent for ${sessionId}`)
      return handle.agent as FakeAgent
    },
    requestApproval: (agent, toolName, callId) => ctx.waterfall(
      'approval/request',
      { agent, toolName, ...callId === undefined ? {} : { callId } },
      'unavailable',
    ),
    dispose: async () => { await ctx.teardown?.() },
  }

  apply(ctx as never, {
    stream: agentStream,
    installModelSelection: absentInstaller,
    ...config,
  } as AcpRichConfig)

  rig.client = new ClientSideConnection((_agent: AcpAgent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      updates.push({ sessionId: params.sessionId, update: params.update })
      return Promise.resolve()
    },
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      permissions.push(params)
      return Promise.resolve(rig.onPermission(params))
    },
  }), clientStream)
  return rig
}

/** Poll until `predicate` holds or the budget runs out. */
export async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Every update of one kind, in arrival order. */
export function updatesOfKind<T extends SessionNotification['update']['sessionUpdate']>(
  rig: Rig,
  kind: T,
): Extract<SessionNotification['update'], { sessionUpdate: T }>[] {
  return rig.updates
    .map(entry => entry.update)
    .filter((update): update is Extract<SessionNotification['update'], { sessionUpdate: T }> =>
      update.sessionUpdate === kind)
}

/**
 * Open one session against the mounted bridge.
 *
 * `configOptions` mirrors the client capability that gates selectors, so the
 * default session models a client that never asked for them.
 */
export async function openSession(
  rig: Rig,
  cwd = '/workspace',
  options: { configOptions?: boolean } = {},
): Promise<string> {
  await rig.client.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      ...options.configOptions === true ? { session: { configOptions: {} } } : {},
    },
  })
  const { sessionId } = await rig.client.newSession({ cwd, mcpServers: [] })
  return sessionId
}
