import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const helper = new URL('../bin/dsh-model-settings.mjs', import.meta.url)
let home: string | undefined

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function run(action: 'read' | 'save' | 'save-custom' | 'delete-custom', payload?: object) {
  const args = [helper.pathname, '--action', action]
  return {
    args,
    result: spawnSync(process.execPath, args, {
      env: { ...process.env, DSH_HOME: home },
      input: payload === undefined ? undefined : JSON.stringify(payload),
      encoding: 'utf8',
    }),
  }
}

describe('native model settings editor', () => {
  it('reads and minimally updates native YAML settings and the write-only credential', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-model-settings-'))
    const settingsPath = join(home, 'settings.yaml')
    const credentialsPath = join(home, '.credentials.yaml')
    writeFileSync(
      settingsPath,
      '# keep this comment\nui-onboarding:\n  welcomeNoticeVersion: current\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n  reasoningEffort: max\n',
    )
    writeFileSync(credentialsPath, 'OTHER_KEY: preserved\n')

    const { args, result } = run('save', {
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      apiKey: 'new-secret',
    })

    expect(result.status).toBe(0)
    expect(args).not.toContain('new-secret')
    const settingsRaw = readFileSync(settingsPath, 'utf8')
    expect(settingsRaw).toContain('# keep this comment')
    expect(parse(settingsRaw)).toMatchObject({
      'ui-onboarding': { welcomeNoticeVersion: 'current' },
      'agent-default-model': {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      },
      'llm-deepseek': {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://gateway.example/v1',
        thinking: 'enabled',
        reasoningEffort: 'high',
      },
    })
    expect(parse(readFileSync(credentialsPath, 'utf8'))).toEqual({
      OTHER_KEY: 'preserved',
      DEEPSEEK_API_KEY: 'new-secret',
    })
    if (process.platform !== 'win32') {
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600)
    }

    const read = run('read').result
    expect(read.status).toBe(0)
    expect(JSON.parse(read.stdout)).toMatchObject({
      defaultModel: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      },
      deepseek: {
        baseURL: 'https://gateway.example/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        reasoningEffort: 'high',
      },
      credentialConfigured: true,
    })
    expect(read.stdout).not.toContain('new-secret')
  })

  it('rejects an invalid endpoint without replacing the settings document', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-model-settings-'))
    const settingsPath = join(home, 'settings.yaml')
    const original = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    writeFileSync(settingsPath, original)

    const { result } = run('save', {
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      baseURL: 'not a URL',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })

    expect(result.status).not.toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toBe(original)
  })

  it('creates, reads, and removes a custom provider without exposing its credential', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-model-settings-'))
    const settingsPath = join(home, 'settings.yaml')
    const credentialsPath = join(home, '.credentials.yaml')
    writeFileSync(settingsPath, 'ui-onboarding:\n  welcomeNoticeVersion: current\n')

    const saved = run('save-custom', {
      id: 'acme-gateway',
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
      apiKey: 'custom-secret',
      setDefault: true,
      models: [{
        id: 'acme-large',
        name: 'Acme Large',
        contextWindow: 65536,
        maxTokens: 4096,
      }],
    }).result

    expect(saved.status, saved.stderr).toBe(0)
    expect(parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
      'agent-default-model': { provider: 'acme-gateway', model: 'acme-large' },
      'llm-pi-ai': {
        providers: {
          'acme-gateway': {
            displayName: 'Acme Gateway',
            apiKeyEnv: 'ACME_GATEWAY_API_KEY',
            api: 'openai-completions',
            baseURL: 'https://gateway.example/v1',
            models: [{
              id: 'acme-large',
              name: 'Acme Large',
              contextWindow: 65536,
              maxTokens: 4096,
            }],
          },
        },
      },
    })
    expect(parse(readFileSync(credentialsPath, 'utf8'))).toEqual({
      ACME_GATEWAY_API_KEY: 'custom-secret',
    })

    const read = run('read').result
    expect(read.status, read.stderr).toBe(0)
    expect(JSON.parse(read.stdout)).toMatchObject({
      customProviders: [{
        id: 'acme-gateway',
        displayName: 'Acme Gateway',
        api: 'openai-completions',
        baseURL: 'https://gateway.example/v1',
        apiKeyEnv: 'ACME_GATEWAY_API_KEY',
        credentialConfigured: true,
        models: [{
          id: 'acme-large',
          name: 'Acme Large',
          contextWindow: 65536,
          maxTokens: 4096,
        }],
      }],
    })
    expect(read.stdout).not.toContain('custom-secret')

    const removed = run('delete-custom', { id: 'acme-gateway' }).result
    expect(removed.status, removed.stderr).toBe(0)
    expect(parse(readFileSync(settingsPath, 'utf8'))['llm-pi-ai'].providers).toEqual({})
  })

  it('allows an unauthenticated custom endpoint without inventing a credential reference', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-model-settings-'))
    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, '{}\n')

    const saved = run('save-custom', {
      id: 'local-model',
      displayName: 'Local Model',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: '',
      models: [{ id: 'local-chat' }],
    }).result

    expect(saved.status, saved.stderr).toBe(0)
    expect(parse(readFileSync(settingsPath, 'utf8'))['llm-pi-ai'].providers['local-model'])
      .not.toHaveProperty('apiKeyEnv')
    const read = run('read').result
    expect(JSON.parse(read.stdout).customProviders[0]).toMatchObject({
      id: 'local-model',
      apiKeyEnv: '',
      credentialConfigured: false,
    })
  })
})
