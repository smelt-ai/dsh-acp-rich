/**
 * Session configuration options: the `ConfigOptionUpdate` half of the bridge.
 *
 * ACP lets an agent publish per-session selectors (`session/new` and
 * `session/load` return them, `session/set_config_option` writes them, and
 * `config_option_update` re-publishes them). smelt renders the one tagged
 * `category: "model"` as the model picker and the rest as a settings list.
 *
 * The harness supplies the data through two seams that are easy to confuse:
 *
 * - `ctx.llm` is the *catalog* — which provider routes exist and what models
 *   and reasoning efforts each advertises.
 * - `ModelSelectionRef` is the *selection* — a mutable per-agent cell the
 *   entry point owns. The harness has no global "current model" to read or
 *   write; whoever creates the agent owns its selection, which is why this
 *   bridge holds the ref rather than calling some setter.
 *
 * `agentDefaultModel` is deliberately NOT that seam: it is the default handed
 * to *future* agents. Writing it would leave the running session on its old
 * model while the picker claimed otherwise.
 *
 * @module
 */

import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import type { HarnessSession } from './harness.js'
import { isRecord, readArray, readString } from './harness.js'

// ---------------------------------------------------------------------------
// Harness catalog vocabulary (packages/llm/llm/src/types.ts)
// ---------------------------------------------------------------------------

/** `LlmProviderInfo` — one registered provider route. */
export interface HarnessProviderInfo {
  id: string
  name: string
}

/** `LlmModelInfo` — one model advertised by a provider route. */
export interface HarnessModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  /**
   * Accepted request modalities. Absent means *unknown*; an explicit list that
   * omits `image` is negative capability. The two are not interchangeable —
   * refusing on absence would block every adapter that never declares them.
   */
  inputModalities?: readonly string[]
}

/** `LlmReasoningEffortInfo` — one selectable reasoning effort. */
export interface HarnessEffortInfo {
  id: string
  name: string
  description?: string
}

/** `resolveModelInfo` result; only the fields this bridge reads. */
export interface HarnessResolvedModelInfo {
  inputModalities?: readonly string[]
  reasoning?: { efforts: readonly HarnessEffortInfo[]; defaultEffort?: string }
}

/** `ctx.llm` — the catalog half. Absent service means no selectors are published. */
export interface HarnessLlmService {
  listProviders: () => readonly HarnessProviderInfo[]
  listModels: (provider: string) => Promise<readonly HarnessModelInfo[]>
  resolveModelInfo: (provider: string, model: string) => Promise<HarnessResolvedModelInfo>
}

/** `ModelSelection` — a complete provider/model/effort choice. */
export interface HarnessModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * `ModelSelectionRef` — the mutable cell `installModelSelection` reads.
 *
 * `current` is read when a step enters prompt assembly and copied to
 * `assembled`, so a switch lands on the *next* step rather than tearing the
 * prompt and the request apart mid-flight. This bridge only writes `current`.
 */
export interface HarnessModelSelectionRef {
  current: HarnessModelSelection | undefined
  assembled: HarnessModelSelection | undefined
}

// ---------------------------------------------------------------------------
// Config option ids
// ---------------------------------------------------------------------------

/** Selector id for the provider/model choice; tagged `category: "model"`. */
export const MODEL_CONFIG_ID = 'model'

/** Selector id for the reasoning effort of the selected model. */
export const EFFORT_CONFIG_ID = 'reasoning_effort'

/**
 * Value id meaning "let the provider decide".
 *
 * The harness distinguishes an absent effort (provider default) from every
 * named effort, and ACP selects have no null value, so the absence needs an id
 * of its own. `__` prefixed so it cannot collide with an adapter-owned id,
 * which the harness constrains to a `ReasoningEffortId`.
 */
export const EFFORT_DEFAULT_VALUE = '__default'

/** Encode a provider/model pair as one ACP select value. */
export function modelValueId(provider: string, model: string): string {
  return `${provider}/${model}`
}

// ---------------------------------------------------------------------------
// Catalog → ACP selector
// ---------------------------------------------------------------------------

/** One provider route's models, resolved for display. */
export interface ModelCatalogGroup {
  provider: HarnessProviderInfo
  models: readonly HarnessModelInfo[]
}

/**
 * Read every provider route's models.
 *
 * A provider that throws is dropped with a warning rather than failing the
 * whole catalog: one misconfigured route should cost the user that route, not
 * the model picker. Routes advertising nothing are dropped too — an empty
 * group renders as a heading with no rows.
 *
 * @param llm - the harness catalog service.
 * @param warn - sink for per-provider failures.
 * @returns groups in registration order, each with at least one model.
 */
export async function readModelCatalog(
  llm: HarnessLlmService,
  warn: (message: string) => void,
): Promise<ModelCatalogGroup[]> {
  const groups = await Promise.all(llm.listProviders().map(async (provider): Promise<ModelCatalogGroup | undefined> => {
    try {
      const models = await llm.listModels(provider.id)
      return models.length === 0 ? undefined : { provider, models }
    } catch (error) {
      warn(`acp-rich: provider ${provider.id} advertised no models: ${String(error)}`)
      return undefined
    }
  }))
  return groups.filter((group): group is ModelCatalogGroup => group !== undefined)
}

/**
 * Project a catalog onto the ACP model selector.
 *
 * Grouped rather than flat because the harness catalog is genuinely two-level
 * and ACP has the matching shape; smelt flattens groups itself when it only
 * needs a list, so grouping costs the flat clients nothing.
 *
 * The current selection is included even when the catalog does not advertise
 * it. Catalog membership is advisory — a route still dispatches a model it
 * stopped listing — and dropping it would make the picker display some *other*
 * model as current, which is worse than showing one extra row.
 *
 * @param groups - resolved catalog groups.
 * @param current - the session's selection, or undefined before one is made.
 * @returns the selector, or undefined when there is nothing to choose from.
 */
export function buildModelOption(
  groups: readonly ModelCatalogGroup[],
  current: HarnessModelSelection | undefined,
): SessionConfigOption | undefined {
  if (groups.length === 0) return undefined
  const currentValue = current === undefined ? '' : modelValueId(current.provider, current.model)
  const options: SessionConfigSelectGroup[] = groups.map(group => ({
    group: group.provider.id,
    name: group.provider.name,
    options: group.models.map((model): SessionConfigSelectOption => ({
      value: modelValueId(model.provider, model.id),
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
    })),
  }))
  const listed = options.some(group => group.options.some(option => option.value === currentValue))
  if (!listed && current !== undefined) {
    options.push({
      group: current.provider,
      name: current.provider,
      options: [{ value: currentValue, name: current.model }],
    })
  }
  return {
    type: 'select',
    id: MODEL_CONFIG_ID,
    name: 'Model',
    category: 'model',
    currentValue,
    options,
  }
}

/**
 * Project a resolved model's reasoning efforts onto a selector.
 *
 * Returns undefined for a model that declares none: publishing an empty or
 * single-valued effort picker would suggest a knob the route does not have.
 *
 * @param info - the resolved info for the *currently selected* model.
 * @param current - the selected effort, or undefined for the provider default.
 * @returns the selector, or undefined when the model has no efforts.
 */
export function buildEffortOption(
  info: HarnessResolvedModelInfo,
  current: string | undefined,
): SessionConfigOption | undefined {
  const efforts = info.reasoning?.efforts ?? []
  if (efforts.length === 0) return undefined
  const options: SessionConfigSelectOption[] = [
    {
      value: EFFORT_DEFAULT_VALUE,
      name: 'Default',
      description: 'Let the provider choose for this model.',
    },
    ...efforts.map((effort): SessionConfigSelectOption => ({
      value: effort.id,
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })),
  ]
  const currentValue = current !== undefined && efforts.some(effort => effort.id === current)
    ? current
    : EFFORT_DEFAULT_VALUE
  return {
    type: 'select',
    id: EFFORT_CONFIG_ID,
    name: 'Reasoning effort',
    category: 'thought_level',
    currentValue,
    options,
  }
}

/**
 * Resolve a model selector value against the catalog.
 *
 * Deliberately a lookup rather than a `split('/')`: a model id may itself
 * contain a separator, so splitting would silently route to a model nobody
 * chose. An id the catalog does not carry is a bad request, not a guess.
 *
 * @param groups - resolved catalog groups.
 * @param value - the value id the client selected.
 * @returns the provider/model pair, or undefined when unlisted.
 */
export function resolveModelValue(
  groups: readonly ModelCatalogGroup[],
  value: string,
): { provider: string; model: string } | undefined {
  for (const group of groups) {
    for (const model of group.models) {
      if (modelValueId(model.provider, model.id) === value) {
        return { provider: model.provider, model: model.id }
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Image-modality guard
// ---------------------------------------------------------------------------

/**
 * Whether a session's logged user messages already carry an image.
 *
 * Read from the session log rather than the live inbox because that is the
 * record the next request is rebuilt from: a switch is only safe if every
 * message the model will *see* fits the new route.
 *
 * @param session - the live session object.
 * @returns true when at least one logged user message contains image content.
 */
export function sessionHasImage(session: HarnessSession): boolean {
  for (const event of session.events) {
    if (event.type !== 'user/message') continue
    if (!isRecord(event.data)) continue
    const message = isRecord(event.data['message']) ? event.data['message'] : event.data
    const content = readArray(message, 'content') ?? []
    for (const block of content) {
      if (readString(block, 'type') === 'image') return true
    }
  }
  return false
}

/**
 * Why a model cannot serve this session, or undefined when it can.
 *
 * Only an *explicit* modality list that omits `image` refuses. An adapter that
 * declares no modalities is unknown, not text-only, and refusing on unknown
 * would block every route that has not adopted the field.
 *
 * @param info - resolved info for the candidate model.
 * @param hasImage - whether the session already contains image content.
 * @param model - model id, for the message.
 * @returns a user-facing reason, or undefined when the switch is allowed.
 */
export function modelRefusalReason(
  info: HarnessResolvedModelInfo,
  hasImage: boolean,
  model: string,
): string | undefined {
  if (!hasImage) return undefined
  const modalities = info.inputModalities
  if (modalities === undefined || modalities.includes('image')) return undefined
  return `model "${model}" does not accept image input, but this session already contains images`
}

// ---------------------------------------------------------------------------
// Selection installer
// ---------------------------------------------------------------------------

/**
 * Couple a selection cell to one agent's prompt assembly and request routing.
 *
 * @param agentCtx - the unpublished per-agent scope from `create`/`resume`.
 * @param selection - the cell this bridge will write on a config change.
 * @returns true when the coupling is live.
 */
export type SelectionInstaller = (
  agentCtx: unknown,
  selection: HarnessModelSelectionRef,
) => Promise<boolean>

type SelectionWaterfallNext = () => Promise<unknown>
type SelectionWaterfallListener = (...args: unknown[]) => Promise<unknown>

interface SelectionScope {
  on: (event: string, listener: SelectionWaterfallListener) => unknown
}

function selectionScope(value: unknown): SelectionScope | undefined {
  if (!isRecord(value) || typeof value.on !== 'function') return undefined
  return value as unknown as SelectionScope
}

/**
 * Install the two upstream selection waterfalls without importing a harness
 * package. Bundles loaded through a `link:` dependency resolve their source
 * path outside the native DSH profile, so Node cannot always resolve
 * `@deepseek-ai/dsh-agent` from the bridge's own module location. The
 * waterfall contract is stable public runtime behavior and lets the bridge
 * retain a live picker in that normal native-profile layout.
 */
export const fallbackSelectionInstaller: SelectionInstaller = async (agentCtx, selection) => {
  const scope = selectionScope(agentCtx)
  if (scope === undefined) return false

  scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
    // Snapshot before continuing: a switch concurrent with prompt assembly
    // belongs to the next model step, never half of the current one.
    const selected = selection.current
    if (typeof next !== 'function') {
      throw new TypeError('dsh-acp-rich: system-prompt/assemble waterfall did not provide next()')
    }
    const assembled = await (next as SelectionWaterfallNext)()
    selection.assembled = selected
    if (selected === undefined || !isRecord(assembled)) return assembled
    const variables = isRecord(assembled.variables) ? assembled.variables : {}
    return {
      ...assembled,
      variables: {
        ...variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  scope.on('agent/request', async (_request, next) => {
    if (typeof next !== 'function') {
      throw new TypeError('dsh-acp-rich: agent/request waterfall did not provide next()')
    }
    const resolved = await (next as SelectionWaterfallNext)()
    const selected = selection.assembled
    if (selected === undefined || !isRecord(resolved)) return resolved
    const request = { ...resolved }
    delete request.reasoningEffort
    return {
      ...request,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
    }
  })
  return true
}

/**
 * Install through the harness's own `installModelSelection`.
 *
 * Dynamically imported, and a failure returns false rather than throwing: a
 * deployment without the package still runs sessions perfectly well, it just
 * cannot switch models. The caller uses the answer to decide whether to
 * publish the model selector at all — a picker that silently changes nothing
 * is worse than no picker.
 *
 * Deliberately not reimplemented locally. The waterfall contract it
 * encapsulates (snapshot `current` at assembly, apply `assembled` at request,
 * clear an inherited effort when none is selected) is upstream's to change,
 * and a local copy would drift without ever failing a build.
 */
export const defaultSelectionInstaller: SelectionInstaller = async (agentCtx, selection) => {
  try {
    const mod = await import('@deepseek-ai/dsh-agent')
    if (typeof mod.installModelSelection === 'function') {
      mod.installModelSelection(agentCtx, selection)
      return true
    }
  } catch {
    // `link:` bundles resolve through their source checkout, not the profile's
    // module fallback. Use the compatible structural path below.
  }
  return fallbackSelectionInstaller(agentCtx, selection)
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

/** Everything a config provider may read about the session it configures. */
export interface SessionConfigScope {
  readonly sessionId: string
  readonly session: HarnessSession
  readonly selection: HarnessModelSelectionRef
  readonly llm: HarnessLlmService | undefined
  readonly warn: (message: string) => void
}

/**
 * One contributor of session config options.
 *
 * A contributor owns whole selectors, not single fields, because coupled
 * selectors have to move together: switching model changes which reasoning
 * efforts exist, and splitting those across two contributors would let the
 * effort picker outlive the model that defined it.
 */
export interface SessionConfigProvider {
  /** The selectors this contributor currently publishes, in display order. */
  options: (scope: SessionConfigScope) => Promise<SessionConfigOption[]>
  /**
   * Apply a selection.
   * @returns true when this contributor owns `configId`, false to pass it on.
   * @throws when it owns the id but the value is not acceptable.
   */
  apply: (scope: SessionConfigScope, configId: string, value: string | boolean) => Promise<boolean>
}

/** Raised by a provider when a selection cannot be honoured. */
export class ConfigRejected extends Error {}

/** The model/effort contributor: the harness's only live per-session knob. */
export const modelConfigProvider: SessionConfigProvider = {
  async options(scope) {
    const llm = scope.llm
    if (llm === undefined) return []
    const current = scope.selection.current
    // No selection yet means the bridge has not learned the route this session
    // runs on. A picker with nothing marked current invites a user to "switch"
    // to the model already in use, so publish nothing until the first resolved
    // request says what it is.
    if (current === undefined) return []
    const groups = await readModelCatalog(llm, scope.warn)
    const model = buildModelOption(groups, current)
    if (model === undefined) return []
    const out = [model]
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model)
      const effort = buildEffortOption(info, current.reasoningEffort)
      if (effort !== undefined) out.push(effort)
    } catch (error) {
      // A route that cannot describe the selected model still dispatches it;
      // losing the effort picker is the honest degradation, losing the model
      // picker with it would not be.
      scope.warn(`acp-rich: could not resolve reasoning efforts: ${String(error)}`)
    }
    return out
  },

  async apply(scope, configId, value) {
    if (configId !== MODEL_CONFIG_ID && configId !== EFFORT_CONFIG_ID) return false
    const llm = scope.llm
    if (llm === undefined) throw new ConfigRejected('this deployment composes no model catalog')
    if (typeof value !== 'string') throw new ConfigRejected(`${configId} takes a select value, not a boolean`)

    if (configId === EFFORT_CONFIG_ID) {
      const current = scope.selection.current
      if (current === undefined) throw new ConfigRejected('no model is selected yet')
      if (value === EFFORT_DEFAULT_VALUE) {
        scope.selection.current = { provider: current.provider, model: current.model }
        return true
      }
      const info = await llm.resolveModelInfo(current.provider, current.model)
      if (!(info.reasoning?.efforts ?? []).some(effort => effort.id === value)) {
        throw new ConfigRejected(`model "${current.model}" has no reasoning effort "${value}"`)
      }
      scope.selection.current = { provider: current.provider, model: current.model, reasoningEffort: value }
      return true
    }

    const groups = await readModelCatalog(llm, scope.warn)
    const resolved = resolveModelValue(groups, value)
    if (resolved === undefined) throw new ConfigRejected(`unknown model: ${value}`)
    const info = await llm.resolveModelInfo(resolved.provider, resolved.model)
    const refusal = modelRefusalReason(info, sessionHasImage(scope.session), resolved.model)
    if (refusal !== undefined) throw new ConfigRejected(refusal)
    // The effort is model-owned, so it does not survive a route change: an id
    // the new model never declared would be rejected by the adapter mid-turn.
    const carried = scope.selection.current?.reasoningEffort
    const keep = carried !== undefined && (info.reasoning?.efforts ?? []).some(effort => effort.id === carried)
    scope.selection.current = {
      provider: resolved.provider,
      model: resolved.model,
      ...keep ? { reasoningEffort: carried } : {},
    }
    return true
  },
}

const providers: SessionConfigProvider[] = [modelConfigProvider]

/**
 * Register an additional config contributor.
 *
 * A registry rather than a switch so a deployment can publish its own
 * selectors — a permission preset, a sandbox toggle — without editing the
 * bridge. Later registrations are consulted after earlier ones.
 *
 * @param provider - the contributor to add.
 * @returns a disposer restoring the previous roster.
 */
export function registerSessionConfig(provider: SessionConfigProvider): () => void {
  providers.push(provider)
  return () => {
    const index = providers.indexOf(provider)
    if (index >= 0) providers.splice(index, 1)
  }
}

/**
 * Every selector this session currently publishes.
 * @param scope - the session being configured.
 * @returns options in contributor registration order.
 */
export async function listSessionConfigOptions(scope: SessionConfigScope): Promise<SessionConfigOption[]> {
  const out: SessionConfigOption[] = []
  for (const provider of providers) {
    try {
      out.push(...await provider.options(scope))
    } catch (error) {
      scope.warn(`acp-rich: a config contributor failed and was skipped: ${String(error)}`)
    }
  }
  return out
}

/**
 * Route a `session/set_config_option` to its owning contributor.
 * @param scope - the session being configured.
 * @param configId - the selector the client wrote.
 * @param value - the selected value.
 * @throws {ConfigRejected} when no contributor owns the id, or the value is bad.
 */
export async function applySessionConfigOption(
  scope: SessionConfigScope,
  configId: string,
  value: string | boolean,
): Promise<void> {
  for (const provider of providers) {
    if (await provider.apply(scope, configId, value)) return
  }
  throw new ConfigRejected(`unknown config option: ${configId}`)
}
