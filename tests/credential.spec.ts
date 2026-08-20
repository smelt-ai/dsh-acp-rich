import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const helper = new URL('../bin/dsh-credential.mjs', import.meta.url)
let home: string | undefined

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function run(reference: string, value: string) {
  const args = [helper.pathname, '--ref', reference]
  return {
    args,
    result: spawnSync(process.execPath, args, {
      env: { ...process.env, DSH_HOME: home },
      input: value,
      encoding: 'utf8',
    }),
  }
}

describe('native credential editor', () => {
  it('updates one key without discarding comments or exposing the value in argv', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-credential-'))
    const path = join(home, '.credentials.yaml')
    writeFileSync(path, '# provider token\nOTHER_KEY: preserved\nDEEPSEEK_API_KEY: old\n')

    const { args, result } = run('DEEPSEEK_API_KEY', 'new-secret')

    expect(result.status).toBe(0)
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('# provider token')
    expect(parse(raw)).toEqual({
      OTHER_KEY: 'preserved',
      DEEPSEEK_API_KEY: 'new-secret',
    })
    expect(args).not.toContain('new-secret')
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses malformed YAML without replacing the original file', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-credential-'))
    mkdirSync(home, { recursive: true })
    const path = join(home, '.credentials.yaml')
    const original = 'broken: [\n'
    writeFileSync(path, original)

    const { result } = run('DEEPSEEK_API_KEY', 'new-secret')

    expect(result.status).not.toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
})
