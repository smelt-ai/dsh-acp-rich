#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { Document, parseDocument } from 'yaml'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { action: { type: 'string' } },
  strict: true,
})

const action = values.action
if (!['read', 'save', 'save-custom', 'refresh-models', 'delete-custom'].includes(action)) {
  process.stderr.write('dsh-model-settings: unsupported --action\n')
  process.exit(64)
}

const configuredHome = process.env.DSH_HOME?.trim()
const home = configuredHome === undefined || configuredHome === '' ? join(homedir(), '.dsh') : configuredHome
const settingsPath = await resolveSettingsPath(home)
const credentialsPath = join(home, '.credentials.yaml')

if (action === 'read') {
  const settings = await readSettings(settingsPath)
  const defaultModel = objectAt(settings.value, 'agent-default-model')
  const deepseek = objectAt(settings.value, 'llm-deepseek')
  const customProviders = objectAt(objectAt(settings.value, 'llm-pi-ai'), 'providers')
  const apiKeyEnv = stringAt(deepseek, 'apiKeyEnv') ?? 'DEEPSEEK_API_KEY'
  const credentials = await readYamlObject(credentialsPath)
  process.stdout.write(`${JSON.stringify({
    settingsPath,
    defaultModel: {
      provider: stringAt(defaultModel, 'provider') ?? 'deepseek-official',
      model: stringAt(defaultModel, 'model') ?? 'deepseek-v4-flash',
      reasoningEffort: stringAt(defaultModel, 'reasoningEffort') ?? 'max',
    },
    deepseek: {
      baseURL: stringAt(deepseek, 'baseURL') ?? '',
      apiKeyEnv,
      reasoningEffort: stringAt(deepseek, 'reasoningEffort') ?? 'max',
    },
    credentialConfigured: typeof credentials[apiKeyEnv] === 'string' && credentials[apiKeyEnv].length > 0,
    customProviders: Object.entries(customProviders).flatMap(([id, raw]) => {
      if (!isObject(raw)) return []
      const customApiKeyEnv = stringAt(raw, 'apiKeyEnv') ?? ''
      const rawModels = Array.isArray(raw.models) ? raw.models : []
      return [{
        id,
        displayName: stringAt(raw, 'displayName') ?? id,
        api: stringAt(raw, 'api') ?? '',
        baseURL: stringAt(raw, 'baseURL') ?? '',
        apiKeyEnv: customApiKeyEnv,
        credentialConfigured:
          typeof credentials[customApiKeyEnv] === 'string' && credentials[customApiKeyEnv].length > 0,
        models: rawModels.flatMap(model => {
          if (!isObject(model) || typeof model.id !== 'string' || model.id.trim() === '') return []
          return [{
            id: model.id,
            name: stringAt(model, 'name') ?? '',
            contextWindow: positiveIntegerAt(model, 'contextWindow'),
            maxTokens: positiveIntegerAt(model, 'maxTokens'),
          }]
        }),
      }]
    }),
  })}\n`)
  process.exit(0)
}

const payload = await readJsonInput()
if (action === 'save-custom') {
  const id = requiredProviderId(payload.id)
  const previousId = optionalString(payload.previousId)
  const displayName = optionalString(payload.displayName)
  const api = requiredString(payload.api, 'api')
  const baseURL = requiredHttpUrl(payload.baseURL, 'baseURL')
  const apiKeyEnv = optionalCredentialRef(payload.apiKeyEnv)
  const apiKey = optionalString(payload.apiKey)
  if (apiKey !== undefined && apiKeyEnv === undefined) {
    throw new Error('dsh-model-settings: apiKeyEnv is required when apiKey is provided')
  }
  const models = requiredModels(payload.models)

  const settings = await readSettings(settingsPath)
  if (previousId !== undefined && previousId !== id) {
    settings.delete(['llm-pi-ai', 'providers', previousId])
  }
  settings.set(['llm-pi-ai', 'providers', id], {
    ...(displayName === undefined ? {} : { displayName }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    api,
    baseURL,
    models,
  })
  if (payload.setDefault === true) {
    settings.set(['agent-default-model', 'provider'], id)
    settings.set(['agent-default-model', 'model'], models[0].id)
  }
  await settings.write()
  if (apiKey !== undefined && apiKeyEnv !== undefined) {
    const credentials = await readYamlDocument(credentialsPath)
    credentials.document.setIn([apiKeyEnv], apiKey)
    await writeAtomic(credentialsPath, credentials.document.toString())
  }
  process.stdout.write('{"ok":true}\n')
  process.exit(0)
}

if (action === 'refresh-models') {
  const id = requiredProviderId(payload.id)
  const models = requiredModels(payload.models)
  const settings = await readSettings(settingsPath)
  // Only the `models` key is written. A refresh runs unattended on every
  // launch, and `save-custom` replaces the whole provider node — reusing it
  // here would silently drop `headers`, `timeoutMs`, `reasoning` and every
  // other field a deployment hand-wrote beside the ones this bridge models.
  if (!isObject(objectAt(objectAt(settings.value, 'llm-pi-ai'), 'providers')[id])) {
    throw new Error(`dsh-model-settings: provider "${id}" is not configured`)
  }
  settings.set(['llm-pi-ai', 'providers', id, 'models'], models)
  await settings.write()
  process.stdout.write('{"ok":true}\n')
  process.exit(0)
}

if (action === 'delete-custom') {
  const id = requiredProviderId(payload.id)
  const settings = await readSettings(settingsPath)
  settings.delete(['llm-pi-ai', 'providers', id])
  await settings.write()
  process.stdout.write('{"ok":true}\n')
  process.exit(0)
}

const model = requiredString(payload.model, 'model')
const reasoningEffort = requiredString(payload.reasoningEffort, 'reasoningEffort')
if (!['off', 'low', 'high', 'max'].includes(reasoningEffort)) {
  throw new Error('dsh-model-settings: reasoningEffort must be off, low, high, or max')
}
const baseURL = optionalString(payload.baseURL)
if (baseURL !== undefined) requiredHttpUrl(baseURL, 'baseURL')
const apiKeyEnv = requiredCredentialRef(payload.apiKeyEnv)
const apiKey = optionalString(payload.apiKey)

const settings = await readSettings(settingsPath)
settings.set(['agent-default-model', 'provider'], 'deepseek-official')
settings.set(['agent-default-model', 'model'], model)
settings.set(['agent-default-model', 'reasoningEffort'], reasoningEffort)
settings.set(['llm-deepseek', 'apiKeyEnv'], apiKeyEnv)
settings.set(['llm-deepseek', 'thinking'], reasoningEffort === 'off' ? 'disabled' : 'enabled')
settings.set(['llm-deepseek', 'reasoningEffort'], reasoningEffort)
if (baseURL === undefined) settings.delete(['llm-deepseek', 'baseURL'])
else settings.set(['llm-deepseek', 'baseURL'], baseURL)
await settings.write()

if (apiKey !== undefined) {
  const credentials = await readYamlDocument(credentialsPath)
  credentials.document.setIn([apiKeyEnv], apiKey)
  await writeAtomic(credentialsPath, credentials.document.toString())
}

process.stdout.write('{"ok":true}\n')

async function resolveSettingsPath(homePath) {
  for (const name of ['settings.yaml', 'settings.yml', 'settings.json']) {
    const path = join(homePath, name)
    try {
      await readFile(path)
      return path
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return join(homePath, 'settings.yaml')
}

async function readSettings(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.json') {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const value = text === undefined || text.trim() === '' ? {} : JSON.parse(text)
    if (!isObject(value)) throw new Error('dsh-model-settings: settings document must be an object')
    return {
      value,
      set(pathParts, next) {
        setObjectPath(value, pathParts, next)
      },
      delete(pathParts) {
        deleteObjectPath(value, pathParts)
      },
      write: () => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`),
    }
  }

  const yaml = await readYamlDocument(path)
  const value = yaml.document.toJS() ?? {}
  if (!isObject(value)) throw new Error('dsh-model-settings: settings document must be an object')
  return {
    value,
    set(pathParts, next) {
      yaml.document.setIn(pathParts, next)
      setObjectPath(value, pathParts, next)
    },
    delete(pathParts) {
      yaml.document.deleteIn(pathParts)
      deleteObjectPath(value, pathParts)
    },
    write: () => writeAtomic(path, yaml.document.toString()),
  }
}

async function readYamlDocument(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const document = text === undefined ? new Document({}) : parseDocument(text)
  if (document.errors.length > 0) throw document.errors[0]
  return { document }
}

async function readYamlObject(path) {
  const { document } = await readYamlDocument(path)
  const value = document.toJS() ?? {}
  if (!isObject(value)) throw new Error('dsh-model-settings: credentials document must be an object')
  return value
}

async function readJsonInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new Error('dsh-model-settings: save payload is required on stdin')
  const value = JSON.parse(text)
  if (!isObject(value)) throw new Error('dsh-model-settings: save payload must be an object')
  return value
}

function requiredString(value, key) {
  const next = optionalString(value)
  if (next === undefined) throw new Error(`dsh-model-settings: ${key} is required`)
  return next
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function requiredCredentialRef(value) {
  const ref = requiredString(value, 'apiKeyEnv')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    throw new Error('dsh-model-settings: apiKeyEnv must be a valid credential reference')
  }
  return ref
}

function optionalCredentialRef(value) {
  const ref = optionalString(value)
  if (ref === undefined) return undefined
  return requiredCredentialRef(ref)
}

function requiredProviderId(value) {
  const id = requiredString(value, 'id')
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error('dsh-model-settings: provider id must use lowercase letters, digits, and hyphens')
  }
  return id
}

function requiredHttpUrl(value, key) {
  const text = requiredString(value, key)
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`dsh-model-settings: ${key} must be an absolute HTTP(S) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-model-settings: ${key} must be an HTTP(S) URL`)
  }
  return text
}

function requiredModels(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('dsh-model-settings: a custom provider requires at least one model')
  }
  return value.map((raw, index) => {
    if (!isObject(raw)) throw new Error(`dsh-model-settings: model ${index + 1} must be an object`)
    const model = { id: requiredString(raw.id, `models[${index}].id`) }
    const name = optionalString(raw.name)
    const contextWindow = optionalPositiveInteger(raw.contextWindow, `models[${index}].contextWindow`)
    const maxTokens = optionalPositiveInteger(raw.maxTokens, `models[${index}].maxTokens`)
    return {
      ...model,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
  })
}

function optionalPositiveInteger(value, key) {
  if (value === undefined || value === null || value === '') return undefined
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`dsh-model-settings: ${key} must be a positive integer`)
  }
  return value
}

function positiveIntegerAt(value, key) {
  const number = value[key]
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function objectAt(value, key) {
  const next = value[key]
  return isObject(next) ? next : {}
}

function stringAt(value, key) {
  return typeof value[key] === 'string' ? value[key] : undefined
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setObjectPath(value, pathParts, next) {
  let current = value
  for (const part of pathParts.slice(0, -1)) {
    if (!isObject(current[part])) current[part] = {}
    current = current[part]
  }
  current[pathParts.at(-1)] = next
}

function deleteObjectPath(value, pathParts) {
  let current = value
  for (const part of pathParts.slice(0, -1)) {
    if (!isObject(current[part])) return
    current = current[part]
  }
  delete current[pathParts.at(-1)]
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}
