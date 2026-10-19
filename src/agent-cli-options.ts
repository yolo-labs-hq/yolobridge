/**
 * Bridge-owned MCP arguments remain first. Arguments after `attach --` are
 * opaque argv entries for the operator's selected executable: they are never
 * parsed, expanded, logged, or executed through a shell by Bridge.
 */
export function composeAgentArgv(mcpArgs: readonly string[], userArgs: readonly string[]): string[] {
  return [...mcpArgs, ...userArgs];
}
