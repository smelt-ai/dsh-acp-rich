/**
 * The capability probe's contract.
 *
 * The load-bearing assertion in this file is the *absence* one: a model whose
 * route advertises no reasoning must come back with no `efforts` key at all.
 * Everything else here is containment — one broken route or one unresolvable
 * model must not blank the report for its healthy neighbours — but the absence
 * rule is the whole reason the probe exists. A caller that receives a default
 * list where it should have received nothing renders a picker whose options
 * fail every request made with them, which is precisely the hardcoded
 * behaviour this replaces.
 */
import { describe, it, expect } from 'vitest'
import {
  collectCapabilities,
  waitForProviders,
  OUTPUT_PATH_ENV,
  inject,
  name,
} from '../src/capabilities.ts'
import type { HarnessLlmService } from '../src/config.ts'

interface FakeModel {
  id: string
  name: string
  reasoning?: { efforts: { id: string, name: string }[], defaultEffort?: string }
  resolveError?: string
}

function fakeLlm(
  routes: { id: string, name: string, models?: FakeModel[], listError?: string }[],
): HarnessLlmService {
  return {
    listProviders: () => routes.map(route => ({ id: route.id, name: route.name })),
    listModels: async (provider: string) => {
      const route = routes.find(candidate => candidate.id === provider)
      if (route?.listError !== undefined) throw new Error(route.listError)
      return (route?.models ?? []).map(model => ({
        provider,
        id: model.id,
        name: model.name,
      }))
    },
    resolveModelInfo: async (provider: string, model: string) => {
      const found = routes
        .find(route => route.id === provider)
        ?.models
        ?.find(candidate => candidate.id === model)
      if (found?.resolveError !== undefined) throw new Error(found.resolveError)
      return found?.reasoning === undefined ? {} : { reasoning: found.reasoning }
    },
  }
}

describe('capability report', () => {
  it('reports the efforts a route advertises, with its default', async () => {
    const report = await collectCapabilities(fakeLlm([{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-pro',
        name: 'V4 Pro',
        reasoning: {
          efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
          defaultEffort: 'high',
        },
      }],
    }]))

    expect(report.providers).toHaveLength(1)
    const [model] = report.providers[0]!.models
    expect(model!.efforts?.map(effort => effort.id)).toEqual(['off', 'high'])
    expect(model!.defaultEffort).toBe('high')
  })

  it('omits efforts entirely when the route advertises no reasoning', async () => {
    // The real shape this guards: a relay route resolves fine and simply has
    // no `reasoning` field. Reporting `efforts: []` would be tolerable;
    // reporting a default list would not, and neither may appear as a key the
    // caller can mistake for "there is a picker here".
    const report = await collectCapabilities(fakeLlm([{
      id: 'sub2api',
      name: 'Sub2Api',
      models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }],
    }]))

    const [model] = report.providers[0]!.models
    expect(model!.efforts).toBeUndefined()
    expect('efforts' in model!).toBe(false)
    expect(model!.defaultEffort).toBeUndefined()
  })

  it('treats an advertised-but-empty effort list as no picker', async () => {
    const report = await collectCapabilities(fakeLlm([{
      id: 'edge',
      name: 'Edge',
      models: [{ id: 'm', name: 'M', reasoning: { efforts: [], defaultEffort: 'high' } }],
    }]))

    const [model] = report.providers[0]!.models
    expect('efforts' in model!).toBe(false)
    expect(model!.defaultEffort).toBeUndefined()
  })

  it('keeps a model that fails to resolve, but gives it no efforts', async () => {
    const report = await collectCapabilities(fakeLlm([{
      id: 'flaky',
      name: 'Flaky',
      models: [{ id: 'm', name: 'M', resolveError: 'upstream 502' }],
    }]))

    const [model] = report.providers[0]!.models
    expect(model!.error).toContain('upstream 502')
    expect('efforts' in model!).toBe(false)
  })

  it('contains a broken route to itself', async () => {
    const report = await collectCapabilities(fakeLlm([
      { id: 'broken', name: 'Broken', listError: 'no credentials' },
      {
        id: 'healthy',
        name: 'Healthy',
        models: [{
          id: 'm',
          name: 'M',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }] },
        }],
      },
    ]))

    expect(report.providers[0]!.error).toContain('no credentials')
    expect(report.providers[0]!.models).toEqual([])
    expect(report.providers[1]!.models[0]!.efforts).toHaveLength(1)
  })
})

describe('catalog settling', () => {
  it('waits for the provider count to stop growing', async () => {
    // Routes register as their plugins load; reading at first injectability
    // reports the empty list that exists a few hundred milliseconds early.
    const growth = [0, 0, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]
    let read = 0
    const llm = {
      listProviders: () => {
        const count = growth[Math.min(read, growth.length - 1)]!
        read += 1
        return Array.from({ length: count }, (_, index) => ({
          id: `p${index}`,
          name: `P${index}`,
        }))
      },
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    } satisfies HarnessLlmService

    await waitForProviders(llm, {
      intervalMs: 0,
      settleSamples: 3,
      timeoutMs: 1_000,
      sleep: async () => {},
      now: () => 0,
    })

    expect(llm.listProviders()).toHaveLength(2)
  })

  it('returns rather than throwing when nothing ever registers', async () => {
    // A profile with no routes configured is valid and never settles above
    // zero; an empty catalog is the correct answer, not a failure.
    const llm = {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    } satisfies HarnessLlmService

    let clock = 0
    await expect(waitForProviders(llm, {
      intervalMs: 0,
      settleSamples: 3,
      timeoutMs: 10,
      sleep: async () => { clock += 5 },
      now: () => clock,
    })).resolves.toBeUndefined()
  })
})

describe('loader contract', () => {
  it('injects the one service it cannot work without', () => {
    expect(inject).toEqual(['llm'])
  })

  it('names the output variable the launcher sets', () => {
    expect(OUTPUT_PATH_ENV).toBe('SMELT_MODEL_CAPABILITIES_OUT')
    expect(name).toBe('smelt-model-capabilities')
  })
})
