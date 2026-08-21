/**
 * Ask a provider endpoint which models it serves, so a configuration surface
 * does not make the user type them one at a time.
 *
 * The harness already owns this: `ctx.llm.discoverModels(ns, request)` reaches
 * `dsh-llm-pi-ai`'s registered discovery, which answers a route pi-ai ships a
 * catalog for *from that catalog* (no network at all) and interrogates only a
 * route it does not describe — a gateway, a self-hosted server. This module
 * adds no discovery of its own; it only makes that answer reachable from a
 * process that is not cordis.
 *
 * Two harness behaviours are load-bearing here and must not be papered over:
 *
 * - Only `openai-completions` and `openai-responses` have a listing shape a
 *   gateway, a self-hosted server and the official endpoints all agree on.
 *   Every other protocol answers `DISCOVERY_UNSUPPORTED`, and the right
 *   response to that is to fall back to hand-entry — not to guess a shape and
 *   report an authentication failure as "this provider has no models".
 * - A listing is *candidate* metadata for a draft the user is still editing.
 *   Nothing here is stored, and `settings.yaml` remains the only thing that
 *   decides what a route serves.
 *
 * The request arrives through the environment rather than argv because it can
 * carry a one-shot API key, and argv is world-readable through `ps`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { waitForProviders, type SettleOptions } from './capabilities.js'
import type {
  HarnessDiscoveredModel,
  HarnessDiscoveryRequest,
  HarnessLlmService,
} from './config.js'

export const name = 'smelt-model-discovery'

/** `ctx.llm` is the whole point; without it there is nothing to ask. */
export const inject = ['llm']

/** Names the file the report is written to. Absent means misinvocation. */
export const OUTPUT_PATH_ENV = 'SMELT_MODEL_DISCOVERY_OUT'

/** Carries the request JSON. In the environment because it may hold a key. */
export const REQUEST_ENV = 'SMELT_MODEL_DISCOVERY_REQUEST'

/**
 * Settings namespace that owns provider routes, and therefore their discovery.
 *
 * `dsh-llm-pi-ai` registers under this exact string; the harness keys its
 * discovery registry by it and answers `NO_DISCOVERY` for anything else.
 */
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/** The whole report: the models the endpoint advertised, in endpoint order. */
export interface DiscoveryReport {
  models: HarnessDiscoveredModel[]
}

/**
 * Read the request, rejecting one that names nothing to ask about.
 *
 * The harness makes the same check, but failing here keeps the reason legible:
 * an empty draft is a caller bug, not an endpoint that refused us.
 */
export function parseRequest(raw: string | undefined): HarnessDiscoveryRequest {
  const text = raw?.trim()
  if (text === undefined || text === '') throw new Error(`${REQUEST_ENV} is required`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${REQUEST_ENV} is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${REQUEST_ENV} must be a JSON object`)
  }
  const draft = parsed as Record<string, unknown>
  const request: HarnessDiscoveryRequest = {}
  for (const key of ['provider', 'baseURL', 'api', 'apiKey'] as const) {
    const value = draft[key]
    // An empty string is the same as "not supplied": the surface sends whatever
    // is in the box, and a blank box must not become a blank baseURL that the
    // harness then treats as an endpoint.
    if (typeof value === 'string' && value.trim() !== '') request[key] = value.trim()
  }
  if (request.provider === undefined && request.baseURL === undefined) {
    throw new Error('discovery needs a provider route or a baseURL')
  }
  return request
}

/**
 * Ask the harness.
 *
 * Waits for the provider catalog to settle first, and not only because the
 * discovery registration itself arrives with `dsh-llm-pi-ai`: the credential a
 * configured route already stored is read from that same plugin's profile map.
 * Asking too early reaches the endpoint unauthenticated and reports a 401 as
 * though the user's key were wrong — observed, not hypothesised.
 */
export async function discover(
  llm: HarnessLlmService,
  request: HarnessDiscoveryRequest,
  options: SettleOptions = {},
): Promise<DiscoveryReport> {
  await waitForProviders(llm, options)
  if (llm.discoverModels === undefined) {
    throw new Error('this harness build exposes no model discovery; enter models by hand')
  }
  const models = await llm.discoverModels(PI_AI_NAMESPACE, request)
  return { models: [...models] }
}

/** Minimally-typed cordis context: this module programs against services. */
export interface DiscoveryContext {
  get: (name: string) => unknown
}

/**
 * Boot as a one-shot query.
 *
 * Same shape as the capability probe: an overlay disables every output host,
 * so this process exists only to answer one question and exiting is the
 * completion signal.
 */
export function apply(ctx: DiscoveryContext, options: SettleOptions = {}): void {
  void (async () => {
    let code = 0
    try {
      const destination = process.env[OUTPUT_PATH_ENV]?.trim()
      if (destination === undefined || destination === '') {
        throw new Error(`${OUTPUT_PATH_ENV} is required`)
      }
      const request = parseRequest(process.env[REQUEST_ENV])
      const llm = ctx.get('llm') as HarnessLlmService | undefined
      if (llm === undefined) throw new Error('harness exposes no llm service')
      const report = await discover(llm, request, options)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, JSON.stringify(report), 'utf8')
    } catch (error) {
      process.stderr.write(`${name}: ${String(error)}\n`)
      code = 70
    }
    process.exit(code)
  })()
}
