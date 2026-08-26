/**
 * End-to-end acceptance test for the 2026-08-26 change: a FULL
 * `yolo-bridge attach` — the real built CLI, spawned as a real subprocess,
 * against a real HTTP server, spawning a real agent under a real PTY —
 * must write NOTHING into the project tree, and must reach the local MCP
 * proxy with a secret that never appeared in its own argv.
 *
 * Nothing is mocked. The fakes here are all real things:
 *   - a real `node:http` server standing in for common-api AND for the
 *     upstream yolo-studio MCP endpoint,
 *   - a real executable script standing in for `claude`, which answers a
 *     real `--help` probe and then makes a real HTTP request to the proxy
 *     using the config it was handed on its command line,
 *   - a real temporary HOME holding a real `auth.json`.
 *
 * The point of driving the WHOLE cli rather than the MCP-setup helper in
 * isolation is the first assertion: "writes nothing" is a claim about
 * every code path an attach runs, and only a full attach can support it.
 * Asserting the project directory is byte-for-byte unchanged (rather than
 * merely that `.mcp.json` is absent) is what makes it a claim about the
 * whole tree and not about one filename somebody remembered.
 *
 * Runs against `dist/` — `npm test` builds first (package.json's `test`
 * script), same convention as cli-symlink-invocation.test.ts.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, chmodSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
const WORKSPACE_ID = 'a'.repeat(24);

/** Recursive snapshot of every path under `root`, with file contents and
 *  mode. Deliberately not "is `.mcp.json` absent?" — the acceptance claim
 *  is that the directory is UNCHANGED, which a snapshot comparison proves
 *  for files nobody thought to name. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const key = relative(root, full);
      if (entry.isDirectory()) {
        out[`${key}/`] = 'dir';
        walk(full);
      } else {
        const st = statSync(full);
        out[key] = `${(st.mode & 0o777).toString(8)}:${readFileSync(full, 'utf-8')}`;
      }
    }
  };
  walk(root);
  return out;
}

interface Recorded {
  argv: string[];
  secretFromEnv: string;
  proxyUrl: string;
  proxyStatus: number;
  proxyBody: string;
  strictFlagPresent: boolean;
}

/**
 * A real executable that behaves enough like Claude Code to prove the
 * whole chain: it answers `--help` with a genuine flag list, then uses the
 * inline `--mcp-config` it was handed — expanding `${VAR}` from its own
 * environment exactly as Claude Code does — to make a real request to the
 * local proxy, and records what happened somewhere OUTSIDE the project
 * tree so the snapshot assertion stays honest.
 */
function writeFakeClaude(path: string, recordPath: string): void {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);

if (argv.includes('--help')) {
  process.stdout.write([
    'Usage: claude [options] [command] [prompt]',
    '  --allowedTools, --allowed-tools <tools...>  Tools to allow',
    '  --mcp-config <configs...>                   Load MCP servers from JSON files or strings',
    '  --strict-mcp-config                         Only use MCP servers from --mcp-config',
    '',
  ].join('\\n'));
  process.exit(0);
}

async function main() {
  const record = {
    argv,
    secretFromEnv: process.env.YOLOBRIDGE_MCP_PROXY_SECRET || '',
    proxyUrl: '',
    proxyStatus: 0,
    proxyBody: '',
    strictFlagPresent: argv.includes('--strict-mcp-config'),
  };
  try {
    const at = argv.indexOf('--mcp-config');
    const cfg = JSON.parse(argv[at + 1]);
    const server = cfg.mcpServers['yolo-studio'];
    record.proxyUrl = server.url;
    // Exactly what Claude Code does with a \${VAR} template in an MCP
    // config: expand it against this process's own inherited environment.
    const headers = { 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(server.headers || {})) {
      headers[k] = String(v).replace(/\\$\\{([A-Z0-9_]+)\\}/g, (_m, name) => process.env[name] || '');
    }
    const res = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles', arguments: {} } }),
    });
    record.proxyStatus = res.status;
    record.proxyBody = await res.text();
  } catch (err) {
    record.proxyBody = 'ERROR: ' + (err && err.stack ? err.stack : String(err));
  }
  fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record));
  process.stdout.write('fake-claude done\\n');
}

main().then(() => process.exit(0), () => process.exit(1));
`;
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/**
 * A real executable behaving like Codex: a codex-shaped `--help`, then the
 * `-c mcp_servers.*` overrides turned into a real request carrying
 * `Authorization: Bearer <value of the named env var>` — which is the ONLY
 * credential form Codex's MCP client can produce, and therefore the reason
 * `mcp-proxy.ts` accepts a bearer token at all.
 */
function writeFakeCodex(path: string, recordPath: string): void {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);

if (argv.includes('--help')) {
  process.stdout.write([
    'Usage: codex [OPTIONS] [PROMPT]',
    '  -c, --config <key=value>   Override a configuration value',
    '',
  ].join('\\n'));
  process.exit(0);
}

function tomlOverride(key) {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '-c' && argv[i] !== '--config') continue;
    const eq = argv[i + 1].indexOf('=');
    if (eq === -1) continue;
    if (argv[i + 1].slice(0, eq) !== key) continue;
    // The value half is TOML; every value we emit is a TOML string.
    return JSON.parse(argv[i + 1].slice(eq + 1));
  }
  return undefined;
}

async function main() {
  const record = {
    argv,
    secretFromEnv: process.env.YOLOBRIDGE_MCP_PROXY_SECRET || '',
    proxyUrl: '',
    proxyStatus: 0,
    proxyBody: '',
    strictFlagPresent: false,
  };
  try {
    record.proxyUrl = tomlOverride('mcp_servers.yolo-studio.url');
    const envVarName = tomlOverride('mcp_servers.yolo-studio.bearer_token_env_var');
    const bearer = process.env[envVarName] || '';
    const res = await fetch(record.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles', arguments: {} } }),
    });
    record.proxyStatus = res.status;
    record.proxyBody = await res.text();
  } catch (err) {
    record.proxyBody = 'ERROR: ' + (err && err.stack ? err.stack : String(err));
  }
  fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record));
  process.stdout.write('fake-codex done\\n');
}

main().then(() => process.exit(0), () => process.exit(1));
`;
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/**
 * A months-old install: a real binary, with a real help page that has never
 * heard of `--mcp-config`. Records whatever argv it was given so the test
 * can prove it was launched CLEANLY — the whole point of probing is that
 * this binary starts normally instead of dying on an unknown flag.
 */
function writeAncientClaude(path: string, recordPath: string): void {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write('Usage: claude [options] [prompt]\\n  --verbose  Override verbose mode\\n');
  process.exit(0);
}
// A strict parser: anything it does not recognise is fatal, exactly like
// the real thing. If yolo-bridge passed an unsupported flag, this exits 2
// and the tile is dead.
for (const arg of argv) {
  if (arg.startsWith('-')) {
    process.stderr.write('error: unexpected argument ' + arg + '\\n');
    process.exit(2);
  }
}
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  argv,
  secretFromEnv: process.env.YOLOBRIDGE_MCP_PROXY_SECRET || '',
  proxyUrl: '',
  proxyStatus: 0,
  proxyBody: '',
  strictFlagPresent: false,
}));
process.stdout.write('ancient-claude launched\\n');
process.exit(0);
`;
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
}

interface Harness {
  root: string;
  projectDir: string;
  recordPath: string;
  server: http.Server;
  baseUrl: string;
  upstreamCalls: Array<{ authorization?: string; secretHeader?: string; body: string }>;
  detachCalls: number;
}

let h: Harness;

before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'yolo-bridge-e2e-'));
  const homeDir = join(root, 'home');
  const projectDir = join(root, 'project');
  const binDir = join(root, 'bin');
  mkdirSync(join(homeDir, '.config', 'yolobridge'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(
    join(homeDir, '.config', 'yolobridge', 'auth.json'),
    JSON.stringify({ accessToken: 'account-token', tokenType: 'Bearer', expiresAtMs: Date.now() + 24 * 3600_000 }),
  );

  // Pre-existing project content, including a `.mcp.json` the OPERATOR
  // owns. The old mechanism merged its own entry into exactly this file;
  // the new one must leave every byte of it alone.
  writeFileSync(join(projectDir, 'README.md'), '# a real project\n');
  writeFileSync(
    join(projectDir, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { 'operators-own-server': { type: 'http', url: 'http://example.test/mcp' } } }, null, 2)}\n`,
  );
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const x = 1;\n');

  const recordPath = join(root, 'agent-record.json');
  writeFakeClaude(join(binDir, 'fake-claude'), recordPath);
  writeFakeCodex(join(binDir, 'fake-codex'), join(root, 'codex-record.json'));
  writeAncientClaude(join(binDir, 'fake-ancient-claude'), join(root, 'ancient-record.json'));

  const upstreamCalls: Harness['upstreamCalls'] = [];
  const state = { detachCalls: 0 };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const url = req.url ?? '';
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'POST' && url.endsWith('/yolobridge/attach')) {
        return json(200, {
          tileId: 'tile-1',
          attachmentId: 'attachment-1',
          scopedToken: 'scoped-token',
          scopedTokenExpiresAt: Date.now() + 3600_000,
        });
      }
      if (req.method === 'DELETE' && url.includes('/yolobridge/attach/')) {
        state.detachCalls++;
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && url.includes('/yolobridge/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('event: connected\ndata: {"type":"connected"}\n\n');
        // Held open, keepalives only — exactly how the real server behaves.
        const ping = setInterval(() => res.write(': ping\n\n'), 200);
        res.on('close', () => clearInterval(ping));
        return undefined;
      }
      if (req.method === 'POST' && url.endsWith('/yolobridge/events')) {
        return json(200, { recorded: true });
      }
      if (req.method === 'GET' && url.endsWith('/v1/mcp/scopes')) {
        return json(200, { scopes: ['studio.list_tiles', 'studio.send_to_tile'] });
      }
      if (req.method === 'POST' && url.endsWith('/v1/mcp/tokens')) {
        return json(201, {
          token: 'delegated-token',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          jti: 'jti-1',
          claims: { workspaceId: WORKSPACE_ID, userId: 'u1', agentId: 'claude', scopes: ['studio.list_tiles'] },
        });
      }
      if (req.method === 'POST' && url === '/mcp') {
        upstreamCalls.push({
          authorization: req.headers.authorization,
          secretHeader: req.headers['x-yolobridge-proxy-secret'] as string | undefined,
          body,
        });
        return json(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'tiles' }] } });
      }
      return json(404, { error: `unhandled ${req.method} ${url}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  h = {
    root,
    projectDir,
    recordPath,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    upstreamCalls,
    get detachCalls() { return state.detachCalls; },
  } as Harness;
});

after(async () => {
  if (h?.server) await new Promise<void>((resolve) => h.server.close(() => resolve()));
  if (h?.root) rmSync(h.root, { recursive: true, force: true });
});

/** Runs the real CLI to completion. The fake agent exits on its own, which
 *  is what ends the attach — no signal, no kill, so every `finally` and
 *  cleanup path this change touched actually runs. */
function runAttach(
  projectDir: string,
  agent: { bin: string; id: string } = { bin: 'fake-claude', id: 'claude' },
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, 'attach', WORKSPACE_ID, '--agent', join(h.root, 'bin', agent.bin), '--agent-id', agent.id],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          HOME: join(h.root, 'home'),
          YOLOBRIDGE_API_URL: h.baseUrl,
          YOLOBRIDGE_MCP_URL: h.baseUrl,
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stdout += String(d); });
    const killer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(killer); resolve({ code, stdout }); });
  });
}

describe('a full `yolo-bridge attach`', () => {
  let recorded: Recorded;
  let before_: Record<string, string>;
  let after_: Record<string, string>;
  let cliStdout: string;

  it('runs to completion with the agent driving the whole lifecycle', async () => {
    before_ = snapshot(h.projectDir);
    const result = await runAttach(h.projectDir);
    after_ = snapshot(h.projectDir);
    cliStdout = result.stdout;
    assert.equal(result.code, 0, `cli should exit cleanly; output was:\n${result.stdout}`);
    assert.ok(existsSync(h.recordPath), `the fake agent must have run and recorded; cli output was:\n${result.stdout}`);
    recorded = JSON.parse(readFileSync(h.recordPath, 'utf-8')) as Recorded;
  });

  it('writes NOTHING into the project tree — the directory is byte-for-byte unchanged', () => {
    // Guard against a vacuous pass: the snapshot must actually contain the
    // files we seeded, or "unchanged" would just be comparing two empty
    // objects.
    assert.ok(Object.keys(before_).length >= 4, `snapshot should see the seeded project, got ${JSON.stringify(before_)}`);
    assert.ok('.mcp.json' in before_, 'the seeded operator-owned .mcp.json must be in the snapshot');
    assert.deepEqual(after_, before_, 'attach must not create, modify, or delete anything in the project tree');
  });

  it("leaves the operator's own pre-existing .mcp.json untouched", () => {
    const onDisk = JSON.parse(readFileSync(join(h.projectDir, '.mcp.json'), 'utf-8'));
    assert.deepEqual(Object.keys(onDisk.mcpServers), ['operators-own-server']);
  });

  it('never created a .claude/ trust directory either', () => {
    assert.equal(existsSync(join(h.projectDir, '.claude')), false);
  });

  it('handed the agent inline --mcp-config plus --strict-mcp-config on its command line', () => {
    assert.equal(recorded.argv.includes('--strict-mcp-config'), true, `argv was ${JSON.stringify(recorded.argv)}`);
    const at = recorded.argv.indexOf('--mcp-config');
    assert.notEqual(at, -1);
    const cfg = JSON.parse(recorded.argv[at + 1]);
    assert.equal(cfg.mcpServers['yolo-studio'].type, 'http');
    assert.match(cfg.mcpServers['yolo-studio'].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(cfg.mcpServers['yolo-studio'].headers['x-yolobridge-proxy-secret'], '${YOLOBRIDGE_MCP_PROXY_SECRET}');
    assert.equal(recorded.argv.includes('--allowedTools'), true);
    assert.equal(recorded.argv.includes('mcp__yolo-studio__*'), true);
  });

  it('SECURITY: the real per-attach secret reached the agent via the ENVIRONMENT and never via argv', () => {
    // Positive half — the secret genuinely exists and genuinely reached the
    // spawned process, so the negative half below is a real absence and not
    // an absence of anything to find.
    assert.match(recorded.secretFromEnv, /^[0-9a-f]{32,}$/, 'the agent must inherit a real per-attach secret');
    // Negative half — the security property. argv is world-readable via
    // `ps` / `/proc/<pid>/cmdline`; `/proc/<pid>/environ` is owner-only.
    for (const arg of recorded.argv) {
      assert.equal(arg.includes(recorded.secretFromEnv), false, `argv leaked the secret: ${arg}`);
    }
    assert.equal(recorded.argv.join(' ').includes(recorded.secretFromEnv), false);
    // And not into the CLI's own console output either.
    assert.equal(cliStdout.includes(recorded.secretFromEnv), false, 'the secret must not be logged');
  });

  it('the agent reached the local proxy end to end, authenticated, and the call was forwarded upstream', () => {
    assert.equal(recorded.proxyStatus, 200, `proxy call failed: ${recorded.proxyBody}`);
    // "It actually happened": a 200 from the proxy is only meaningful if
    // the request really was forwarded to the upstream MCP server.
    assert.equal(h.upstreamCalls.length, 1, 'exactly one tools/call should have reached the upstream');
    const upstream = h.upstreamCalls[0];
    assert.match(upstream.body, /studio_list_tiles/);
    // The proxy injects its own delegated token and never forwards the
    // caller's proxy credential upstream.
    assert.equal(upstream.secretHeader, undefined, 'the proxy secret must not be forwarded upstream');
    assert.match(upstream.body, /delegated-token/);
  });
});

describe('a full `yolo-bridge attach` with codex', () => {
  let recorded: Recorded;
  let before_: Record<string, string>;
  let after_: Record<string, string>;
  let upstreamBefore = 0;

  it('runs to completion and reaches the proxy over the bearer path', async () => {
    before_ = snapshot(h.projectDir);
    upstreamBefore = h.upstreamCalls.length;
    const result = await runAttach(h.projectDir, { bin: 'fake-codex', id: 'codex' });
    after_ = snapshot(h.projectDir);
    assert.equal(result.code, 0, `cli should exit cleanly; output was:\n${result.stdout}`);
    const recordPath = join(h.root, 'codex-record.json');
    assert.ok(existsSync(recordPath), `the fake codex must have run; cli output was:\n${result.stdout}`);
    recorded = JSON.parse(readFileSync(recordPath, 'utf-8')) as Recorded;

    assert.equal(recorded.proxyStatus, 200, `proxy rejected codex's bearer token: ${recorded.proxyBody}`);
    // "It actually happened": the bearer-authenticated call really was
    // forwarded, with the proxy's own delegated token injected.
    assert.equal(h.upstreamCalls.length, upstreamBefore + 1, 'codex tools/call must reach the upstream');
    assert.match(h.upstreamCalls[h.upstreamCalls.length - 1].body, /delegated-token/);
  });

  it('writes NOTHING into the project tree', () => {
    assert.ok(Object.keys(before_).length >= 4);
    assert.deepEqual(after_, before_);
  });

  it('was configured with flat-TOML -c overrides naming the env var, not its value', () => {
    const url = recorded.argv[recorded.argv.indexOf('-c') + 1];
    assert.match(url, /^mcp_servers\.yolo-studio\.url="http:\/\/127\.0\.0\.1:\d+\/mcp"$/);
    assert.equal(
      recorded.argv.includes('mcp_servers.yolo-studio.bearer_token_env_var="YOLOBRIDGE_MCP_PROXY_SECRET"'),
      true,
      `argv was ${JSON.stringify(recorded.argv)}`,
    );
  });

  it('SECURITY: the real per-attach secret reached codex via the ENVIRONMENT and never via argv', () => {
    assert.match(recorded.secretFromEnv, /^[0-9a-f]{32,}$/, 'codex must inherit a real per-attach secret');
    for (const arg of recorded.argv) {
      assert.equal(arg.includes(recorded.secretFromEnv), false, `argv leaked the secret: ${arg}`);
    }
    assert.equal(recorded.argv.join(' ').includes(recorded.secretFromEnv), false);
  });
});

describe('a full `yolo-bridge attach` against a binary too old to advertise the flags', () => {
  let recorded: Recorded;
  let before_: Record<string, string>;
  let after_: Record<string, string>;
  let stdout = '';

  it('still launches the agent — cleanly, with no MCP flags — instead of producing a dead tile', async () => {
    before_ = snapshot(h.projectDir);
    const result = await runAttach(h.projectDir, { bin: 'fake-ancient-claude', id: 'claude' });
    after_ = snapshot(h.projectDir);
    stdout = result.stdout;
    assert.equal(result.code, 0, `cli should exit cleanly; output was:\n${result.stdout}`);

    const recordPath = join(h.root, 'ancient-record.json');
    // The old binary exits 2 on ANY flag it does not recognise, so the mere
    // existence of this record proves it was launched with none.
    assert.ok(existsSync(recordPath), `the old binary must have launched; cli output was:\n${result.stdout}`);
    recorded = JSON.parse(readFileSync(recordPath, 'utf-8')) as Recorded;
    assert.deepEqual(recorded.argv, [], 'an old binary must receive no MCP flags at all');
  });

  it('says out loud that MCP was not wired in, naming the reason', () => {
    assert.match(stdout, /local MCP is not wired into the agent/);
    assert.match(stdout, /--strict-mcp-config|--mcp-config/);
  });

  it('does not export the proxy secret into a process that cannot use it', () => {
    assert.equal(recorded.secretFromEnv, '', 'no consumer for the secret means no reason to expose it');
  });

  it('writes NOTHING into the project tree on this path either', () => {
    assert.ok(Object.keys(before_).length >= 4);
    assert.deepEqual(after_, before_);
  });
});
