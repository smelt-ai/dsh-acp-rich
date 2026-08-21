/**
 * Agent-preset join: an agent only sees the tools, prompt sections and skill
 * catalog of the preset its scope is parented to.
 *
 * This is not an optional nicety. In the shipped compositions the host rows for
 * `tool-bash`, `tool-fs`, `tool-skill` and `skill-filesystem` are disabled on
 * purpose — "presets own local discovery" — so an agent that joins no preset
 * resolves against the *empty* global layer and silently comes up without a
 * shell, without file tools and without any skill from `.dsh/skills`. Nothing
 * fails; the session just quietly has less than the same profile gives its own
 * Web client, which is exactly the kind of difference nobody thinks to check.
 *
 * The registry only exposes the join through the agent factory's `setup`, and
 * only there: the scope must still be open, which stops being true the moment
 * the handle is returned.
 *
 * @module
 */

import type { HarnessAgentContext } from './harness.ts'

/** The slice of `@deepseek-ai/dsh-agent-presets` this bridge calls. */
export interface HarnessAgentPresets {
  /** Compose one agent onto a preset; `undefined` means the deployment default. */
  mount(agentCtx: HarnessAgentContext, id?: string): Promise<unknown>
}

/** What {@link joinAgentPreset} did, for the caller to log or assert on. */
export type PresetJoin =
  | { joined: true }
  /** No roster in this deployment: the rows live in the host composition. */
  | { joined: false; reason: 'absent' }
  | { joined: false; reason: 'failed'; error: unknown }

function presetService(ctx: {
  get(name: string): unknown
}): HarnessAgentPresets | undefined {
  const service = ctx.get('agentPresets') as Partial<HarnessAgentPresets> | undefined
  return typeof service?.mount === 'function' ? (service as HarnessAgentPresets) : undefined
}

/**
 * Join one agent to its preset inside the factory's `setup`.
 *
 * A deployment without the presets plugin is not an error: there the
 * model-facing rows sit in the host composition and every agent already sees
 * them. A deployment that *has* presets but cannot mount one is reported to the
 * caller rather than thrown, because failing the mount would cost the user the
 * whole session — and the pre-existing behaviour was to run without a preset
 * anyway. The caller is expected to say out loud what the session lost.
 *
 * @param hostCtx - the plugin's own context, used to look up the service.
 * @param agentCtx - the agent scope handed to `setup`.
 * @param id - preset id, or undefined for the deployment default.
 */
export async function joinAgentPreset(
  hostCtx: { get(name: string): unknown },
  agentCtx: HarnessAgentContext,
  id?: string,
): Promise<PresetJoin> {
  const presets = presetService(hostCtx)
  if (presets === undefined) return { joined: false, reason: 'absent' }
  try {
    await presets.mount(agentCtx, id)
    return { joined: true }
  } catch (error) {
    return { joined: false, reason: 'failed', error }
  }
}
