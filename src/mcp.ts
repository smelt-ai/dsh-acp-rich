/**
 * MCP server passthrough: ACP `session/new` and `session/load` carry the MCP
 * servers the client wants the agent to reach, and the harness reaches external
 * MCP servers through the `mcp-client` plugin. This module maps between the two
 * and mounts the result on the per-agent scope.
 *
 * This matters more than "one more feature". smelt injects exactly one stdio
 * server — its own agent bus, named `smelt` — into every session it opens
 * (`acp_conn.rs`, `McpServerStdio::new("smelt", …)`). Dropping `mcpServers` on
 * the floor is therefore not a missing extra; it silently removes cross-agent
 * messaging from every dsh session while the session still looks healthy.
 *
 * @module
 */

import type { HarnessAgentContext } from './harness.ts'

/** Environment entry as ACP spells it. */
export interface AcpEnvVariable {
  name: string
  value: string
}

/** HTTP header as ACP spells it. */
export interface AcpHttpHeader {
  name: string
  value: string
}

/**
 * One MCP server from an ACP session request.
 *
 * ACP tags http/sse/acp explicitly and leaves stdio untagged as the default
 * variant, so the discriminant is absent exactly when the shape is stdio.
 */
export type AcpMcpServer =
  | { type?: undefined; name: string; command: string; args?: string[]; env?: AcpEnvVariable[] }
  | { type: 'http'; name: string; url: string; headers?: AcpHttpHeader[] }
  | { type: 'sse'; name: string; url: string; headers?: AcpHttpHeader[] }
  | { type: 'acp'; name: string }

/** The `mcp-client` plugin's stdio configuration. */
export interface McpClientStdioConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
}

/** The `mcp-client` plugin's Streamable-HTTP configuration. */
export interface McpClientHttpConfig {
  transport: 'streamable-http'
  serverName: string
  url: string
  headers: Record<string, string>
}

/** Configuration accepted by one `mcp-client` instance. */
export type McpClientConfig = McpClientStdioConfig | McpClientHttpConfig

/**
 * Mount MCP servers onto an unpublished agent scope.
 *
 * @param agentCtx - the per-agent cordis scope; disposal unmounts the servers.
 * @param servers - configurations to mount, already mapped and validated.
 */
export type McpMounter = (
  agentCtx: HarnessAgentContext,
  servers: readonly McpClientConfig[],
) => Promise<void>

/** `serverName` budget imposed by the `mcp-client` plugin. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Coerce an ACP server name into the plugin's `serverName` alphabet.
 *
 * The name is model-facing (tools land at `mcp__<serverName>__<rawName>`), so
 * the mapping has to be deterministic — the same client name must produce the
 * same tool names on every run, or a resumed transcript stops matching the live
 * tool registry. Substitution is character-wise and the truncation is a plain
 * prefix, so `smelt` — the only name smelt itself sends — passes through
 * untouched.
 */
export function toServerName(name: string): string | undefined {
  if (SERVER_NAME_PATTERN.test(name)) return name
  const coerced = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  return SERVER_NAME_PATTERN.test(coerced) ? coerced : undefined
}

/** Collapse ACP's name/value pair list into the record shape the plugin takes. */
function toRecord(entries: readonly { name: string; value: string }[] | undefined): Record<string, string> {
  const record: Record<string, string> = {}
  for (const entry of entries ?? []) record[entry.name] = entry.value
  return record
}

/** Why a server could not be mapped, for a diagnostic the operator can act on. */
export interface McpRejection {
  name: string
  reason: string
}

/** Outcome of mapping a session's MCP servers. */
export interface McpMapping {
  mounted: McpClientConfig[]
  rejected: McpRejection[]
}

/**
 * Map ACP MCP servers onto `mcp-client` configurations.
 *
 * Unsupported transports are collected rather than thrown: refusing the whole
 * session because one optional server uses `sse` would be a worse outcome than
 * a session that runs with the servers it could reach and says which it could
 * not. The capability report (`mcpCapabilities`) tells honest clients up front,
 * so anything landing here came from a client that ignored it.
 *
 * @param servers - the `mcpServers` field of a session request.
 * @param cwd - session working directory, inherited by stdio children.
 */
export function mapMcpServers(servers: readonly AcpMcpServer[], cwd: string): McpMapping {
  const mounted: McpClientConfig[] = []
  const rejected: McpRejection[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    const serverName = toServerName(server.name)
    if (serverName === undefined) {
      rejected.push({ name: server.name, reason: 'name has no valid mcp-client namespace' })
      continue
    }
    if (seen.has(serverName)) {
      // The plugin treats a duplicate namespace as a load-time configuration
      // error that would fail the whole agent scope, so it is caught here where
      // the blast radius is one server.
      rejected.push({ name: server.name, reason: `duplicate namespace ${serverName}` })
      continue
    }
    if (server.type === undefined) {
      seen.add(serverName)
      mounted.push({
        transport: 'stdio',
        serverName,
        command: server.command,
        args: server.args ?? [],
        env: toRecord(server.env),
        cwd,
      })
      continue
    }
    if (server.type === 'http') {
      seen.add(serverName)
      mounted.push({
        transport: 'streamable-http',
        serverName,
        url: server.url,
        headers: toRecord(server.headers),
      })
      continue
    }
    rejected.push({ name: server.name, reason: `unsupported transport ${server.type}` })
  }
  return { mounted, rejected }
}

/**
 * Default mounter: load `@deepseek-ai/dsh-mcp-client` and add one instance per
 * server to the agent scope.
 *
 * The import is dynamic and optional on purpose. This package declares no hard
 * dependency on the harness, and a profile that composes no MCP client is a
 * legitimate deployment; a static import would make that profile fail to load
 * the bridge at all. When the plugin is genuinely absent the session still
 * opens — degraded, and loudly.
 */
export const defaultMcpMounter: McpMounter = async (agentCtx, servers) => {
  if (servers.length === 0) return
  const plugin = await import('@deepseek-ai/dsh-mcp-client')
  for (const server of servers) agentCtx.plugin(plugin, server)
}
