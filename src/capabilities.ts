/**
 * Publish the harness model catalog — and each model's *real* reasoning
 * efforts — to a file that a non-cordis caller can read.
 *
 * Why a whole dsh boot for what looks like static data: reasoning efforts are
 * not static. `resolveModelInfo` answers for a *resolved route*, so the same
 * model id reports four efforts through one connection and none through
 * another (a connection pinned to `thinking: disabled` collapses to `off`, and
 * relay/proxy routes commonly advertise no reasoning control at all). Only the
 * assembled runtime knows which case a profile is in, so the query has to run
 * inside it.
 *
 * The contract this exists to preserve: **an absent `efforts` means the route
 * has no reasoning knob, and the caller must render no picker.** It must never
 * be substituted with a default list — that is exactly the hardcoding this
 * module replaces, and it is what lets a UI offer `max` on a route that fails
 * every request made with it.
 *
 * Output goes to a file named by `SMELT_MODEL_CAPABILITIES_OUT` rather than to
 * stdout: this runs as a plugin inside a full dsh process, and stdout there is
 * shared with whatever else the profile still has enabled. A file is the only
 * channel this module can claim exclusively.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HarnessEffortInfo, HarnessLlmService } from './config.js'

export const name = 'smelt-model-capabilities'

/** `ctx.llm` is the whole point; without it there is nothing to report. */
export const inject = ['llm']

/** Names the file the report is written to. Absent means misinvocation. */
export const OUTPUT_PATH_ENV = 'SMELT_MODEL_CAPABILITIES_OUT'

/**
 * One model row.
 *
 * `efforts` is optional on purpose and is omitted — not emptied — when the
 * route advertises no reasoning control, mirroring `resolveModelInfo`, which
 * omits `reasoning` entirely in that case.
 */
export interface ModelCapabilities {
  id: string
  name: string
  efforts?: readonly HarnessEffortInfo[]
  defaultEffort?: string
  /** Set when this single model failed to resolve; the row is still reported. */
  error?: string
}

/** One provider route and the models it advertises. */
export interface ProviderCapabilities {
  id: string
  name: string
  models: ModelCapabilities[]
  /** Set when the route failed to list models at all. */
  error?: string
}

/** The whole report. */
export interface CapabilitiesReport {
  providers: ProviderCapabilities[]
}

/** Injectable clock, so the settle loop is testable without real waiting. */
export interface SettleOptions {
  intervalMs?: number
  settleSamples?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const DEFAULT_INTERVAL_MS = 50
const DEFAULT_SETTLE_SAMPLES = 6
const DEFAULT_TIMEOUT_MS = 10_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Wait until the provider list stops growing.
 *
 * Provider routes register as their plugins load, so reading the catalog the
 * moment `llm` becomes injectable reports whatever happened to be registered
 * first — in a real profile that is an empty list a few hundred milliseconds
 * before the true one. There is no "catalog complete" event to wait for, so
 * this samples until the count holds steady across `settleSamples` reads.
 *
 * Timing out is not an error: a profile with no routes configured is a valid
 * state that simply never settles above zero, and reporting an empty catalog
 * is the correct answer for it.
 */
export async function waitForProviders(
  llm: HarnessLlmService,
  options: SettleOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const settleSamples = options.settleSamples ?? DEFAULT_SETTLE_SAMPLES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const startedAt = now()
  let previous = -1
  let stable = 0
  for (;;) {
    const count = llm.listProviders().length
    if (count > 0 && count === previous) stable += 1
    else stable = 0
    previous = count
    if (stable >= settleSamples) return
    if (now() - startedAt >= timeoutMs) return
    await sleep(intervalMs)
  }
}

/**
 * Read every advertised model's capabilities.
 *
 * Failures are contained to the row that produced them — one dead route must
 * not blank the picker for the healthy ones. A route that throws while listing
 * is reported with its error and no models; a model that throws while
 * resolving is reported with its error and, crucially, *no* efforts, which the
 * caller reads as "no picker" rather than as a default list.
 */
export async function collectCapabilities(
  llm: HarnessLlmService,
): Promise<CapabilitiesReport> {
  const providers: ProviderCapabilities[] = []
  for (const provider of llm.listProviders()) {
    const entry: ProviderCapabilities = { id: provider.id, name: provider.name, models: [] }
    let models: readonly { id: string, name: string }[] = []
    try {
      models = await llm.listModels(provider.id)
    } catch (error) {
      entry.error = String(error)
      providers.push(entry)
      continue
    }
    for (const model of models) {
      const row: ModelCapabilities = { id: model.id, name: model.name }
      try {
        const info = await llm.resolveModelInfo(provider.id, model.id)
        const efforts = info?.reasoning?.efforts
        if (efforts !== undefined && efforts.length > 0) {
          row.efforts = efforts satisfies readonly HarnessEffortInfo[]
          const fallback = info?.reasoning?.defaultEffort
          if (fallback !== undefined) row.defaultEffort = fallback
        }
      } catch (error) {
        row.error = String(error)
      }
      entry.models.push(row)
    }
    providers.push(entry)
  }
  return { providers }
}

/** Minimally-typed cordis context: this module programs against services. */
export interface CapabilitiesContext {
  get: (name: string) => unknown
}

/**
 * Boot as a one-shot query.
 *
 * This plugin is loaded by an overlay that disables every output host, so the
 * process exists only to answer this question and exiting is the completion
 * signal. `process.exit` is deliberate: cordis has no "run to completion" mode,
 * and leaving the runtime alive would hang the caller waiting on a process
 * whose work is already done.
 */
export function apply(ctx: CapabilitiesContext, options: SettleOptions = {}): void {
  void (async () => {
    let code = 0
    try {
      const destination = process.env[OUTPUT_PATH_ENV]?.trim()
      if (destination === undefined || destination === '') {
        throw new Error(`${OUTPUT_PATH_ENV} is required`)
      }
      const llm = ctx.get('llm') as HarnessLlmService | undefined
      if (llm === undefined) throw new Error('harness exposes no llm service')
      await waitForProviders(llm, options)
      const report = await collectCapabilities(llm)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, JSON.stringify(report), 'utf8')
    } catch (error) {
      process.stderr.write(`${name}: ${String(error)}\n`)
      code = 70
    }
    process.exit(code)
  })()
}
