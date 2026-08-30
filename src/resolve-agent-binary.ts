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
}

export type AgentBinaryResolution =
  | { ok: true; path: string }
  | { ok: false; reason: 'not-found' | 'not-executable' | 'no-path'; message: string };

const DEFAULT_FS: BinaryProbeFs = fs as unknown as BinaryProbeFs;

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
): AgentBinaryResolution {
  const escapeHatch =
    `Point yolo-bridge at it explicitly with \`--agent /full/path/to/${bin}\` `
    + `(or set YOLOBRIDGE_AGENT_BIN).`;

  // An explicit path is taken at its word — no PATH search, same as execve.
  if (bin.includes(path.sep) || bin.includes('/')) {
    const abs = path.resolve(bin);
    const state = isExecutableFile(abs, io);
    if (state === 'yes') return { ok: true, path: abs };
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
    if (state === 'yes') return { ok: true, path: candidate };
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
