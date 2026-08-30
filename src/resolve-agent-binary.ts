/**
 * Can the agent binary actually be spawned, and if not, WHY?
 *
 * ⚠️ THE FAILURE THIS EXISTS FOR. node-pty reports an unspawnable binary as
 * the literal string `posix_spawnp failed.` — no binary name, no PATH, no
 * errno, no remedy. On macOS that surfaced as:
 *
 *     yolo-bridge: failed to start the local agent (posix_spawnp failed.), detaching...
 *
 * which is true, useless, and indistinguishable from half a dozen unrelated
 * causes. The operator cannot tell whether the agent is missing, installed but
 * not executable, or whether `attach` even looked in the right place — and the
 * one thing they CAN see (`claude` works when they type it) argues that
 * nothing is wrong.
 *
 * ⚠️ THE MACOS TRAP THIS NAMES EXPLICITLY. `claude` working in the operator's
 * terminal does NOT mean there is a binary to spawn: a shell alias or function
 * from `.zshrc` resolves interactively and does not exist as a file, so
 * `posix_spawnp` cannot find it however correct the PATH looks. A message that
 * only says "not found" invites the reply "but it IS installed", so this says
 * where it looked and offers the escape hatch.
 *
 * Resolution mirrors `posix_spawnp`: a name containing a separator is a path,
 * anything else is searched across PATH in order.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BinaryProbeFs {
  statSync(p: string): { isFile(): boolean; isDirectory(): boolean };
  accessSync(p: string, mode: number): void;
  constants: { X_OK: number };
  /** First line of a file, or null if it cannot be read. Used for the shebang. */
  readFirstLine(p: string): string | null;
}

export type AgentBinaryResolution =
  | { ok: true; path: string }
  | { ok: false; reason: 'not-found' | 'not-executable' | 'no-path' | 'bad-interpreter'; message: string };

const DEFAULT_FS: BinaryProbeFs = {
  statSync: (p) => fs.statSync(p),
  accessSync: (p, mode) => fs.accessSync(p, mode),
  constants: { X_OK: fs.constants.X_OK },
  readFirstLine(p) {
    // Only the shebang is wanted, and the file may be a multi-megabyte binary,
    // so this reads a small prefix rather than slurping it.
    let fd: number | undefined;
    try {
      fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(512);
      const read = fs.readSync(fd, buf, 0, 512, 0);
      const text = buf.subarray(0, read).toString('utf-8');
      const nl = text.indexOf('\n');
      return nl === -1 ? text : text.slice(0, nl);
    } catch {
      return null;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
  },
};

/**
 * The interpreter a `#!` line names, resolved the way the kernel would.
 *
 * ⚠️ THIS IS THE CASE EVERY OTHER CHECK PASSES. An executable script whose
 * interpreter is missing fails with ENOENT — the kernel reports the absent
 * INTERPRETER, and it is indistinguishable from the script itself not
 * existing. So a binary can be on PATH, be a real file, and be +x, and still
 * be unspawnable. That is precisely the macOS report this was written for:
 * `type -a claude` listed two real installs while node-pty said only
 * `posix_spawnp failed.`
 *
 * `#!/usr/bin/env node` delegates the search back to PATH, so the argument is
 * resolved recursively rather than treated as a literal path.
 */
function checkInterpreter(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  io: BinaryProbeFs,
  depth = 0,
): { ok: true } | { ok: false; interpreter: string; via: string } | { ok: false; nested: string } {
  if (depth > 4) return { ok: true };  // pathological chain; let the spawn speak
  const first = io.readFirstLine(scriptPath);
  if (!first || !first.startsWith('#!')) return { ok: true };  // a real binary, not a script

  const parts = tokenizeShebang(first.slice(2).trim());
  if (parts.length === 0) return { ok: true };
  const [interpreter, ...rest] = parts;

  // ⚠️ THE INTERPRETER ITSELF FIRST, ALWAYS. `#!/missing/env node` must fail on
  // `/missing/env` even when `node` is perfectly available: the kernel execs
  // the interpreter, and delegating straight to env's argument would report a
  // clean bill of health for a script that cannot spawn. (codex P2.)
  const interpreterFound = resolveAgentBinary(interpreter, env, io, depth + 1);
  if (!interpreterFound.ok) {
    // ⚠️ DO NOT BLAME THE OUTER INTERPRETER FOR AN INNER FAULT. If the
    // interpreter EXISTS but is itself a script with a missing interpreter
    // (claude -> /usr/bin/node -> /missing/runtime), its own message already
    // names the file that is actually absent. Overwriting it here would state
    // that /usr/bin/node cannot be found — about a file that is right there —
    // which is the same misdirection this whole check exists to end.
    // (codex P2.)
    if (interpreterFound.reason === 'bad-interpreter') {
      return { ok: false, nested: interpreterFound.message };
    }
    return { ok: false, interpreter, via: scriptPath };
  }

  // `env` hands the search back to PATH, so the command it delegates to is a
  // second thing that must exist.
  if (path.basename(interpreter) === 'env' && rest.length > 0) {
    const { command, env: envForCommand } = envInvocation(rest, env);
    if (!command) return { ok: true };
    // ⚠️ `envForCommand`, not `env`: the lookup must use the environment env
    // will have BUILT by the time it resolves the command.
    const resolved = resolveAgentBinary(command, envForCommand, io, depth + 1);
    if (resolved.ok) return { ok: true };
    if (resolved.reason === 'bad-interpreter') return { ok: false, nested: resolved.message };
    return { ok: false, interpreter: command, via: scriptPath };
  }

  return { ok: true };
}

/**
 * Split a shebang tail the way a shell would, not on raw whitespace.
 *
 * ⚠️ KNOWN LIMIT, ACCEPTED DELIBERATELY. This is shell-style tokenization, and
 * the kernel's rules differ by platform: macOS splits a shebang tail on
 * whitespace (so this matches it closely — and macOS is where the report that
 * prompted this came from), while Linux hands the whole tail to the
 * interpreter as ONE literal argument. So an exotic line like
 * `#!/usr/bin/env NODE_ENV="a b" node` can be called spawnable here and still
 * fail to exec on Linux.
 *
 * That residual gap is the RIGHT direction to leave open. Missing a broken
 * script costs nothing new — the spawn then fails exactly as it does today,
 * with node-pty's opaque message, which is the status quo this file improves
 * on rather than a regression it introduces. Falsely REJECTING a working
 * agent, by contrast, would block a working setup and be strictly worse than
 * the silence being replaced. Every fix in review has closed a false-reject;
 * this one would trade a small class of false-accepts for the risk of new
 * false-rejects by emulating two kernels' exec semantics, which is not a
 * trade a diagnostic helper should make.
 *
 * ⚠️ QUOTED VALUES CONTAIN SPACES. `env -S NODE_OPTIONS="--require /tmp/h.js"
 * node` is a valid, spawnable shebang; splitting it on whitespace picks
 * `/tmp/h.js"` as the command and declares a working agent broken. Rejecting
 * something that works is a worse outcome than the silence this file replaces,
 * so quotes and backslash escapes are honoured. (codex P2.)
 */
export function tokenizeShebang(tail: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (c === '\\' && quote !== "'" && i + 1 < tail.length) { cur += tail[++i]; started = true; continue; }
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      started = true;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * The command `env` will run, AND the environment it will run it in.
 *
 * ⚠️ BOTH HALVES MATTER. `env` constructs the environment first and resolves
 * the command second, so `#!/usr/bin/env PATH=/opt/runtime/bin node` looks for
 * `node` in `/opt/runtime/bin` — not wherever the daemon's own PATH points.
 * Resolving against the daemon's PATH would reject a spawnable agent whose
 * runtime lives only in the assigned path, and accept one that will fail the
 * moment env replaces PATH. (codex P2.)
 *
 * ⚠️ The command is NOT "the first token without a leading dash". Every one of
 * these is valid and its command is `node`, and that naive rule picks the
 * wrong token in three:
 *
 *   env node                              -> node
 *   env -S node --flag                    -> node   (-S splits the rest)
 *   env -u NODE_OPTIONS node              -> node   (-u CONSUMES an operand)
 *   env NODE_ENV=production node          -> node   (NAME=VALUE assignment)
 *   env PATH=/opt/runtime/bin node        -> node, looked up in /opt/runtime/bin
 */
export function envInvocation(
  args: string[],
  base: NodeJS.ProcessEnv,
): { command?: string; env: NodeJS.ProcessEnv } {
  const TAKES_OPERAND = new Set(['-u', '--unset', '-C', '--chdir']);
  let env: NodeJS.ProcessEnv = { ...base };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--') { i += 1; break; }
    // `-i` starts from an EMPTY environment, which means no PATH at all — the
    // delegated lookup then has nothing to search, and saying so is more use
    // than guessing.
    if (a === '-i' || a === '--ignore-environment' || a === '-') { env = {}; i += 1; continue; }
    if (a === '-u' || a === '--unset') { if (args[i + 1]) delete env[args[i + 1]]; i += 2; continue; }
    if (a.startsWith('-u') && a.length > 2) { delete env[a.slice(2)]; i += 1; continue; }
    if (TAKES_OPERAND.has(a)) { i += 2; continue; }
    if (a.startsWith('-')) { i += 1; continue; }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
    if (assignment) { env[assignment[1]] = assignment[2]; i += 1; continue; }
    return { command: a, env };
  }
  return { command: args[i], env };
}

/** A found binary, unless its shebang interpreter is the thing that is missing. */
function withInterpreter(
  found: string,
  env: NodeJS.ProcessEnv,
  io: BinaryProbeFs,
  depth: number,
): AgentBinaryResolution {
  const interp = checkInterpreter(found, env, io, depth);
  if (interp.ok) return { ok: true, path: found };
  if ('nested' in interp) return { ok: false, reason: 'bad-interpreter', message: interp.nested };
  return {
    ok: false,
    reason: 'bad-interpreter',
    message:
      `\`${found}\` exists and is executable, but it is a script whose interpreter\n`
      + `  \`${interp.interpreter}\` cannot be found. The spawn fails with a "not found" error that\n`
      + `  names the SCRIPT rather than the missing interpreter, which is why this looks like\n`
      + `  the agent is missing when it plainly is not.\n`
      + `  Reinstall the agent against a current runtime, or point yolo-bridge at another copy\n`
      + `  with \`--agent /full/path\` (or YOLOBRIDGE_AGENT_BIN).`,
  };
}

function isExecutableFile(p: string, io: BinaryProbeFs): 'yes' | 'not-executable' | 'no' {
  try {
    if (!io.statSync(p).isFile()) return 'no';
  } catch {
    return 'no';
  }
  try {
    io.accessSync(p, io.constants.X_OK);
    return 'yes';
  } catch {
    return 'not-executable';
  }
}

/**
 * Where `bin` would be spawned from, or a sentence explaining why it cannot be.
 *
 * The message is the whole point: it is what the operator reads instead of
 * `posix_spawnp failed.`, so it names the binary, says where the search
 * looked, and gives the two ways out.
 */
export function resolveAgentBinary(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  io: BinaryProbeFs = DEFAULT_FS,
  depth = 0,
): AgentBinaryResolution {
  const escapeHatch =
    `Point yolo-bridge at it explicitly with \`--agent /full/path/to/${bin}\` `
    + `(or set YOLOBRIDGE_AGENT_BIN).`;

  // An explicit path is taken at its word — no PATH search, same as execve.
  if (bin.includes(path.sep) || bin.includes('/')) {
    const abs = path.resolve(bin);
    const state = isExecutableFile(abs, io);
    if (state === 'yes') return withInterpreter(abs, env, io, depth);
    if (state === 'not-executable') {
      return {
        ok: false,
        reason: 'not-executable',
        message: `The agent at ${abs} exists but is not executable. \`chmod +x ${abs}\` and re-attach.`,
      };
    }
    return { ok: false, reason: 'not-found', message: `No agent binary at ${abs}. ${escapeHatch}` };
  }

  const rawPath = env.PATH ?? '';
  if (!rawPath.trim()) {
    return {
      ok: false,
      reason: 'no-path',
      message: `Cannot look for \`${bin}\`: PATH is empty in this process. ${escapeHatch}`,
    };
  }

  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  let sawNonExecutable: string | undefined;
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    const state = isExecutableFile(candidate, io);
    if (state === 'yes') return withInterpreter(candidate, env, io, depth);
    if (state === 'not-executable' && !sawNonExecutable) sawNonExecutable = candidate;
  }

  if (sawNonExecutable) {
    return {
      ok: false,
      reason: 'not-executable',
      message:
        `Found \`${bin}\` at ${sawNonExecutable}, but it is not executable. `
        + `\`chmod +x ${sawNonExecutable}\` and re-attach.`,
    };
  }

  return {
    ok: false,
    reason: 'not-found',
    message:
      `\`${bin}\` is not on this process's PATH (searched ${dirs.length} `
      + `${dirs.length === 1 ? 'directory' : 'directories'}).\n`
      + `  ⚠️ If \`${bin}\` works when you type it, it may be a shell alias or function rather than\n`
      + `     a real binary — those cannot be spawned. Check with: type -a ${bin}\n`
      + `  ${escapeHatch}`,
  };
}
