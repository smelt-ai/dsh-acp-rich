/**
 * Session config option mapping.
 *
 * These cover the pure projection and the routing rules; `bridge.spec.ts`
 * proves the same machinery over the real wire.
 */

import { describe, expect, it } from 'vitest'
import {
  applySessionConfigOption,
  buildEffortOption,
  buildModelOption,
  ConfigRejected,
  EFFORT_CONFIG_ID,
  EFFORT_DEFAULT_VALUE,
  listSessionConfigOptions,
  MODEL_CONFIG_ID,
  modelRefusalReason,
  modelValueId,
  readModelCatalog,
  registerSessionConfig,
  resolveModelValue,
  sessionHasImage,
  type HarnessLlmService,
  type HarnessModelSelectionRef,
  type ModelCatalogGroup,
  type SessionConfigScope,
} from '../src/config.ts'
import type { HarnessSession, HarnessSessionEvent } from '../src/harness.ts'

const GROUPS: ModelCatalogGroup[] = [
  {
    provider: { id: 'deepseek', name: 'DeepSeek' },
    models: [
      { provider: 'deepseek', id: 'deepseek-chat', name: 'Chat', description: 'general' },
      { provider: 'deepseek', id: 'deepseek-reasoner', name: 'Reasoner' },
    ],
  },
  {
    provider: { id: 'pi', name: 'Pi' },
    models: [{ provider: 'pi', id: 'pi/one', name: 'Pi One' }],
  },
]

function session(events: HarnessSessionEvent[] = []): HarnessSession {
  return { header: { id: 's1' }, events }
}

function userMessage(content: unknown[]): HarnessSessionEvent {
  return { type: 'user/message', seq: 1, time: 1, data: { message: { content } } }
}

function scope(overrides: Partial<SessionConfigScope> = {}): SessionConfigScope {
  const selection: HarnessModelSelectionRef = { current: undefined, assembled: undefined }
  return {
    sessionId: 's1',
    session: session(),
    selection,
    llm: undefined,
    warn: () => {},
    ...overrides,
  }
}

/** A catalog service over {@link GROUPS}. */
function llmService(overrides: Partial<HarnessLlmService> = {}): HarnessLlmService {
  return {
    listProviders: () => GROUPS.map(group => group.provider),
    listModels: async provider =>
      GROUPS.find(group => group.provider.id === provider)?.models ?? [],
    resolveModelInfo: async (_provider, model) =>
      model === 'deepseek-reasoner'
        ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
        : {},
    ...overrides,
  }
}

describe('buildModelOption', () => {
  it('groups models by provider and tags the model category', () => {
    const option = buildModelOption(GROUPS, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(option).toBeDefined()
    expect(option?.category).toBe('model')
    expect(option?.id).toBe(MODEL_CONFIG_ID)
    expect(option?.type).toBe('select')
    const select = option as { currentValue: string; options: { group: string; options: unknown[] }[] }
    expect(select.currentValue).toBe('deepseek/deepseek-chat')
    expect(select.options.map(group => group.group)).toEqual(['deepseek', 'pi'])
  })

  it('carries a model description through to the option', () => {
    const option = buildModelOption(GROUPS, { provider: 'deepseek', model: 'deepseek-chat' })
    const groups = (option as { options: { options: { value: string; description?: string }[] }[] }).options
    const chat = groups[0]?.options.find(entry => entry.value === 'deepseek/deepseek-chat')
    expect(chat?.description).toBe('general')
  })

  it('keeps an unlisted current selection visible', () => {
    // Catalog membership is advisory: a route still dispatches a model it
    // stopped advertising, and dropping it would show some other model as
    // current.
    const option = buildModelOption(GROUPS, { provider: 'deepseek', model: 'retired' })
    const select = option as { currentValue: string; options: { options: { value: string }[] }[] }
    expect(select.currentValue).toBe('deepseek/retired')
    const values = select.options.flatMap(group => group.options.map(entry => entry.value))
    expect(values).toContain('deepseek/retired')
  })

  it('publishes nothing when no provider advertises a model', () => {
    expect(buildModelOption([], { provider: 'deepseek', model: 'x' })).toBeUndefined()
  })
})

describe('buildEffortOption', () => {
  it('prepends a provider-default value ahead of the named efforts', () => {
    const option = buildEffortOption(
      { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
      undefined,
    )
    const select = option as { currentValue: string; options: { value: string }[] }
    expect(option?.category).toBe('thought_level')
    expect(select.options.map(entry => entry.value)).toEqual([EFFORT_DEFAULT_VALUE, 'low'])
    expect(select.currentValue).toBe(EFFORT_DEFAULT_VALUE)
  })

  it('falls back to the default value when the selected effort is gone', () => {
    const option = buildEffortOption(
      { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
      'extreme',
    )
    expect((option as { currentValue: string }).currentValue).toBe(EFFORT_DEFAULT_VALUE)
  })

  it('publishes no selector for a model without efforts', () => {
    expect(buildEffortOption({}, undefined)).toBeUndefined()
    expect(buildEffortOption({ reasoning: { efforts: [] } }, undefined)).toBeUndefined()
  })
})

describe('resolveModelValue', () => {
  it('resolves a model id that itself contains a separator', () => {
    // A split on '/' would route to provider "pi", model "one".
    expect(resolveModelValue(GROUPS, modelValueId('pi', 'pi/one')))
      .toEqual({ provider: 'pi', model: 'pi/one' })
  })

  it('refuses an id the catalog does not carry', () => {
    expect(resolveModelValue(GROUPS, 'deepseek/nope')).toBeUndefined()
  })
})

describe('readModelCatalog', () => {
  it('drops a failing provider without losing the sound ones', async () => {
    const warnings: string[] = []
    const groups = await readModelCatalog(
      llmService({
        listModels: async provider => {
          if (provider === 'pi') throw new Error('route is down')
          return GROUPS[0]?.models ?? []
        },
      }),
      message => warnings.push(message),
    )
    expect(groups.map(group => group.provider.id)).toEqual(['deepseek'])
    expect(warnings.join()).toContain('pi')
  })

  it('drops a provider that advertises nothing', async () => {
    const groups = await readModelCatalog(llmService({ listModels: async () => [] }), () => {})
    expect(groups).toEqual([])
  })
})

describe('sessionHasImage / modelRefusalReason', () => {
  it('finds an image in a logged user message', () => {
    expect(sessionHasImage(session([userMessage([{ type: 'image', data: 'x' }])]))).toBe(true)
    expect(sessionHasImage(session([userMessage([{ type: 'text', text: 'hi' }])]))).toBe(false)
  })

  it('allows an adapter that declares no modalities', () => {
    // Absent is unknown, not text-only; refusing would block every route that
    // has not adopted the field.
    expect(modelRefusalReason({}, true, 'm')).toBeUndefined()
  })

  it('refuses an explicit modality list that omits image', () => {
    expect(modelRefusalReason({ inputModalities: ['text'] }, true, 'm')).toContain('image')
    expect(modelRefusalReason({ inputModalities: ['text'] }, false, 'm')).toBeUndefined()
    expect(modelRefusalReason({ inputModalities: ['text', 'image'] }, true, 'm')).toBeUndefined()
  })
})

describe('listSessionConfigOptions', () => {
  it('publishes nothing until the session route is known', async () => {
    const options = await listSessionConfigOptions(scope({ llm: llmService() }))
    expect(options).toEqual([])
  })

  it('publishes model alone for a model without efforts', async () => {
    const options = await listSessionConfigOptions(scope({
      llm: llmService(),
      selection: { current: { provider: 'deepseek', model: 'deepseek-chat' }, assembled: undefined },
    }))
    expect(options.map(option => option.id)).toEqual([MODEL_CONFIG_ID])
  })

  it('adds the effort selector for a model that declares efforts', async () => {
    const options = await listSessionConfigOptions(scope({
      llm: llmService(),
      selection: { current: { provider: 'deepseek', model: 'deepseek-reasoner' }, assembled: undefined },
    }))
    expect(options.map(option => option.id)).toEqual([MODEL_CONFIG_ID, EFFORT_CONFIG_ID])
  })

  it('keeps the model picker when the effort lookup fails', async () => {
    const warnings: string[] = []
    const options = await listSessionConfigOptions(scope({
      llm: llmService({ resolveModelInfo: async () => { throw new Error('nope') } }),
      selection: { current: { provider: 'deepseek', model: 'deepseek-reasoner' }, assembled: undefined },
      warn: message => warnings.push(message),
    }))
    expect(options.map(option => option.id)).toEqual([MODEL_CONFIG_ID])
    expect(warnings.join()).toContain('reasoning efforts')
  })

  it('publishes nothing without a catalog service', async () => {
    expect(await listSessionConfigOptions(scope({
      selection: { current: { provider: 'deepseek', model: 'deepseek-chat' }, assembled: undefined },
    }))).toEqual([])
  })
})

describe('applySessionConfigOption', () => {
  const withModel = (model: string, extra: Partial<SessionConfigScope> = {}): SessionConfigScope =>
    scope({
      llm: llmService(),
      selection: { current: { provider: 'deepseek', model }, assembled: undefined },
      ...extra,
    })

  it('writes the selected model into the cell', async () => {
    const target = withModel('deepseek-chat')
    await applySessionConfigOption(target, MODEL_CONFIG_ID, 'deepseek/deepseek-reasoner')
    expect(target.selection.current).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  it('drops a reasoning effort the new model never declared', async () => {
    const target = scope({
      llm: llmService(),
      selection: {
        current: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
        assembled: undefined,
      },
    })
    await applySessionConfigOption(target, MODEL_CONFIG_ID, 'deepseek/deepseek-chat')
    expect(target.selection.current).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('carries a reasoning effort the new model still declares', async () => {
    const target = scope({
      llm: llmService({
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
      }),
      selection: {
        current: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
        assembled: undefined,
      },
    })
    await applySessionConfigOption(target, MODEL_CONFIG_ID, 'deepseek/deepseek-chat')
    expect(target.selection.current?.reasoningEffort).toBe('high')
  })

  it('refuses a text-only model for a session that already carries images', async () => {
    const target = scope({
      llm: llmService({ resolveModelInfo: async () => ({ inputModalities: ['text'] }) }),
      session: session([userMessage([{ type: 'image', data: 'x' }])]),
      selection: { current: { provider: 'deepseek', model: 'deepseek-reasoner' }, assembled: undefined },
    })
    await expect(applySessionConfigOption(target, MODEL_CONFIG_ID, 'deepseek/deepseek-chat'))
      .rejects.toThrow(/image/)
    expect(target.selection.current?.model).toBe('deepseek-reasoner')
  })

  it('refuses an unknown model id', async () => {
    await expect(applySessionConfigOption(withModel('deepseek-chat'), MODEL_CONFIG_ID, 'deepseek/ghost'))
      .rejects.toBeInstanceOf(ConfigRejected)
  })

  it('sets and clears the reasoning effort', async () => {
    const target = withModel('deepseek-reasoner')
    await applySessionConfigOption(target, EFFORT_CONFIG_ID, 'high')
    expect(target.selection.current?.reasoningEffort).toBe('high')
    await applySessionConfigOption(target, EFFORT_CONFIG_ID, EFFORT_DEFAULT_VALUE)
    expect(target.selection.current?.reasoningEffort).toBeUndefined()
  })

  it('refuses an effort the selected model does not declare', async () => {
    await expect(applySessionConfigOption(withModel('deepseek-reasoner'), EFFORT_CONFIG_ID, 'extreme'))
      .rejects.toBeInstanceOf(ConfigRejected)
  })

  it('refuses a boolean value for a select option', async () => {
    await expect(applySessionConfigOption(withModel('deepseek-chat'), MODEL_CONFIG_ID, true))
      .rejects.toBeInstanceOf(ConfigRejected)
  })

  it('refuses an id no contributor owns', async () => {
    await expect(applySessionConfigOption(withModel('deepseek-chat'), 'sandbox', 'off'))
      .rejects.toThrow(/unknown config option/)
  })
})

describe('registerSessionConfig', () => {
  it('lets a deployment publish its own selector and take it back', async () => {
    const target = scope({
      llm: llmService(),
      selection: { current: { provider: 'deepseek', model: 'deepseek-chat' }, assembled: undefined },
    })
    let value = false
    const restore = registerSessionConfig({
      options: async () => [{
        type: 'boolean', id: 'sandbox', name: 'Sandbox', currentValue: value,
      }],
      apply: async (_scope, configId, next) => {
        if (configId !== 'sandbox') return false
        value = next === true
        return true
      },
    })
    try {
      expect((await listSessionConfigOptions(target)).map(option => option.id))
        .toEqual([MODEL_CONFIG_ID, 'sandbox'])
      await applySessionConfigOption(target, 'sandbox', true)
      expect(value).toBe(true)
    } finally {
      restore()
    }
    expect((await listSessionConfigOptions(target)).map(option => option.id)).toEqual([MODEL_CONFIG_ID])
  })

  it('skips a contributor that throws while listing', async () => {
    const warnings: string[] = []
    const target = scope({
      llm: llmService(),
      selection: { current: { provider: 'deepseek', model: 'deepseek-chat' }, assembled: undefined },
      warn: message => warnings.push(message),
    })
    const restore = registerSessionConfig({
      options: async () => { throw new Error('broken') },
      apply: async () => false,
    })
    try {
      expect((await listSessionConfigOptions(target)).map(option => option.id)).toEqual([MODEL_CONFIG_ID])
      expect(warnings.join()).toContain('contributor')
    } finally {
      restore()
    }
  })
})
