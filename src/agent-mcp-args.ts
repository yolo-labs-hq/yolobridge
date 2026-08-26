/**
 * Builds the COMMAND-LINE arguments that point a locally-spawned coding
 * agent at this attach's local MCP proxy (`mcp-proxy.ts`).
 *
 * Replaces the previous mechanism (2026-08-26), which wrote a
 * project-scoped `.mcp.json` (plus a companion `.claude/settings.local.json`
 * trust grant) into the `yolo-bridge attach` spawn `cwd` and deleted them
 * again on the way out. That design was wrong at the root, not merely
 * leaky:
 *
 *   - The file only ever WORKED inside a daemon-spawned agent. Its
 *     credential is a `${YOLOBRIDGE_MCP_PROXY_SECRET}` template, and only
 *     the process this daemon spawns inherits that variable.
 *   - Cleanup lived in a `finally`, which a `kill -9`, a crash, a reboot,
 *     or a wedged daemon simply skips. The leftover file then breaks the
 *     user's OWN standalone `claude` in that directory —
 *     "Missing environment variables: YOLOBRIDGE_MCP_PROXY_SECRET",
 *     `yolo-studio · ✘ failed` — for every session afterwards, because a
 *     dead loopback port and an unset variable look exactly like a
 *     misconfigured server. The operator hit this with two orphans.
 *   - A file in the project tree is reachable by the very agent this
 *     daemon spawns, running with YOLO-mode autonomy: `git add -A` at the
 *     wrong moment commits per-attach machine-local daemon state into a
 *     shared repo, which no `finally` can undo.
 *
 * Command-line configuration has none of those failure modes: the
 * configuration lives and dies with the process it configures, so there is
 * nothing to clean up, nothing to leak, nothing to commit, and nothing a
 * crash can leave behind. `attach` now writes NOTHING into the project
 * tree.
 *
 * ## The secret stays a TEMPLATE, never a literal
 *
 * argv is world-readable on this host (`ps -ef`, `/proc/<pid>/cmdline` is
 * mode 444), while `/proc/<pid>/environ` is owner-only. Inlining the real
 * per-attach secret into an argument would therefore publish a live
 * full-workspace credential to every other user on the machine — strictly
 * worse than the file it replaces, which at least was `chmod 600`.
 *
 * So both agents receive a REFERENCE to the environment variable, never
 * its value:
 *   - claude gets the literal four-character-plus string
 *     `${YOLOBRIDGE_MCP_PROXY_SECRET}` inside the inline JSON, which
 *     Claude Code expands against its own inherited process env at load
 *     time (verified empirically on the wire, 2026-08-26: a probe MCP
 *     server received the EXPANDED value from a `"${PROBE_SECRET}"`
 *     template passed via `--mcp-config`, not the literal template text).
 *   - codex gets the NAME of the variable via `bearer_token_env_var`,
 *     which is Codex's own sanctioned mechanism for exactly this. A
 *     variable name is not a secret.
 * `agent-mcp-args.test.ts` asserts the literal never appears in either
 * argv.
 *
 * ## Why codex needs the proxy's second auth location
 *
 * Codex's MCP client has ONE credential mechanism — `bearer_token_env_var`,
 * sent as `Authorization: Bearer <value>`. It has no custom-header support
 * whatsoever, so it cannot send `x-yolobridge-proxy-secret`. That is why
 * `mcp-proxy.ts` accepts the same secret from either location (see
 * `providedSecrets` there); it is one credential with two transports, both
 * compared by the same constant-time `secretsMatch`.
 *
 * ## Why every flag is probed before it is passed
 *
 * The user's locally-installed `claude`/`codex` can be arbitrarily old —
 * this daemon does not install or pin them. Both are strict argument
 * parsers that EXIT NON-ZERO on an unrecognized flag, so passing a flag an
 * old binary has never heard of does not degrade to "no MCP", it produces
 * a tile whose agent died at startup: a dead tile, and a worse outcome
 * than no MCP at all. Same reasoning (and same resolution) as
 * `terminalLaunch.argsIfSupported` in CLAUDE.md's "Agent install-on-demand"
 * rule: ask the installed binary what it advertises, and only pass what it
 * does.
 */

import { spawnSync } from 'node:child_process';
import { SECRET_HEADER, SECRET_ENV_VAR } from './mcp-proxy.js';

/** MCP server name the agent sees. Matches the in-pod writer
 *  (`containers/services/container-api/mcp-config-writer.js`) so a prompt
 *  written for a cloud session names the same server locally. */
export const MCP_SERVER_NAME = 'yolo-studio';

/**
 * The literal string embedded in claude's inline JSON in place of the real
 * secret. Kept as a named constant precisely so a test can assert the
 * TEMPLATE is present and the VALUE is not — the two assertions together
 * are what make "the secret never reaches argv" non-vacuous (a test that
 * only checked for the absence of the secret would also pass against an
 * empty argv).
 */
export const SECRET_TEMPLATE = `\${${SECRET_ENV_VAR}}`;

/** Wildcard permission entry for this server's tools. Shell-glob `*`, NOT
 *  a regex — Claude Code's permission matcher treats `*` as "any tool from
 *  this server"; a `.*` requires a literal dot no real
 *  `mcp__yolo-studio__<tool>` id has, and silently matches nothing. */
export const TOOL_PERMISSION_PATTERN = `mcp__${MCP_SERVER_NAME}__*`;

/** How long to wait for `<bin> --help`. Both real binaries answer in well
 *  under a second (measured 2026-08-26: claude 0.50s, codex 0.18s); this is
 *  a hang guard, not a tuned budget. A binary that cannot print its own
 *  help in 10s is treated as advertising nothing. */
const HELP_PROBE_TIMEOUT_MS = 10_000;

export interface AgentHelpProbe {
  /** True only if the binary ran and printed something. */
  ok: boolean;
  /** Combined stdout+stderr of `<bin> --help` (some CLIs print help to stderr). */
  text: string;
}

/**
 * Runs `<bin> --help` for real and returns what it printed.
 *
 * Deliberately a REAL subprocess with no injection seam (this package's
 * house rule: `src/*.test.ts` use the real filesystem and real
 * subprocesses). Tests exercise it by pointing `bin` at real executable
 * scripts that advertise, or don't advertise, the flags in question.
 *
 * stdin is `'ignore'` — a help probe must never be able to block waiting
 * for input. Every failure mode (ENOENT, a non-zero exit, the timeout
 * kill, a binary that prints nothing) collapses to `ok: false`, which the
 * callers below treat exactly like "advertises no flags": launch without
 * MCP rather than risk a dead tile.
 */
export function probeAgentHelp(bin: string): AgentHelpProbe {
  let result;
  try {
    result = spawnSync(bin, ['--help'], {
      encoding: 'utf-8',
      timeout: HELP_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Never a shell: `bin` can be an operator-supplied path (`--agent
      // /opt/bin/claude`) and must not be re-interpreted as a command line.
      shell: false,
    });
  } catch {
    return { ok: false, text: '' };
  }
  if (result.error) return { ok: false, text: '' };
  // A `timeout` kill reports signal SIGTERM with whatever partial output
  // arrived; treat it as no information rather than parsing a truncated
  // help page.
  if (result.signal) return { ok: false, text: '' };
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  // A non-zero exit is NOT automatically disqualifying (some CLIs exit 1
  // from `--help`), but an empty output is: there is nothing to read a
  // flag out of.
  if (text.trim() === '') return { ok: false, text: '' };
  return { ok: true, text };
}

/**
 * Whether `helpText` advertises `flag`.
 *
 * Matches the flag as a whole token (bounded on the right by a non
 * `[A-Za-z0-9-]` character or end of text) so `--mcp-config` is not
 * satisfied by a mention of `--mcp-config-something-else`, and
 * `--allowed-tools` is not satisfied by `--allowed-tools-file`. The left
 * boundary is the flag's own leading `--`.
 */
export function helpAdvertisesFlag(helpText: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9-])`).test(helpText);
}

export type AgentMcpArgs =
  | { ok: true; args: string[] }
  | { ok: false; reason: 'unsupported-agent' | 'flags-unsupported'; message: string };

export interface BuildAgentMcpArgsOptions {
  /** Registry identity (`--agent-id`, defaulted from `--agent`) — decides
   *  which config FORMAT to emit. Deliberately not the raw spawn string:
   *  `--agent /opt/bin/claude --agent-id claude` really is claude. */
  agentId: string;
  /** The binary actually spawned — what gets probed for flag support.
   *  A nonstandard path is exactly the case `--agent-id` exists for, and
   *  it is that PATH whose `--help` tells the truth about what it accepts. */
  agentBin: string;
  /** `http://127.0.0.1:<port>/mcp` from `McpProxyHandle.url`. */
  proxyUrl: string;
}

/**
 * The inline `--mcp-config` payload for claude. Exported so a test can
 * parse the exact JSON the agent will receive rather than re-deriving it.
 */
export function claudeMcpConfigJson(proxyUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: proxyUrl,
        // Template, never the value — see this module's header. Claude Code
        // expands `${VAR}` in inline `--mcp-config` JSON exactly as it does
        // in a `.mcp.json` file (verified on the wire, 2026-08-26).
        headers: { [SECRET_HEADER]: SECRET_TEMPLATE },
      },
    },
  });
}

/**
 * Builds the argv fragment that wires the spawned agent to `proxyUrl`, or
 * explains why it can't.
 *
 * NEVER throws and never returns a partially-applied configuration: an
 * agent this daemon has no config format for, or a binary too old to
 * advertise the flags, both come back `ok: false` and the caller launches
 * the agent with no MCP at all. A half-configured launch is the dead-tile
 * outcome this whole probe exists to avoid.
 */
export function buildAgentMcpArgs(opts: BuildAgentMcpArgsOptions): AgentMcpArgs {
  // No injection seam on purpose: this package's tests use real
  // subprocesses (see `probeAgentHelp`), so a stubbable probe would only
  // ever be a way to write a test that never proves the probe works.
  switch (opts.agentId) {
    case 'claude':
      return buildClaudeArgs(opts.proxyUrl, probeAgentHelp(opts.agentBin));
    case 'codex':
      return buildCodexArgs(opts.proxyUrl, probeAgentHelp(opts.agentBin));
    default:
      return {
        ok: false,
        reason: 'unsupported-agent',
        message: `no local MCP config format is implemented for agent id "${opts.agentId}"`,
      };
  }
}

/**
 * claude: `--mcp-config <inline JSON>` `--strict-mcp-config`
 * [`--allowedTools mcp__yolo-studio__*`].
 *
 * BOTH mcp flags are required, all-or-nothing. `--strict-mcp-config` is not
 * a nicety here: without it Claude Code ALSO loads whatever other MCP
 * configuration it finds, which on this operator's machine includes exactly
 * the orphaned `.mcp.json` files this change exists to stop producing — so
 * dropping it would leave the original "Missing environment variables"
 * failure in place on the very sessions this daemon spawns.
 *
 * `--allowedTools` is additive-if-supported rather than required: without
 * it every MCP tool call sits on an interactive approval prompt with nobody
 * watching (the job the deleted `.claude/settings.local.json` trust file
 * used to do, now done without touching the project tree), but MCP itself
 * still works if a human is present. Losing prompt-free operation is a
 * degrade; losing MCP entirely for want of it would not be.
 *
 * Argument ORDER matters: `--mcp-config <configs...>` and
 * `--allowedTools <tools...>` are both variadic, so each value is followed
 * either by another `--`-prefixed flag or by end-of-argv, never by a bare
 * token a variadic could swallow.
 */
function buildClaudeArgs(proxyUrl: string, help: AgentHelpProbe): AgentMcpArgs {
  const missing = ['--mcp-config', '--strict-mcp-config'].filter(
    (flag) => !help.ok || !helpAdvertisesFlag(help.text, flag),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'flags-unsupported',
      message: help.ok
        ? `the installed claude does not advertise ${missing.join(' / ')}`
        : 'the installed claude did not answer `--help`',
    };
  }
  const args = ['--mcp-config', claudeMcpConfigJson(proxyUrl), '--strict-mcp-config'];
  // Either spelling is accepted by current Claude Code; an older build may
  // advertise only one, so probe for both and pass whichever it names.
  const permissionFlag = ['--allowedTools', '--allowed-tools'].find((flag) =>
    helpAdvertisesFlag(help.text, flag),
  );
  if (permissionFlag) args.push(permissionFlag, TOOL_PERMISSION_PATTERN);
  return { ok: true, args };
}

/**
 * codex: two `-c` overrides against its flat `[mcp_servers.<name>]` TOML
 * schema. The `value` half of `-c key=value` is parsed as TOML, hence the
 * embedded double quotes making each one a TOML string.
 *
 * `bearer_token_env_var` names the variable; Codex reads it from its own
 * environment (which the PTY spawn sets, exactly as it already did for
 * claude) and sends `Authorization: Bearer <value>`. `codex mcp list`
 * reports this as "Auth: Bearer token".
 */
function buildCodexArgs(proxyUrl: string, help: AgentHelpProbe): AgentMcpArgs {
  if (!help.ok || !helpAdvertisesFlag(help.text, '--config')) {
    return {
      ok: false,
      reason: 'flags-unsupported',
      message: help.ok
        ? 'the installed codex does not advertise --config'
        : 'the installed codex did not answer `--help`',
    };
  }
  return {
    ok: true,
    args: [
      '-c',
      `mcp_servers.${MCP_SERVER_NAME}.url=${JSON.stringify(proxyUrl)}`,
      '-c',
      `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var=${JSON.stringify(SECRET_ENV_VAR)}`,
    ],
  };
}
