/**
 * Ambient declaration for the harness agent package's model-selection seam.
 *
 * Loaded dynamically for the same reason as the MCP client: a real type import
 * would make this package unbuildable without a harness workspace. The one
 * export used is `installModelSelection`, which couples a mutable selection
 * cell to an agent's prompt assembly and request routing.
 *
 * Its *contract* is restated in `src/config.ts` as {@link
 * HarnessModelSelectionRef}, so a drift in what the cell must carry surfaces
 * there rather than as an untyped `unknown` crossing the boundary.
 */
declare module '@deepseek-ai/dsh-agent' {
  export function installModelSelection(agentCtx: unknown, selection: unknown): () => void
}
