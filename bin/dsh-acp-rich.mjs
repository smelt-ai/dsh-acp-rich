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

await boot(NAME, resolveConfigPath(values.config ?? './cordis.yml', undefined))
