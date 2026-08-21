# `@smelt-ai/dsh-acp-rich`

A presentation-complete [Agent Client Protocol](https://agentclientprotocol.com)
server for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh), so a dsh session in smelt looks like a Claude or Codex session: streaming
text, reasoning, tool cards, inline diffs, PLAN progress, usage, slash commands,
permission prompts, and resume.

## Why this exists

The harness already ships `@deepseek-ai/dsh-acp`. It calls itself an
**automation-only** ACP server, and its own source says why:

```ts
// Emit only committed assistant text. Raw chunks, reasoning, tools, plans,
// titles, and retry markers are presentation or trace data and stay off the
// automation wire.
```

That is a deliberate product decision, not a gap in the harness — "interactive
rendering and human questions belong to the Web host and client modules". But
smelt *is* an interactive client, so connecting it to the automation server
yields a plain text box: no tool cards, no diffs, no plan, no resume.

The data was never missing. `session/event` already carries `assistant/chunk`
(text and reasoning deltas), `tool/call`, `tool/result`, `todo/write`,
`assistant/message.usage`, and `request/context`; `ToolDefinition` already has
`presentCall()` / `presentResult()` returning `generic | terminal | diff` cards
whose diff shape is field-for-field identical to ACP's `ToolCallContent::Diff`.
This package subscribes to the same event stream and forwards all of it.

## Install and run

Install the package into each native dsh profile that should be available in
smelt:

```bash
dsh plugin --profile web add @smelt-ai/dsh-acp-rich
```

The package contributes a dormant Cordis row through its native
`dsh.bundle.patch`. A normal `dsh --profile web` invocation keeps using the
profile's original Web or headless host. Smelt starts the same profile with one
final overlay that disables output hosts and activates the ACP row:

```bash
dsh-acp-rich --profile web
```

Models, tools, policies, credentials, settings, persistence, and session IDs
remain owned by the native profile. Smelt discovers installed profiles under
`$DSH_HOME/profiles` and only replaces the host for its invocation.

The bundle also installs a session lease shared by both hosts. The same session
cannot be resumed concurrently from native dsh and Smelt; a crashed owner leaves
an explicit lease path in the error so it can be removed deliberately rather
than risking two writers through automatic stale-lock reclamation.

## Querying model capabilities

Reasoning efforts are not a fixed list. `resolveModelInfo` answers for a
*resolved route*, so the same model id reports four efforts through a direct
connection and none through a relay, and a connection pinned to
`thinking: disabled` collapses to `off` alone. A client that hardcodes the
DeepSeek ladder therefore offers options that fail every request made with them
as soon as the profile points somewhere else.

The package ships a one-shot probe for exactly that question:

```bash
dsh-model-capabilities --profile web
```

It boots the profile's own runtime with every output host disabled, waits for
the provider catalog to settle, resolves each advertised model, prints one JSON
report on stdout, and exits:

```json
{"providers":[
  {"id":"deepseek-official","name":"DeepSeek","models":[
    {"id":"deepseek-v4-pro","name":"DeepSeek-V4-Pro",
     "efforts":[{"id":"off","name":"Off"},{"id":"max","name":"Max"}],
     "defaultEffort":"high"}]},
  {"id":"sub2api","name":"Sub2Api","models":[
    {"id":"deepseek-v4-pro","name":"Deepseek-V4-Pro"}]}]}
```

**`efforts` is omitted, not emptied, when a route advertises no reasoning
control**, mirroring `resolveModelInfo` itself. Consumers must read that
absence as "render no picker". Substituting a default list is the bug this
tool exists to remove.

Expect a few seconds per call: assembling the runtime is the only way to get a
truthful answer, so the cost is a process launch rather than a file read.

## What is mapped

| ACP `SessionUpdate` | dsh source |
| --- | --- |
| `agent_message_chunk` | `assistant/chunk` text delta |
| `agent_thought_chunk` | `assistant/chunk` reasoning delta |
| `tool_call` | `tool/call` + `presentCall()` |
| `tool_call_update` | `tool/result` + `presentResult()` |
| `plan` | `todo/write` |
| `usage_update` | `assistant/message.usage` + `request/context` |
| `user_message_chunk` | `user/message` (replay only, see below) |
| `available_commands_update` | the `commands` registry |
| `config_option_update` | `ctx.llm` catalog + the agent's `ModelSelectionRef` |

Plus `session/load` resume, image prompts through `ctx.attachments`, cancel,
permission prompts, per-session MCP server passthrough, and
`session/set_config_option`.

## Deliberate departures

These are choices, not oversights.

**Terminal cards are static.** ACP's `terminal` content variant addresses a
`terminalId` the *client* minted via `terminal/create`. A bridge cannot fabricate
one for a command the harness already owns and runs. So a pending terminal card
shows the command as its title, and the result card is a ` ```console ` fence
with an exit/signal pill. Live streaming would require the harness to hand the
command over to the client instead of running it.

**Persistent authorization is ours, not the harness's.** `ApprovalOutcome` is
`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` and the source says
`'allowed-once'` is the only grant — at the **core** layer, not just in the ACP
bridge. "Always allow" therefore lives in `src/grants.ts` as an in-memory cache
that sits on the `approval/request` waterfall and answers matching later
requests itself. It is keyed by **tool name within one session**, the finest
identity stable across calls (`callId` is per-invocation, `reason` is free
prose), and the option labels say exactly that so nobody is surprised by a
broader grant. It is not persisted across restarts.

**Live `user/message` is not echoed.** It is either the prompt the client just
sent (double-render) or a synthetic harness injection — skill content, AGENTS.md,
cron notices — that can be enormous. Echo happens only while replaying a loaded
session, where the client genuinely has nothing.

**A committed `assistant/message` renders only if nothing streamed for its
step.** This protects non-streaming adapters and pruned-chunk replays without
double-rendering the normal case.

**The usage gauge is suppressed without a denominator.** `contextWindow` arrives
on `request/context`, not with the usage. A number with no scale is worse than
no gauge. Note that the four dsh token counts are **disjoint** — cached input is
reported separately, not folded into `inputTokens` — so "used" is their sum.

**The model picker writes the selection cell, not a setting.** The harness has
no global "current model" to set: whoever creates an agent owns its
`ModelSelectionRef`, and `installModelSelection` couples that cell to prompt
assembly and request routing. So this bridge holds the cell for each session and
writes it. `agentDefaultModel` is deliberately *not* that seam — it is the
default handed to **future** agents, so writing it would leave the running
session on its old model while the picker claimed otherwise. It is read exactly
once, at session creation, for the same reason.

Two consequences worth knowing:

- If `@deepseek-ai/dsh-agent` cannot be loaded, no selector is published at all.
  A picker that silently changes nothing is worse than no picker.
- Until the bridge knows the route — no configured model, no deployment default
  — nothing is published either. The first `request/context` reveals what the
  session actually ran, and the selectors appear then, via
  `config_option_update`. That adoption never overwrites a user's choice.

Switching model drops a reasoning effort the new model does not declare, and
refuses outright if the session already carries images and the target model's
`inputModalities` explicitly omits `image`. An adapter that declares *no*
modalities is treated as unknown, not text-only.

**Capabilities are reported from what the deployment composed**, never from what
this package can do in principle. No `ctx.attachments` turns off
`promptCapabilities.image`; no `sessionPersistence` provider turns off
`loadSession` and makes `session/load` answer `-32601`, which smelt classifies as
`UnsupportedLoad` and handles by opening a fresh session. An advertised
capability the runtime cannot serve turns a graceful degradation into a mid-turn
protocol error.

## Not implemented

- **Permission presets and other `settings` sections as selectors.** Only the
  model and reasoning effort are published. `registerSessionConfig` is the seam
  for adding more without editing the bridge.
- **Agent presets as a selector.** The harness only lets a session change preset
  while it is still *blank*, so a picker that stops working after the first turn
  would be worse than none.
- **Live terminal output**, per the terminal-card note above.
- **`sse` and `acp` MCP transports.** The harness MCP client speaks stdio and
  Streamable HTTP only; `mcpCapabilities` reports this honestly, and a server
  using another transport is skipped with a named warning rather than failing
  the session.
- **Compressed session history in smelt's sidebar.** smelt reads
  `session.jsonl` directly and has no zstd decoder, which is why the reference
  profile sets `compression: none`.
- **Image input — blocked upstream, not a choice here.** The bridge advertises
  `promptCapabilities.image` from the presence of an `attachments` service, and
  the only published implementation, `@deepseek-ai/dsh-attachment-local`, exists
  solely on the `0.0.1-rc.1` train, which will not resolve against a `0.1.0-rc.8`
  tree. Until it is republished, a composed runtime reports `image: false` and
  that report is accurate. The bridge code path needs no change when it lands;
  mount the service and the capability flips.

## What the unit tests cannot catch

`tests/harness.ts` fakes the harness's *services*. It does not model cordis's
**loader**, and the first live boot failed three times before serving a single
frame — each time with all unit tests green:

1. `export default apply` — the loader takes a module's `default` as the whole
   plugin when present, and a bare function carries no `name` and no `inject`.
   Every first-party harness plugin exports the named triple and nothing else.
2. `inject = { required, optional }` — this loader's `Inject.resolve` accepts an
   array or a `name -> intercept config` map, so that form asked for two
   services literally named `required` and `optional` and the entry waited for
   them forever (`1 entry did not activate`).
3. A profile that fails schema validation — `dsh-session-query-sqlite` requires
   `path`, and an invalid block takes down the whole tree, not just its plugin.

`tests/plugin-contract.spec.ts` now asserts (1) and (2) against the loader's own
normalization rules, plus the package layout that made `main` dangle. (3) has no
unit-test equivalent: **boot the tree** after editing the profile. The two-frame
`initialize` + `session/new` check under "Install and run" is the whole gate and
it needs no API key.

## Publishing

The `@smelt-ai` org exists on npmjs.org and is separate from the GitHub org of
the same name. Releases are cut by hand from a logged-in machine:

```bash
cd dsh-acp-rich
npm version <patch|minor|major>   # or edit "version" and commit
npm publish --otp=<code>          # prepublishOnly: build → typecheck → test → verify
```

The `--otp` is not optional: the publishing account has two-factor auth set to
`auth-and-writes`, so a publish without a current code fails with `EOTP` after
building and packing. A granular *automation* token is the only way to publish
unattended — those bypass 2FA by design.

`publishConfig.access` is `public`, which matters: **scoped packages publish as
`restricted` by default**, and a restricted publish is rejected outright without
a paid plan.

`prepublishOnly` exists because of a failure mode npm does not catch on its own.
`lib/` is gitignored build output, so packing a tree that was never built
**succeeds with exit 0** and produces a tarball containing the README, the bin,
and no source whatsoever. A published version number can never be reused and
unpublishing is restricted after 72 hours, so that mistake is permanent.
`scripts/verify-package.mjs` therefore asserts against
`npm pack --dry-run --json` — the real artifact, not a re-implementation of
npm's `files` semantics — that `main`, `types`, every `bin`, the profile, the
README, and the LICENSE are all present, that more than one module compiled, and
that no test-only file leaked in.

Smelt launches the binary from the selected native profile's dependency tree,
so Node resolves the exact plugin version installed by `dsh plugin`. The
launch path is only worth changing if smelt also learns to provision that tree.

## Upgrades

dsh is a developer preview whose README says "THERE WILL BE
COMPATIBILITY-BREAKING CHANGES", and `SessionEventMap`, `ContentBlockMap`, and
`ToolCallView` are declaration-merged **open** vocabularies — an upstream rename
never surfaces as a compile error even with hard type imports. That is why this
package restates the shapes it reads (`src/harness.ts`) behind runtime guards
instead of importing them: an unknown shape degrades to "no card" rather than
throwing inside a session-event listener, and the whole blast radius is one file.

After bumping the supported dsh release train, re-run:

```bash
npm test          # 161 unit + contract tests, no harness install needed
npm run typecheck
npm run build && npm run verify-package
```

then **boot the tree** — a green unit suite has already shipped a bridge that
could not start (see "What the unit tests cannot catch"):

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
| dsh-acp-rich --profile web
```

then check by hand, against a real session:

- [ ] Streaming text and reasoning both arrive incrementally
- [ ] An edit shows an **inline diff**, not a generic card
- [ ] A bash call shows the command, then its output and exit status
- [ ] `todo_write` moves the PLAN panel
- [ ] The usage gauge has a denominator
- [ ] Slash commands are listed
- [ ] A permission prompt appears, and "always allow" suppresses the next one
- [ ] ESC cancels mid-turn
- [ ] A session resumes from the sidebar with its transcript
- [ ] Cross-agent `send_message` works (proves MCP passthrough)
- [ ] The model picker lists every provider route, and switching it actually
      changes the model the **next** step runs on (a switch lands on the next
      step by design, not mid-request)

A silent regression in this bridge looks like a missing card, not a crash, so
the checklist is the test.

## Layout

| File | Role |
| --- | --- |
| `src/harness.ts` | Every harness shape this package reads, with runtime guards. The single blast radius for upstream drift. |
| `src/cards.ts` | Tool-card mapping. A **registry**, not a switch: `registerCallCard` / `registerResultCard` return restore-disposers, so a deployment adds a card without patching this package. |
| `src/codec.ts` | Pure mappers (chunks, plans, usage, prompt content). |
| `src/grants.ts` | The self-built authorization cache. |
| `src/mcp.ts` | ACP `mcpServers` → `mcp-client` configuration, mounted per agent scope. |
| `src/config.ts` | Session config options. Also a **registry**: `registerSessionConfig` adds a selector without patching this package. |
| `src/index.ts` | The cordis plugin: a dispatch table over harness events, plus the ACP method surface. |
| `src/capabilities.ts` | One-shot probe behind `dsh-model-capabilities`: reports the reasoning efforts each route actually advertises, so clients need not hardcode them. |
| `scripts/verify-package.mjs` | Publish guard. Asserts the real `npm pack` output carries every file the manifest promises, so an unbuilt tree cannot reach the registry. |
