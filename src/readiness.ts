/**
 * Boot-settlement gate for the ACP server.
 *
 * This bridge's `apply` runs while the Loader is still activating rows, and it
 * binds stdio immediately — so a client that is already waiting on the pipe can
 * be answered from a half-composed runtime. The damage is not transient: the
 * settings-backed plugins register their sections only once the `settings`
 * service becomes injectable, and until they do the LLM seam carries just the
 * composition defaults. ACP snapshots a session's config options at
 * `session/new`, so a session opened in that window advertises one provider
 * group forever, no matter what the user's `settings.yaml` declares.
 *
 * The gate mirrors the harness bootstrap's own activation audit: every enabled
 * Loader entry must leave the pending/loading states before requests are
 * served. It never becomes a hang — a runtime that cannot settle (a row stuck
 * waiting for a service no profile provides) releases the gate on a timeout, so
 * a degraded session still beats no session at all.
 *
 * @module dsh-acp-rich/readiness
 */

/** Fiber lifecycle values mirrored from cordis's const enum, which has no runtime object. */
const FIBER_PENDING = 0
const FIBER_LOADING = 1
const FIBER_UNLOADING = 5

/** Default ceiling on how long a session request waits for the tree to settle. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default poll spacing; the Loader publishes no settlement event to subscribe to. */
const DEFAULT_INTERVAL_MS = 25

/** The slice of a Loader entry this gate reads. */
export interface LoaderEntryLike {
  disabled?: boolean
  options?: { name?: string }
  fiber?: { state: number }
}

/** The slice of the cordis Loader this gate reads. */
export interface LoaderLike {
  entries: () => Iterable<LoaderEntryLike>
}

/** Tuning and diagnostics hooks; every field has a production-safe default. */
export interface RuntimeGateOptions {
  timeoutMs?: number
  intervalMs?: number
  /** Injected clock, so tests need no real time. */
  now?: () => number
  /** Injected sleep, so tests need no real timers. */
  sleep?: (ms: number) => Promise<void>
  /** Reports the rows that were still unsettled when the timeout released the gate. */
  onTimeout?: (unsettled: readonly string[]) => void
}

/** Whether a fiber has reached a state the audit would accept as settled. */
function isSettled(state: number): boolean {
  return state !== FIBER_PENDING && state !== FIBER_LOADING && state !== FIBER_UNLOADING
}

/**
 * Names of the enabled entries that have not settled yet.
 * @param loader - the cordis Loader to audit.
 * @returns one diagnostic name per unsettled entry, empty when the tree settled.
 */
function unsettledEntries(loader: LoaderLike): string[] {
  const names: string[] = []
  for (const entry of loader.entries()) {
    if (entry.disabled === true) continue
    const fiber = entry.fiber
    // A row whose fiber does not exist yet has not begun activating.
    if (fiber === undefined || !isSettled(fiber.state)) {
      names.push(entry.options?.name ?? 'unknown')
    }
  }
  return names
}

/**
 * Build the gate every request handler awaits before touching the runtime.
 *
 * The Loader is read through a getter rather than captured: it is a service,
 * and a deployment that composes this bridge without one (every unit test, and
 * any embedded host) must not be gated at all.
 * @param getLoader - reads the current Loader service, or undefined when absent.
 * @param options - timeout, poll spacing, injected clock, and the timeout hook.
 * @returns an idempotent, memoized await-point; resolves once and stays resolved.
 */
export function createRuntimeGate(
  getLoader: () => LoaderLike | undefined,
  options: RuntimeGateOptions = {},
): () => Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => {
    // Unreferenced so a pending gate never holds the process open by itself.
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  }))

  let settled: Promise<void> | undefined

  const wait = async (): Promise<void> => {
    const deadline = now() + timeoutMs
    for (;;) {
      const loader = getLoader()
      if (loader === undefined) return
      const unsettled = unsettledEntries(loader)
      if (unsettled.length === 0) return
      if (now() >= deadline) {
        options.onTimeout?.(unsettled)
        return
      }
      await sleep(intervalMs)
    }
  }

  return () => (settled ??= wait())
}
