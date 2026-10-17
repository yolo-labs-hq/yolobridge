/** Bounded interactive options. Values stay argv entries, never shell text.
 * No configuration/MCP overrides, prompt injection or permission-mode changes.
 * This is a CLI compatibility surface, not an OS sandbox or security boundary.
 */
export function validateAgentCliOptions(agentId: string, args: readonly string[]): string | undefined {
  if (!args.length) return;
  if (args.length > 32 || args.some(arg => /[\u0000-\u001f\u007f]/.test(arg))) return 'Agent arguments must be at most 32 text tokens without control characters.';
  if (agentId !== 'claude' && agentId !== 'codex') return 'Agent CLI options currently support claude and codex only; use --agent-id for a custom executable path.';
  const supported = agentId === 'claude'
    ? '--model MODEL, --resume [SESSION], --continue (also -r and -c)'
    : '--model/-m MODEL, resume [SESSION|--last]';
  const unsupported = (position: number) => `Unsupported agent option at position ${position + 1}. Supported for ${agentId}: ${supported}.`;
  let resumed = false;
  let session = false;
  let last = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const inline = equals < 0 ? undefined : arg.slice(equals + 1);
    if (flag === '--model' || (agentId === 'codex' && flag === '-m')) {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('-')) return 'The agent --model option requires a non-empty model value.';
    } else if (agentId === 'claude' && (flag === '--resume' || flag === '-r')) {
      if (resumed) return 'Choose either --resume or --continue once.';
      resumed = true;
      if (inline !== undefined) { if (!inline || inline.startsWith('-')) return 'The agent --resume value must be non-empty.'; }
      else if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
    } else if (agentId === 'claude' && (arg === '--continue' || arg === '-c')) {
      if (resumed) return 'Choose either --resume or --continue once.';
      resumed = true;
    } else if (agentId === 'codex' && arg === 'resume' && !resumed) {
      resumed = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) { session = true; i++; }
    } else if (agentId === 'codex' && arg === '--last' && resumed && !session && !last) {
      last = true;
    } else return unsupported(i);
  }
}

/** Bridge-owned MCP options remain first; user options cannot replace them. */
export function composeAgentArgv(mcpArgs: readonly string[], userArgs: readonly string[]): string[] {
  return [...mcpArgs, ...userArgs];
}
