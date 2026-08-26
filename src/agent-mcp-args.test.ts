/**
 * Tests for agent-mcp-args.ts — the command-line MCP configuration that
 * replaced the project-scoped `.mcp.json` writer (2026-08-26).
 *
 * Every `--help` probe here runs a REAL subprocess against a REAL
 * executable on disk (this package's house rule: no `node:child_process`
 * or `node:fs` mocks). The "old binary" cases are genuine little scripts
 * that print a genuine help page missing the flag in question — the same
 * shape a months-old install presents.
 *
 * Two of these are security assertions rather than behavioural ones (the
 * "never in argv" pair). They are written so that they cannot pass
 * vacuously: each one checks BOTH that the real secret is absent AND that
 * the reference that replaces it is present, so an argv that accidentally
 * became empty — or a builder that silently stopped emitting MCP config —
 * fails rather than passes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  buildAgentMcpArgs,
  claudeMcpConfigJson,
  probeAgentHelp,
  helpAdvertisesFlag,
  MCP_SERVER_NAME,
  SECRET_TEMPLATE,
  TOOL_PERMISSION_PATTERN,
} from './agent-mcp-args.js';
import { SECRET_HEADER, SECRET_ENV_VAR } from './mcp-proxy.js';

const PROXY_URL = 'http://127.0.0.1:41234/mcp';

/** Writes a REAL executable script that prints `helpText` for any
 *  invocation. Returns its absolute path. */
function fakeBinary(dir: string, name: string, helpText: string, opts: { exitCode?: number } = {}): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\ncat <<'HELP_EOF'\n${helpText}\nHELP_EOF\nexit ${opts.exitCode ?? 0}\n`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

/** Help page shaped like a current Claude Code build's. */
const MODERN_CLAUDE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --allowedTools, --allowed-tools <tools...>   Comma or space-separated list of tool names to allow',
  '  --mcp-config <configs...>                    Load MCP servers from JSON files or strings',
  '  --strict-mcp-config                          Only use MCP servers from --mcp-config',
].join('\n');

/** A months-old build: MCP existed, but only as a file path, and neither
 *  `--strict-mcp-config` nor `--allowedTools` had been introduced. */
const OLD_CLAUDE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --mcp-config <file>    Load MCP servers from a JSON file',
  '  --verbose              Override verbose mode setting',
].join('\n');

/** Older still: no MCP support of any kind. */
const ANCIENT_CLAUDE_HELP = [
  'Usage: claude [options] [prompt]',
  '  --verbose    Override verbose mode setting',
  '  --version    Output the version number',
].join('\n');

const MODERN_CODEX_HELP = [
  'Usage: codex [OPTIONS] [PROMPT]',
  '  -c, --config <key=value>   Override a configuration value',
  '      --enable <FEATURE>     Enable a feature',
].join('\n');

const OLD_CODEX_HELP = [
  'Usage: codex [OPTIONS] [PROMPT]',
  '      --model <MODEL>   Model to use',
].join('\n');

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'yolo-bridge-agent-args-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('probeAgentHelp (real subprocesses only)', () => {
  it('reads the real help page of a real binary — and correctly reports a flag it does NOT advertise', () => {
    // `node` is guaranteed present (it is running this test) and is a real,
    // unmocked third-party binary with a real help page. It advertises
    // `--version` and has never heard of `--mcp-config`, so this pins both
    // directions of the probe against something nobody wrote for this test.
    const probe = probeAgentHelp(process.execPath);
    assert.equal(probe.ok, true, 'node --help must be readable');
    assert.equal(helpAdvertisesFlag(probe.text, '--version'), true, 'node advertises --version');
    assert.equal(helpAdvertisesFlag(probe.text, '--mcp-config'), false, 'node does not advertise --mcp-config');
  });

  it('a binary that does not exist reports ok:false rather than throwing', () => {
    const probe = probeAgentHelp(join(tmpdir(), 'yolo-bridge-definitely-not-a-binary-1a2b3c'));
    assert.equal(probe.ok, false);
    assert.equal(probe.text, '');
  });

  it('a binary that prints nothing reports ok:false (there is no flag list to read)', () => {
    withTempDir((dir) => {
      const bin = join(dir, 'silent');
      writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(bin, 0o755);
      assert.equal(probeAgentHelp(bin).ok, false);
    });
  });

  it('a NON-ZERO exit that still printed help is usable (some CLIs exit 1 from --help)', () => {
    withTempDir((dir) => {
      const bin = fakeBinary(dir, 'grumpy', MODERN_CLAUDE_HELP, { exitCode: 1 });
      const probe = probeAgentHelp(bin);
      assert.equal(probe.ok, true);
      assert.equal(helpAdvertisesFlag(probe.text, '--strict-mcp-config'), true);
    });
  });
});

describe('helpAdvertisesFlag', () => {
  it('matches a whole flag token, not a longer flag that merely starts with it', () => {
    assert.equal(helpAdvertisesFlag('  --mcp-config-file <path>', '--mcp-config'), false);
    assert.equal(helpAdvertisesFlag('  --mcp-config <configs...>', '--mcp-config'), true);
    assert.equal(helpAdvertisesFlag('  --allowed-tools-file <path>', '--allowed-tools'), false);
    assert.equal(helpAdvertisesFlag('  --allowed-tools <tools...>', '--allowed-tools'), true);
  });

  it('matches a flag that ends the text with no trailing character', () => {
    assert.equal(helpAdvertisesFlag('  --strict-mcp-config', '--strict-mcp-config'), true);
  });
});

describe('buildAgentMcpArgs — claude', () => {
  it('emits inline --mcp-config JSON plus --strict-mcp-config, and NO file path', () => {
    withTempDir((dir) => {
      const bin = fakeBinary(dir, 'claude', MODERN_CLAUDE_HELP);
      const result = buildAgentMcpArgs({ agentId: 'claude', agentBin: bin, proxyUrl: PROXY_URL });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.deepEqual(result.args, [
        '--mcp-config',
        claudeMcpConfigJson(PROXY_URL),
        '--strict-mcp-config',
        '--allowedTools',
        TOOL_PERMISSION_PATTERN,
      ]);

      // The value passed is a JSON *string*, not a path to anything —
      // proving no file is involved at all.
      const parsed = JSON.parse(result.args[1]);
      assert.deepEqual(parsed, {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: 'http',
            url: PROXY_URL,
            headers: { [SECRET_HEADER]: SECRET_TEMPLATE },
          },
        },
      });
    });
  });

  it('every variadic flag value is followed by a flag or end-of-argv (nothing a variadic can swallow)', () => {
    withTempDir((dir) => {
      const bin = fakeBinary(dir, 'claude', MODERN_CLAUDE_HELP);
      const result = buildAgentMcpArgs({ agentId: 'claude', agentBin: bin, proxyUrl: PROXY_URL });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // `--mcp-config <configs...>` and `--allowedTools <tools...>` are both
      // variadic: each takes EXACTLY one value here, and the token after
      // that value must start with `-` or not exist.
      for (const variadic of ['--mcp-config', '--allowedTools']) {
        const at = result.args.indexOf(variadic);
        assert.notEqual(at, -1, `${variadic} present`);
        const after = result.args[at + 2];
        assert.ok(
          after === undefined || after.startsWith('-'),
          `${variadic}'s value must be followed by a flag or nothing, got ${JSON.stringify(after)}`,
        );
      }
    });
  });

  it('falls back to launching WITHOUT MCP when --strict-mcp-config is not advertised', () => {
    withTempDir((dir) => {
      const bin = fakeBinary(dir, 'claude', OLD_CLAUDE_HELP);
      const result = buildAgentMcpArgs({ agentId: 'claude', agentBin: bin, proxyUrl: PROXY_URL });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'flags-unsupported');
      assert.match(result.message, /--strict-mcp-config/);
    });
  });

  it('falls back to launching WITHOUT MCP when the binary has no MCP flags at all', () => {
    withTempDir((dir) => {
      const bin = fakeBinary(dir, 'claude', ANCIENT_CLAUDE_HELP);
      const result = buildAgentMcpArgs({ agentId: 'claude', agentBin: bin, proxyUrl: PROXY_URL });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.message, /--mcp-config/);
    });
  });

  it('falls back to launching WITHOUT MCP when the binary cannot be run at all', () => {
    const result = buildAgentMcpArgs({
      agentId: 'claude',
      agentBin: join(tmpdir(), 'yolo-bridge-definitely-not-a-binary-9z8y7x'),
      proxyUrl: PROXY_URL,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'flags-unsupported');
    assert.match(result.message, /did not answer/);
  });

  it('keeps MCP but drops ONLY the permission flag when --allowedTools is not advertised', () => {
    withTempDir((dir) => {
      const help = [
        'Usage: claude [options] [prompt]',
        '  --mcp-config <configs...>   Load MCP servers from JSON files or strings',
        '  --strict-mcp-config         Only use MCP servers from --mcp-config',
      ].join('\n');
      const bin = fakeBinary(dir, 'claude', help);
      const result = buildAgentMcpArgs({ agentId: 'claude', agentBin: bin, proxyUrl: PROXY_URL });
      assert.equal(result.ok, true, 'a missing permission flag must not cost us MCP entirely');
      if (!result.ok) return;
      assert.deepEqual(result.args, ['--mcp-config', claudeMcpConfigJson(PROXY_URL), '--strict-mcp-config']);
      assert.equal(result.args.includes(TOOL_PERMISSION_PATTERN), false);
    });
  });

  it('uses the hyphenated --allowed-tools spelling when that is the one advertised', () => {
    withTempDir((dir) => {
      const help = [
        'Usage: claude [options] [prompt]',
        '  --allowed-tools <tools...>  Tools to allow',
        '  --mcp-config <configs...>   Load MCP servers from JSON files or strings',
        '  --strict-mcp-config         Only use MCP servers from --mcp-config',
      ].join('\n');
      const bin = fakeBinary(dir, 'claude', help);
      const result = buildAgentMcpArgs({ agentId: 'claude', agentBin: bin, proxyUrl: PROXY_URL });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.args.includes('--allowed-tools'), true);
      assert.equal(result.args.includes('--allowedTools'), false);
    });
  });
});

describe('buildAgentMcpArgs — codex', () => {
  it('emits the two flat-TOML -c overrides, with the env var NAME (never a value)', () => {
    withTempDir((dir) => {
      const bin = fakeBinary(dir, 'codex', MODERN_CODEX_HELP);
      const result = buildAgentMcpArgs({ agentId: 'codex', agentBin: bin, proxyUrl: PROXY_URL });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(result.args, [
        '-c',
        `mcp_servers.yolo-studio.url="${PROXY_URL}"`,
        '-c',
        'mcp_servers.yolo-studio.bearer_token_env_var="YOLOBRIDGE_MCP_PROXY_SECRET"',
      ]);
    });
  });

  it('falls back to launching WITHOUT MCP when --config is not advertised', () => {
    withTempDir((dir) => {
      const bin = fakeBinary(dir, 'codex', OLD_CODEX_HELP);
      const result = buildAgentMcpArgs({ agentId: 'codex', agentBin: bin, proxyUrl: PROXY_URL });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'flags-unsupported');
    });
  });
});

describe('buildAgentMcpArgs — an agent with no implemented format', () => {
  it('returns unsupported-agent without even probing the binary', () => {
    const result = buildAgentMcpArgs({
      agentId: 'opencode-yolo',
      // A path that does not exist: reaching the probe at all would still
      // report `flags-unsupported`, so `unsupported-agent` proves the
      // format check happened first.
      agentBin: join(tmpdir(), 'yolo-bridge-definitely-not-a-binary-4d5e6f'),
      proxyUrl: PROXY_URL,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'unsupported-agent');
    assert.match(result.message, /opencode-yolo/);
  });
});

describe('SECURITY: the literal secret never reaches argv', () => {
  // argv is world-readable on Linux (`ps -ef`, `/proc/<pid>/cmdline` is mode
  // 444); `/proc/<pid>/environ` is owner-only. Inlining the real per-attach
  // secret into an argument would publish a live full-workspace credential
  // to every other user on the machine. This is the whole reason the
  // template/env-var-name indirection exists, so it gets an explicit test
  // per agent rather than being left implied by the deepEqual assertions
  // above.
  //
  // Each assertion is PAIRED with a positive one (the reference IS there),
  // so an argv that became empty — or a builder that stopped emitting MCP
  // config entirely — fails instead of passing vacuously.
  const originalSecret = process.env[SECRET_ENV_VAR];

  function withSecretInEnv<T>(fn: (secret: string) => T): T {
    // A realistic per-attach secret, present in the environment exactly as
    // it is at spawn time — so a builder that reads it would find it.
    const secret = randomBytes(32).toString('hex');
    process.env[SECRET_ENV_VAR] = secret;
    try {
      return fn(secret);
    } finally {
      if (originalSecret === undefined) delete process.env[SECRET_ENV_VAR];
      else process.env[SECRET_ENV_VAR] = originalSecret;
    }
  }

  it('claude argv carries the ${VAR} template, and nowhere the secret itself', () => {
    withTempDir((dir) => {
      withSecretInEnv((secret) => {
        const bin = fakeBinary(dir, 'claude', MODERN_CLAUDE_HELP);
        const result = buildAgentMcpArgs({ agentId: 'claude', agentBin: bin, proxyUrl: PROXY_URL });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        // Positive half — it actually happened: MCP really is configured,
        // via a real reference to the variable.
        assert.equal(
          result.args.some((a) => a.includes(SECRET_TEMPLATE)),
          true,
          'claude argv must carry the ${YOLOBRIDGE_MCP_PROXY_SECRET} template',
        );
        // Negative half — the security property itself.
        for (const arg of result.args) {
          assert.equal(arg.includes(secret), false, `argv element leaked the secret: ${arg}`);
        }
        assert.equal(result.args.join(' ').includes(secret), false, 'no argv element may contain the secret');
      });
    });
  });

  it('codex argv carries the env var NAME, and nowhere the secret itself', () => {
    withTempDir((dir) => {
      withSecretInEnv((secret) => {
        const bin = fakeBinary(dir, 'codex', MODERN_CODEX_HELP);
        const result = buildAgentMcpArgs({ agentId: 'codex', agentBin: bin, proxyUrl: PROXY_URL });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(
          result.args.some((a) => a.includes(`bearer_token_env_var="${SECRET_ENV_VAR}"`)),
          true,
          'codex argv must name the env var to read the bearer token from',
        );
        for (const arg of result.args) {
          assert.equal(arg.includes(secret), false, `argv element leaked the secret: ${arg}`);
        }
        assert.equal(result.args.join(' ').includes(secret), false, 'no argv element may contain the secret');
      });
    });
  });
});

describe('the real installed binaries accept what we build for them', () => {
  // Not a hermetic unit test — an interop check against whatever `claude` /
  // `codex` this machine actually has. Skipped (not failed) where they are
  // absent, since this package must be testable on a machine with neither.
  function installedPath(bin: string): string | undefined {
    try {
      return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf-8' }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  it('the installed claude advertises every flag we probe for', (t) => {
    const bin = installedPath('claude');
    if (!bin) return t.skip('claude is not installed on this machine');
    const result = buildAgentMcpArgs({ agentId: 'claude', agentBin: bin, proxyUrl: PROXY_URL });
    assert.equal(result.ok, true, `the installed claude should support inline MCP config: ${JSON.stringify(result)}`);
    if (!result.ok) return;
    assert.equal(result.args.includes('--strict-mcp-config'), true);
  });

  it('the installed codex advertises --config', (t) => {
    const bin = installedPath('codex');
    if (!bin) return t.skip('codex is not installed on this machine');
    const result = buildAgentMcpArgs({ agentId: 'codex', agentBin: bin, proxyUrl: PROXY_URL });
    assert.equal(result.ok, true, `the installed codex should support -c overrides: ${JSON.stringify(result)}`);
  });
});
