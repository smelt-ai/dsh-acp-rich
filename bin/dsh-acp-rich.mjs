#!/usr/bin/env node
/**
 * Boot a native dsh profile with Smelt as its host.
 *
 * The native `dsh` launcher remains the sole owner of profile discovery,
 * bundle composition, credentials, settings, HMR, and process shutdown. This
 * wrapper adds one final patch layer that disables native output hosts and
 * enables the ACP bridge installed in the same profile.
 *
 * Stdout carries ACP JSON-RPC and nothing else. Every diagnostic goes to
 * stderr, including the one below — a stray line on stdout is a framing error
 * the client reports as a corrupt agent, not as a misconfiguration.
 *
 * Usage: `dsh-acp-rich --profile <name>`.
 */

import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-acp-rich'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { profile: { type: 'string', short: 'p' } },
  strict: true,
})

if (values.profile === undefined || values.profile.trim() === '') {
  process.stderr.write(`${NAME}: --profile <name> is required\n`)
  process.exit(64)
}

const patch = fileURLToPath(new URL('../profile/smelt-host.patch.yml', import.meta.url))
const child = spawn('dsh', ['--profile', values.profile, '--patch', patch], {
  env: process.env,
  stdio: 'inherit',
})

child.once('error', error => {
  process.stderr.write(`${NAME}: failed to start native dsh: ${String(error)}\n`)
  process.exitCode = 127
})

child.once('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
