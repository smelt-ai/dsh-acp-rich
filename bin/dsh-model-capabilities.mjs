#!/usr/bin/env node
/**
 * Report which reasoning efforts each model in a profile actually supports.
 *
 * Boots the profile's own dsh runtime with every output host disabled, lets
 * the capability plugin write its report, then relays that report on stdout as
 * the only thing this process prints. Callers parse stdout as JSON.
 *
 * The report travels through a temp file rather than the child's stdout: the
 * child is a full dsh process whose stdout belongs to whatever the profile
 * still has enabled, so it is not a channel this tool can claim. Its stdout is
 * discarded and its stderr is kept only to explain a failure.
 *
 * Usage: `dsh-model-capabilities --profile <name>`.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-model-capabilities'
const OUTPUT_PATH_ENV = 'SMELT_MODEL_CAPABILITIES_OUT'

// The child settles the catalog for up to 10s; this is the outer bound that
// covers dsh boot as well, so a wedged runtime fails loudly instead of hanging
// a settings panel forever.
const TIMEOUT_MS = 60_000

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { profile: { type: 'string', short: 'p' } },
  strict: true,
})

if (values.profile === undefined || values.profile.trim() === '') {
  process.stderr.write(`${NAME}: --profile <name> is required\n`)
  process.exit(64)
}

const destination = join(tmpdir(), `smelt-model-capabilities-${randomUUID()}.json`)
const patch = fileURLToPath(new URL('../profile/smelt-capabilities.patch.yml', import.meta.url))

const child = spawn('dsh', ['--profile', values.profile, '--patch', patch], {
  env: { ...process.env, [OUTPUT_PATH_ENV]: destination },
  stdio: ['ignore', 'ignore', 'pipe'],
})

let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr += chunk })

let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  child.kill('SIGKILL')
}, TIMEOUT_MS)

function cleanup() {
  clearTimeout(timer)
  try { rmSync(destination, { force: true }) } catch { /* best effort */ }
}

child.once('error', error => {
  cleanup()
  process.stderr.write(`${NAME}: failed to start native dsh: ${String(error)}\n`)
  process.exit(127)
})

child.once('exit', (code, signal) => {
  clearTimeout(timer)
  let report
  try {
    report = readFileSync(destination, 'utf8')
  } catch {
    report = undefined
  }
  cleanup()

  // The report is authoritative even when the child exited untidily: it is
  // written before exit, so a late crash in teardown must not discard an
  // answer that was already produced.
  if (report !== undefined) {
    process.stdout.write(report)
    process.exit(0)
  }

  const detail = stderr.trim()
  const reason = timedOut
    ? `timed out after ${TIMEOUT_MS}ms`
    : signal !== null
      ? `killed by ${signal}`
      : `exited with ${code ?? 1}`
  process.stderr.write(`${NAME}: no capability report (${reason})${detail === '' ? '' : `\n${detail}`}\n`)
  process.exit(70)
})
