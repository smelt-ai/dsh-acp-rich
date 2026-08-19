/**
 * Ambient declaration for the optional harness MCP client plugin.
 *
 * The module is an optional peer: it is loaded dynamically, only when a session
 * actually carries MCP servers, and its absence is a supported deployment. A
 * real type import would make this package fail to build without a harness
 * workspace, which is exactly the coupling the rest of the bridge avoids.
 *
 * Only the cordis plugin shape is declared, because mounting it is the only
 * thing this package does with it — the configuration it accepts is restated
 * and validated in `src/mcp.ts`, where a drift shows up as one failing test
 * instead of a silent shape mismatch.
 */
declare module '@deepseek-ai/dsh-mcp-client' {
  export const name: string
  export const inject: readonly string[]
  export function apply(ctx: unknown, config: unknown): void | Promise<void>
}
