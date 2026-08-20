import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessSession } from './harness.ts'

export const name = 'smelt-session-lease'

interface LeaseContext {
  on: (event: string, listener: (session: HarnessSession) => void) => unknown
  effect: (factory: () => () => void, label?: string) => unknown
}

export interface LeaseOwner {
  pid: number
  token: string
  sessionId: string
}

export interface SessionLease {
  path: string
  owner: LeaseOwner
}

function leaseRoot(): string {
  const dshHome = process.env.DSH_HOME?.trim()
  return join(dshHome === undefined || dshHome === '' ? join(homedir(), '.dsh') : dshHome, '.smelt-session-leases')
}

function leasePath(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex')
  return join(leaseRoot(), key)
}

function ownerPath(path: string): string {
  return join(path, 'owner.json')
}

function readOwner(path: string): LeaseOwner | undefined {
  try {
    const owner = JSON.parse(readFileSync(ownerPath(path), 'utf8')) as Partial<LeaseOwner>
    if (typeof owner.pid !== 'number' || typeof owner.token !== 'string' || typeof owner.sessionId !== 'string') {
      return undefined
    }
    return owner as LeaseOwner
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function releaseSessionLease(lease: SessionLease): void {
  const current = readOwner(lease.path)
  if (current?.token === lease.owner.token) {
    rmSync(lease.path, { recursive: true, force: true })
  }
}

export function acquireSessionLease(sessionId: string): SessionLease {
  const root = leaseRoot()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = leasePath(sessionId)

  try {
    mkdirSync(path, { mode: 0o700 })
    const owner = { pid: process.pid, token: randomUUID(), sessionId }
    try {
      writeFileSync(ownerPath(path), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      rmSync(path, { recursive: true, force: true })
      throw error
    }
    return { path, owner }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const owner = readOwner(path)
    if (owner !== undefined && !processIsAlive(owner.pid)) {
      throw new Error(
        `session "${sessionId}" has a stale lease from process ${owner.pid}; remove ${path} before resuming it`,
      )
    }
    const heldBy = owner === undefined ? 'another dsh host' : `process ${owner.pid}`
    throw new Error(
      `session "${sessionId}" is already active in ${heldBy}; close it there before resuming it here`,
    )
  }
}

export function apply(ctx: LeaseContext): void {
  const held = new Map<string, SessionLease>()

  ctx.on('session/created', session => {
    const sessionId = session.header.id
    if (!held.has(sessionId)) held.set(sessionId, acquireSessionLease(sessionId))
  })
  ctx.on('session/disposed', session => {
    const lease = held.get(session.header.id)
    if (lease === undefined) return
    held.delete(session.header.id)
    releaseSessionLease(lease)
  })
  ctx.effect(
    () => () => {
      for (const lease of held.values()) releaseSessionLease(lease)
      held.clear()
    },
    'smelt-session-lease.cleanup',
  )
}
