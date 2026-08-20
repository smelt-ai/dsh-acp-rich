#!/usr/bin/env node

import { readFile, rename, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseDocument, Document } from 'yaml'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { ref: { type: 'string' } },
  strict: true,
})

const ref = values.ref?.trim()
if (ref === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
  process.stderr.write('dsh-credential: --ref must be a valid credential reference\n')
  process.exit(64)
}

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const value = Buffer.concat(chunks).toString('utf8')
if (value.length === 0) {
  process.stderr.write('dsh-credential: credential value must not be empty\n')
  process.exit(64)
}

const configuredHome = process.env.DSH_HOME?.trim()
const home = configuredHome === undefined || configuredHome === '' ? join(homedir(), '.dsh') : configuredHome
const path = join(home, '.credentials.yaml')
let text
try {
  text = await readFile(path, 'utf8')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const document = text === undefined ? new Document({}) : parseDocument(text)
if (document.errors.length > 0) throw document.errors[0]
document.setIn([ref], value)

await mkdir(dirname(path), { recursive: true, mode: 0o700 })
const temporary = `${path}.${process.pid}.tmp`
await writeFile(temporary, document.toString(), { mode: 0o600 })
await rename(temporary, path)
