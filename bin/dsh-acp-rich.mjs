#!/usr/bin/env node
/**
 * Boot a harness runtime from a `cordis.yml` profile and serve ACP on stdio.
 *
 * A deliberately thin wrapper over `@deepseek-ai/dsh-app-boot`, matching the
 * harness's own app bins: env loading, loader guards, and settled-tree boot all
 * live upstream, and duplicating them here would be a second thing to keep in
 * step with a preview-stage runtime.
 *
 * Stdout carries ACP JSON-RPC and nothing else. Every diagnostic goes to
 * stderr, including the one below — a stray line on stdout is a framing error
 * the client reports as a corrupt agent, not as a misconfiguration.
 *
 * Usage: `dsh-acp-rich [--config <path>]`, defaulting to `./cordis.yml`.
 */

import { parseArgs } from 'node:util'
import { dirname } from 'node:path'

const NAME = 'dsh-acp-rich'

let appBoot
try {
  appBoot = await import('@deepseek-ai/dsh-app-boot')
} catch (error) {
  // The harness is an optional peer: this package is the bridge, not the
  // runtime. Say which install is missing rather than letting an unresolved
  // import read as a broken bridge.
  process.stderr.write(
    `${NAME}: the DeepSeek Harness runtime is not installed alongside this bridge.\n`
    + `${NAME}: install it, e.g. \`npm i -g @deepseek-ai/dsh-app-boot @deepseek-ai/dsh-agent-spine-demo\`.\n`
    + `${NAME}: underlying error: ${String(error)}\n`,
  )
  process.exit(78)
}

const { boot, installFailLoud, loadEnv, resolveConfigPath } = appBoot

installFailLoud(NAME)
loadEnv(NAME)

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})

const configPath = resolveConfigPath(values.config ?? './cordis.yml', undefined)

// Relative paths inside the profile now mean "next to the profile", not "next
// to whatever directory the client happened to launch us from".
//
// Why this is here and not solved by writing absolute paths in the profile:
// plugins that take a path (`session-persistence-jsonl`, `session-query-sqlite`)
// call bare `resolve(config.root)`, which is relative to the *process* cwd. An
// ACP client spawns this bin with the child cwd set to the user's project, so
// `root: './.sessions'` scattered a session store and a search index into every
// project the user opened. Config-relative is the semantics a config file is
// expected to have, it fixes existing installs on upgrade instead of asking
// everyone to hand-edit their profile, and it keeps each profile's store next
// to that profile rather than hard-coding one shared location.
//
// Safe because nothing the agent does is scoped by this process's cwd: the
// session's own cwd wins everywhere it matters. `sandbox-policy` resolves
// `session?.header.cwd ?? this.workspaceRoot`, and the filesystem and bash
// tools take the session workspace, so file reads, writes, the sandbox
// boundary, and `pwd` are all unaffected — verified against a live runtime.
// The `!!js process.cwd()` defaults in the reference profile are the no-session
// fallback only.
//
// Ordering matters twice: after `loadEnv`, so a project-local `.env` is still
// the one that gets read; after `resolveConfigPath`, so a relative `--config`
// still resolves against the directory the user typed it in.
process.chdir(dirname(configPath))

await boot(NAME, configPath)
