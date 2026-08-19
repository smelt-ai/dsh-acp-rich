/**
 * Pure translation between the harness session log and the ACP wire, outside
 * the tool-card registry: stream chunks, plans, usage, prompt content, and turn
 * endings. Nothing here touches a Context, a clock, or the network, so the
 * whole presentation contract is testable as data in / data out.
 *
 * @module @smelt-ai/dsh-acp-rich/codec
 */

import type {
  ContentBlock as AcpContentBlock,
  PlanEntry,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk'
import {
  readString,
  type HarnessContentBlock,
  type HarnessStreamChunk,
  type HarnessTodoItem,
  type HarnessTokenUsage,
  type HarnessTurnEndReason,
} from './harness.ts'

/**
 * Map a harness turn ending to ACP's terminal vocabulary.
 *
 * `cancelled` is reserved for an explicit `session/cancel` (settled out of band
 * by the bridge), so a turn aborted by a hook or another owner reports ordinary
 * quiescence. A token-limit ending is a turn-level fact, not a prompt-level
 * stop reason, and the caller collapses it to `end_turn`.
 * @param reason - the harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason: HarnessTurnEndReason): StopReason {
  switch (reason.kind) {
    case 'max-tokens':
      return 'max_tokens'
    case 'interrupted':
      return 'cancelled'
    case 'completed':
    case 'aborted':
    case 'blocked':
    case 'error':
    default:
      return 'end_turn'
  }
}

/**
 * Map one raw model stream delta to its ACP session update.
 *
 * `messageId` groups a message's chunks: the client starts a new bubble when it
 * changes, so the turn/step coordinate is exactly the right identity. A
 * `tool-call-delta` yields nothing — the assembled `tool/call` event carries the
 * parsed arguments a tool card needs, and streaming a half-parsed argument
 * string would only make the client render and unrender a title.
 * @param chunk - the harness stream chunk.
 * @param messageId - stable per-step message identity.
 * @returns the update to notify, or undefined for a chunk with no ACP analogue.
 */
export function chunkToUpdate(
  chunk: HarnessStreamChunk,
  messageId: string,
): SessionUpdate | undefined {
  const text = readString(chunk, 'text')
  if (text === undefined || text.length === 0) return undefined
  if (chunk.type === 'text-delta') {
    return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId }
  }
  if (chunk.type === 'reasoning-delta') {
    return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId }
  }
  return undefined
}

/**
 * Project the `todo/write` whole-list snapshot onto an ACP plan.
 *
 * The status vocabularies are identical by construction
 * (`pending`/`in_progress`/`completed`). dsh deliberately carries no priority —
 * the list is replaced wholesale and entries need no ranking — so every entry
 * reports `medium` rather than inventing an order the harness never expressed.
 * @param todos - the harness snapshot.
 * @returns ACP plan entries in list order.
 */
export function todosToPlanEntries(todos: readonly HarnessTodoItem[]): PlanEntry[] {
  return todos.map(todo => ({
    content: todo.content,
    priority: 'medium' as const,
    status: todo.status,
  }))
}

/**
 * Project a step's token accounting onto ACP's context-usage gauge.
 *
 * `used` is what occupies the window going into the next request: the harness
 * reports DISJOINT counts, so billed prompt size is uncached input plus both
 * cache legs, and the step's own output joins the transcript. `size` is the
 * route's advertised window, which arrives on `request/context` rather than
 * with the usage itself — without it there is no denominator and the gauge is
 * suppressed rather than guessed.
 * @param usage - the assistant message's token accounting.
 * @param contextWindow - the latest advertised window for the active route.
 * @returns the ACP usage update, or undefined when the window is unknown.
 */
export function usageToUpdate(
  usage: HarnessTokenUsage,
  contextWindow: number | undefined,
): SessionUpdate | undefined {
  if (contextWindow === undefined || contextWindow <= 0) return undefined
  const used = (usage.inputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + (usage.outputTokens ?? 0)
  if (!Number.isFinite(used) || used < 0) return undefined
  return { sessionUpdate: 'usage_update', used, size: contextWindow }
}

/**
 * Project harness message content onto ACP content blocks for transcript
 * replay (`session/load`) and user-message echo.
 * @param blocks - harness content blocks.
 * @returns ACP blocks, dropping anything with no textual projection.
 */
export function toAcpMessageBlocks(
  blocks: readonly HarnessContentBlock[],
): AcpContentBlock[] {
  return blocks.flatMap((block): AcpContentBlock[] => {
    if (block.type === 'text' || block.type === 'reasoning') {
      const text = readString(block, 'text')
      return text === undefined || text.length === 0 ? [] : [{ type: 'text', text }]
    }
    if (block.type === 'image') {
      const name = readString(block['attachment'], 'name')
        ?? readString(block['attachment'], 'attachmentId')
        ?? 'image'
      return [{ type: 'text', text: `[image attachment ${name}]` }]
    }
    return []
  })
}

/**
 * One piece of an inbound ACP prompt, already classified for the harness.
 * Images stay unresolved here because committing one is an async attachment
 * write; this layer only decides WHAT each block becomes.
 */
export type PromptPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: string; mediaType: string; name?: string }

/**
 * Classify an ACP prompt into harness-bound parts.
 *
 * `resource_link` and `resource` become explicit bracketed references rather
 * than being dropped: the baseline ACP contract requires every agent to accept
 * a link, and silently losing the file the user pointed at is the worse
 * failure. Audio has no harness content block and is refused upstream by the
 * capability we advertise, so it is dropped here as unreachable-by-contract.
 * @param prompt - the ACP prompt blocks in wire order.
 * @returns the classified parts, adjacent text already merged.
 */
export function splitPrompt(prompt: readonly AcpContentBlock[]): PromptPart[] {
  const parts: PromptPart[] = []
  const pushText = (text: string): void => {
    if (text.length === 0) return
    const last = parts[parts.length - 1]
    if (last !== undefined && last.kind === 'text') last.text += text
    else parts.push({ kind: 'text', text })
  }
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
        pushText(block.text)
        break
      case 'resource_link':
        pushText(`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`)
        break
      case 'resource': {
        const text = readString(block.resource, 'text')
        const uri = readString(block.resource, 'uri') ?? ''
        pushText(text === undefined
          ? `\n[resource uri=${JSON.stringify(uri)}]\n`
          : `\n[resource uri=${JSON.stringify(uri)}]\n${text}\n`)
        break
      }
      case 'image':
        parts.push({
          kind: 'image',
          data: block.data,
          mediaType: block.mimeType,
          ...readString(block, 'uri') === undefined ? {} : { name: readString(block, 'uri') as string },
        })
        break
      default:
        break
    }
  }
  return parts
}

/** Whether a prompt carries content this bridge cannot represent at all. */
export function promptHasUnsupportedContent(
  prompt: readonly AcpContentBlock[],
  acceptsImages: boolean,
): boolean {
  return prompt.some(block => block.type === 'audio' || (block.type === 'image' && !acceptsImages))
}

/** Stable per-step message identity used to group streamed chunks. */
export function messageIdFor(sessionId: string, turn: number, step: number): string {
  return `${sessionId}:${turn}:${step}`
}
