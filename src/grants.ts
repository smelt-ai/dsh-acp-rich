/**
 * Session-scoped standing approval decisions.
 *
 * The harness's approval seam has exactly one grant: `'allowed-once'`. That is
 * a CORE limitation, not an ACP-bridge trade-off — `ApprovalOutcome` has no
 * durable member and no policy object to hang one on. ACP clients, meanwhile,
 * offer "always allow" as a first-class permission option and expect the agent
 * to honour it for the rest of the session.
 *
 * This module is the missing piece: it sits on the `approval/request`
 * waterfall, answers a matching later request from its own memory, and never
 * lets a standing decision outlive the session that made it.
 *
 * Scope of a standing decision is the TOOL NAME. That is the finest identity
 * the harness request carries that is also stable across calls: `callId` is
 * unique per invocation (useless as a key) and `reason` is free prose. Being
 * explicit about this matters — "always allow" here means "always allow this
 * tool in this session", and the option labels say exactly that so a user is
 * never surprised by a broader grant than they authorized.
 *
 * @module @smelt-ai/dsh-acp-rich/grants
 */

import type { PermissionOption, RequestPermissionOutcome } from '@agentclientprotocol/sdk'
import type { HarnessApprovalOutcome } from './harness.ts'

/** A standing decision recorded for one tool within one session. */
export type StandingDecision = 'allowed' | 'rejected'

/** The option ids this bridge offers; the client echoes one back. */
export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow this tool (this session)', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject this tool (this session)', kind: 'reject_always' },
]

/**
 * Per-session standing decisions, keyed session → tool → decision.
 *
 * Deliberately in-memory and session-scoped: a decision the user made about one
 * conversation must not silently pre-authorize the next one, and a durable
 * grant store is a product decision the harness has not made.
 */
export class GrantStore {
  private readonly sessions = new Map<string, Map<string, StandingDecision>>()

  /**
   * The standing decision for one tool, if the user made one.
   * @param sessionId - the ACP session the request belongs to.
   * @param toolName - the tool the question is about.
   * @returns the recorded decision, or undefined to ask.
   */
  lookup(sessionId: string, toolName: string): StandingDecision | undefined {
    return this.sessions.get(sessionId)?.get(toolName)
  }

  /**
   * Record a standing decision.
   * @param sessionId - the ACP session the request belongs to.
   * @param toolName - the tool the question is about.
   * @param decision - what to answer for every later request naming this tool.
   */
  remember(sessionId: string, toolName: string, decision: StandingDecision): void {
    let perSession = this.sessions.get(sessionId)
    if (perSession === undefined) {
      perSession = new Map()
      this.sessions.set(sessionId, perSession)
    }
    perSession.set(toolName, decision)
  }

  /**
   * Drop every standing decision for one session.
   * @param sessionId - the session being torn down.
   */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Drop every standing decision for every session (bridge teardown). */
  clear(): void {
    this.sessions.clear()
  }
}

/**
 * Interpret a client's permission answer: the harness outcome to return now,
 * and the standing decision to remember, if any.
 *
 * An unknown `optionId` fails closed. A client is free to answer with an option
 * this bridge never offered, and treating an unrecognized answer as consent
 * would turn a protocol mismatch into an unauthorized action.
 * @param outcome - the client's `session/request_permission` response outcome.
 * @returns the immediate harness outcome plus any decision to persist.
 */
export function interpretPermission(
  outcome: RequestPermissionOutcome,
): { outcome: HarnessApprovalOutcome; remember?: StandingDecision } {
  if (outcome.outcome === 'cancelled') return { outcome: 'cancelled' }
  switch (outcome.optionId) {
    case 'allow-once':
      return { outcome: 'allowed-once' }
    case 'allow-always':
      return { outcome: 'allowed-once', remember: 'allowed' }
    case 'reject-once':
      return { outcome: 'rejected' }
    case 'reject-always':
      return { outcome: 'rejected', remember: 'rejected' }
    default:
      return { outcome: 'rejected' }
  }
}
