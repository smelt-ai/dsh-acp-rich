/**
 * The discovery bridge's contract.
 *
 * Two rules carry the weight here, both learned from the harness rather than
 * invented:
 *
 * - The catalog must settle *before* the ask. The credential a configured
 *   route already stored lives in the same plugin's profile map that registers
 *   the provider routes, so asking early reaches the endpoint unauthenticated
 *   and reports the resulting 401 as though the user's key were wrong. That
 *   was observed against a real gateway, not hypothesised.
 * - A harness build without discovery must degrade to hand-entry, not crash.
 *   `discoverModels` is optional on the service for exactly that reason.
 */
import { describe, it, expect } from 'vitest'
import {
  discover,
  parseRequest,
  inject,
  name,
  OUTPUT_PATH_ENV,
  REQUEST_ENV,
  PI_AI_NAMESPACE,
} from '../src/discovery.ts'
import type { HarnessDiscoveredModel, HarnessLlmService } from '../src/config.ts'

/** No waiting in tests; the settle loop's own timing is covered elsewhere. */
const NO_WAIT = { intervalMs: 0, settleSamples: 1, sleep: async () => {} }

function fakeLlm(options: {
  providers?: string[]
  models?: HarnessDiscoveredModel[]
  error?: string
  omitDiscovery?: boolean
  onCall?: (ns: string, request: unknown, providerCount: number) => void
}): HarnessLlmService {
  const providers = (options.providers ?? ['sub2api']).map(id => ({ id, name: id }))
  const service: HarnessLlmService = {
    listProviders: () => providers,
    listModels: async () => [],
    resolveModelInfo: async () => ({}),
  }
  if (options.omitDiscovery === true) return service
  service.discoverModels = async (ns, request) => {
    options.onCall?.(ns, request, providers.length)
    if (options.error !== undefined) throw new Error(options.error)
    return options.models ?? []
  }
  return service
}

describe('plugin shape', () => {
  it('injects llm and names the channels the launcher drives', () => {
    expect(name).toBe('smelt-model-discovery')
    expect(inject).toEqual(['llm'])
    expect(OUTPUT_PATH_ENV).toBe('SMELT_MODEL_DISCOVERY_OUT')
    expect(REQUEST_ENV).toBe('SMELT_MODEL_DISCOVERY_REQUEST')
  })

  /// The harness keys its discovery registry by this exact string and answers
  /// NO_DISCOVERY for anything else, so a typo here is a silent dead end.
  it('asks the namespace that owns provider routes', () => {
    expect(PI_AI_NAMESPACE).toBe('llm-pi-ai')
  })
})

describe('parseRequest', () => {
  it('keeps the fields the harness understands', () => {
    expect(
      parseRequest('{"provider":"sub2api","baseURL":"https://g.example/v1","api":"openai-responses","apiKey":"sk-x"}'),
    ).toEqual({
      provider: 'sub2api',
      baseURL: 'https://g.example/v1',
      api: 'openai-responses',
      apiKey: 'sk-x',
    })
  })

  /// The surface sends whatever is in the box. A blank box must not become a
  /// blank baseURL that the harness then treats as an endpoint to interrogate.
  it('treats a blank field as not supplied', () => {
    expect(parseRequest('{"provider":"sub2api","baseURL":"   ","apiKey":""}')).toEqual({
      provider: 'sub2api',
    })
  })

  it('trims a pasted value', () => {
    expect(parseRequest('{"baseURL":"  https://g.example/v1  "}')).toEqual({
      baseURL: 'https://g.example/v1',
    })
  })

  /// Failing here rather than at the harness keeps the reason legible: an
  /// empty draft is a caller bug, not an endpoint that refused us.
  it('refuses a request that names nothing to ask about', () => {
    expect(() => parseRequest('{}')).toThrow(/provider route or a baseURL/)
    expect(() => parseRequest('{"api":"openai-completions"}')).toThrow(/provider route or a baseURL/)
  })

  it('refuses input that is missing, unparseable, or not an object', () => {
    expect(() => parseRequest(undefined)).toThrow(new RegExp(REQUEST_ENV))
    expect(() => parseRequest('   ')).toThrow(new RegExp(REQUEST_ENV))
    expect(() => parseRequest('not json')).toThrow(/not valid JSON/)
    expect(() => parseRequest('[]')).toThrow(/must be a JSON object/)
    expect(() => parseRequest('"text"')).toThrow(/must be a JSON object/)
  })

  it('ignores fields the harness does not read', () => {
    expect(parseRequest('{"baseURL":"https://g.example/v1","models":["a"],"junk":1}')).toEqual({
      baseURL: 'https://g.example/v1',
    })
  })
})

describe('discover', () => {
  it('relays the models the endpoint advertised, in endpoint order', async () => {
    const models = [
      { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' },
      { id: 'glm-5.2', contextWindow: 128_000, maxTokens: 8192 },
    ]
    const report = await discover(fakeLlm({ models }), { provider: 'sub2api' }, NO_WAIT)
    expect(report.models).toEqual(models)
  })

  it('passes the request through under the pi-ai namespace', async () => {
    let seen: { ns?: string, request?: unknown } = {}
    const llm = fakeLlm({ onCall: (ns, request) => { seen = { ns, request } } })
    await discover(llm, { baseURL: 'https://g.example/v1', api: 'openai-responses' }, NO_WAIT)
    expect(seen.ns).toBe(PI_AI_NAMESPACE)
    expect(seen.request).toEqual({ baseURL: 'https://g.example/v1', api: 'openai-responses' })
  })

  /// This is the assertion that encodes the 401 we actually hit: the stored
  /// credential is only reachable once the routes that own it have registered.
  it('waits for the provider catalog before asking', async () => {
    const registered: string[] = []
    let providerCount = 0
    const llm: HarnessLlmService = {
      listProviders: () => {
        // Routes trickle in as their plugins load, exactly as in a real boot.
        if (providerCount < 2) providerCount += 1
        return Array.from({ length: providerCount }, (_, index) => ({
          id: `route-${index}`,
          name: `route-${index}`,
        }))
      },
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      discoverModels: async () => {
        registered.push(`asked with ${providerCount} routes`)
        return []
      },
    }
    await discover(llm, { provider: 'route-0' }, {
      intervalMs: 0,
      settleSamples: 3,
      sleep: async () => {},
    })
    expect(registered).toEqual(['asked with 2 routes'])
  })

  /// A build without discovery is a supported state; the surface falls back to
  /// hand-entry. Crashing would make an older harness look broken instead.
  it('says so plainly when the harness has no discovery', async () => {
    await expect(
      discover(fakeLlm({ omitDiscovery: true }), { provider: 'sub2api' }, NO_WAIT),
    ).rejects.toThrow(/no model discovery/)
  })

  /// DISCOVERY_UNSUPPORTED and a refused endpoint both arrive this way. The
  /// reason must survive: it is what tells the user to enter models by hand,
  /// or to check the key.
  it('lets the harness reason reach the caller', async () => {
    await expect(
      discover(
        fakeLlm({ error: 'pi-ai protocol "anthropic-messages" has no model listing' }),
        { baseURL: 'https://g.example/v1', api: 'anthropic-messages' },
        NO_WAIT,
      ),
    ).rejects.toThrow(/has no model listing/)
  })

  it('reports an endpoint that advertises nothing as empty, not as a failure', async () => {
    const report = await discover(fakeLlm({ models: [] }), { provider: 'sub2api' }, NO_WAIT)
    expect(report.models).toEqual([])
  })
})
