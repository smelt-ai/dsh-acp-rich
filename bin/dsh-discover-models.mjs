#!/usr/bin/env node
/**
 * Ask a provider endpoint which models it serves.
 *
 * Boots the profile's own dsh runtime with every output host disabled, lets
 * the discovery plugin write its report, then relays that report on stdout as
 * the only thing this process prints. Callers parse stdout as JSON.
 *
 * The request is read from stdin as JSON and handed to the child through the
 * environment, never argv: it may carry a one-shot API key for an endpoint the
 * user is still configuring, and argv is world-readable through `ps`.
 *
 * The report travels back through a temp file for the same reason the
 * capability probe does — the child is a full dsh process whose stdout belongs
 * to whatever the profile still has enabled.
 *
 * Usage: `echo '{"baseURL":"…","api":"openai-completions"}' | dsh-discover-models --profile <name>`.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-discover-models'
const OUTPUT_PATH_ENV = 'SMELT_MODEL_DISCOVERY_OUT'
const REQUEST_ENV = 'SMELT_MODEL_DISCOVERY_REQUEST'

// Covers dsh boot, the catalog settling, and one network round trip to an
// endpoint the user typed — which may be slow or a black hole.
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

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const request = (await readStdin()).trim()
if (request === '') {
  process.stderr.write(`${NAME}: a JSON request on stdin is required\n`)
  process.exit(64)
}
try {
  JSON.parse(request)
} catch (error) {
  process.stderr.write(`${NAME}: request on stdin is not valid JSON: ${String(error)}\n`)
  process.exit(64)
}

const destination = join(tmpdir(), `smelt-model-discovery-${randomUUID()}.json`)
const patch = fileURLToPath(new URL('../profile/smelt-discovery.patch.yml', import.meta.url))

const child = spawn('dsh', ['--profile', values.profile, '--patch', patch], {
  env: { ...process.env, [OUTPUT_PATH_ENV]: destination, [REQUEST_ENV]: request },
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
  process.stderr.write(`${NAME}: no discovery report (${reason})${detail === '' ? '' : `\n${detail}`}\n`)
  process.exit(70)
})
