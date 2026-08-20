/**
 * The plugin's *loader-facing* contract.
 *
 * Every other spec drives `apply()` directly, which is exactly the blind spot
 * that let a bridge ship that could never boot: the fake harness models the
 * harness's services, not cordis's loader, so a malformed `inject` or a stray
 * `default` export passes all of them and then fails at runtime with
 * `1 entry did not activate` / `cannot get property "agents" without inject`.
 *
 * These tests assert the module shape against the loader's own normalization
 * rules rather than a remembered convention.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as plugin from '../src/index.ts'

/** tsconfig files are JSONC; the build project carries a rationale comment. */
function stripJsonComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '')
}

/**
 * `Inject.resolve` in `@deepseek-ai/cordis`: an array yields one entry per
 * element, anything else object-like yields one entry per *own key*. There is
 * no `{ required, optional }` tier — that form resolves to two services named
 * `required` and `optional`, which never exist.
 */
function resolveInject(inject: unknown): string[] {
  if (!inject) return []
  if (Array.isArray(inject)) return inject.map(String)
  return Object.keys(inject as object)
}

describe('cordis plugin contract', () => {
  it('exports the named triple the loader reads metadata from', () => {
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.name).toBe('acp-rich')
    expect(plugin.inject).toBeDefined()
  })

  it('has no default export', () => {
    // The loader prefers `default` when present and a bare `apply` function
    // carries neither `name` nor `inject`, so a default export silently
    // discards both.
    expect((plugin as Record<string, unknown>).default).toBeUndefined()
  })

  it('declares inject as a flat array', () => {
    expect(Array.isArray(plugin.inject)).toBe(true)
  })

  it('resolves to real service names only', () => {
    const resolved = resolveInject(plugin.inject)
    expect(resolved).toContain('agents')
    // The two tell-tale names produced by the `{ required, optional }` form.
    expect(resolved).not.toContain('required')
    expect(resolved).not.toContain('optional')
  })

  it('requires nothing the harness may legitimately omit', () => {
    // Anything named here blocks activation until it exists. Services the
    // bridge merely degrades without must be read via `ctx.get`, not injected.
    expect(resolveInject(plugin.inject)).toEqual(['agents'])
  })
})

describe('package layout', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as Record<string, any>
  const build = JSON.parse(
    stripJsonComments(readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8')),
  ) as { compilerOptions: { rootDir: string, outDir: string } }

  /**
   * `main` must name a file the build actually emits. tsc derives the emitted
   * tree from the *common root* of its inputs, so a build project that also
   * compiled `tests/` would emit `lib/src/index.js` and leave `main` dangling —
   * which npm reports only as an unresolvable import, at the consumer.
   */
  it('points main at the emitted entry', () => {
    const { rootDir, outDir } = build.compilerOptions
    expect(rootDir).toBe('src')
    expect(pkg.main).toBe(`${outDir}/index.js`)
    expect(pkg.exports['.'].default).toBe(`./${outDir}/index.js`)
    expect(pkg.exports['.'].types).toBe(`./${outDir}/index.d.ts`)
  })

  it('builds from the emit-only project, not the type-check one', () => {
    // The root project deliberately includes `tests/` for type-checking.
    expect(pkg.scripts.build).toContain('tsconfig.build.json')
  })

  it('pins every harness peer to one release train', () => {
    // The harness publishes its packages as a matched set with cross peer
    // ranges; mixing trains is an install-time ERESOLVE, not a runtime bug.
    const trains = new Set(
      Object.entries(pkg.peerDependencies as Record<string, string>)
        .filter(([name]) => name.startsWith('@deepseek-ai/'))
        .map(([, range]) => range),
    )
    expect(trains.size).toBe(1)
  })

  it('ships the bin the launch command names', () => {
    expect(pkg.bin['dsh-acp-rich']).toBe('bin/dsh-acp-rich.mjs')
    expect(pkg.bin['dsh-credential']).toBe('bin/dsh-credential.mjs')
    expect(pkg.bin['dsh-model-settings']).toBe('bin/dsh-model-settings.mjs')
    expect(pkg.files).toContain('bin/dsh-acp-rich.mjs')
    expect(pkg.files).toContain('bin/dsh-credential.mjs')
    expect(pkg.files).toContain('bin/dsh-model-settings.mjs')
  })

  it('installs as a native dsh bundle with a separate Smelt host overlay', () => {
    expect(pkg.dsh.bundle.patch).toBe('./profile/cordis.patch.yml')
    expect(pkg.exports['./lease'].default).toBe('./lib/lease.js')
    expect(pkg.files).toContain('profile/cordis.patch.yml')
    expect(pkg.files).toContain('profile/smelt-host.patch.yml')
    expect(pkg.files).not.toContain('profile/cordis.yml')

    const bundle = readFileSync(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8')
    expect(bundle).toContain("@smelt-ai/dsh-acp-rich/lease")
    expect(bundle).toMatch(/id: smelt-acp-rich[\s\S]*disabled: true/)

    const overlay = readFileSync(new URL('../profile/smelt-host.patch.yml', import.meta.url), 'utf8')
    expect(overlay).toMatch(/id: smelt-acp-rich[\s\S]*disabled: false/)
    for (const id of ['webserver', 'web-runtime', 'directory-picker', 'api-gateway', 'client-hmr', 'modules', 'connection']) {
      expect(overlay).toMatch(new RegExp(`id: ${id}[\\s\\S]*disabled: true`))
    }
  })
})

/**
 * A published version number can never be reused, so every one of these is a
 * permanent mistake rather than a fixable one. `npm publish` itself checks none
 * of them: it will happily ship a tarball with no source in it, under a license
 * the repository does not grant.
 */
describe('publish metadata', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as Record<string, any>

  it('declares the license the shipped LICENSE file actually grants', () => {
    const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0')
    expect(pkg.license).toBe('Apache-2.0')
    expect(pkg.files).toContain('LICENSE')
  })

  it('opts a scoped package out of the restricted default', () => {
    // Scoped packages publish as `restricted` unless told otherwise, and a
    // restricted publish is rejected outright without a paid plan.
    expect(pkg.name.startsWith('@')).toBe(true)
    expect(pkg.publishConfig?.access).toBe('public')
  })

  it('builds and verifies before publishing', () => {
    // `lib/` is gitignored build output: packing a tree that was never built
    // succeeds with exit 0 and produces a tarball containing no source at all.
    const hook = pkg.scripts.prepublishOnly as string
    expect(hook).toContain('build')
    expect(hook).toContain('test')
    expect(hook).toContain('verify-package')
  })

  it('points back at its own repository', () => {
    expect(pkg.repository.url).toContain('smelt-ai/dsh-acp-rich')
  })
})
