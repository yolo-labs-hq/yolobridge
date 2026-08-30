/**
 * Can node-pty spawn ITS OWN helper? On macOS this is what usually failed.
 *
 * ⚠️ NODE-PTY DOES NOT SPAWN YOUR BINARY. On unix it spawns `spawn-helper`
 * and passes the real command as an argument (`pty.cc`: `argv[0] =
 * helper_path`). When that spawn fails it throws the literal string
 * `posix_spawnp failed.` — which names neither the helper nor your agent, and
 * is the same message you get when the agent genuinely is missing.
 *
 * So an operator can have a perfectly good `claude`, pass every check in
 * `resolve-agent-binary.ts`, and still see:
 *
 *     yolo-bridge: failed to start the local agent (posix_spawnp failed.)
 *
 * because the thing that could not be spawned was node-pty's own helper. That
 * is exactly what happened on macOS with `claude` installed twice and both
 * copies healthy.
 *
 * ⚠️ macOS ONLY, deliberately. The helper is a darwin build artifact; Linux
 * has no `spawn-helper` on disk at all, so probing for one there would report
 * a missing file on every healthy install — a false alarm in the one direction
 * a diagnostic must never fire.
 *
 * Common causes: npm dropping the executable bit when unpacking, Gatekeeper
 * quarantine on a downloaded prebuild, or a partially-restored node_modules.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HelperProbeFs {
  /** Can this `.node` file actually be loaded? Mirrors node-pty's own
   *  require()-and-catch, which is what decides the winner. */
  loadsNative(p: string): boolean;
  existsSync(p: string): boolean;
  statSync(p: string): { isFile(): boolean };
  accessSync(p: string, mode: number): void;
  constants: { X_OK: number };
}

const DEFAULT_FS: HelperProbeFs = {
  loadsNative(p) {
    // node-pty has already loaded successfully by the time this runs (the CLI
    // imports it), so for the winning path this is a require-cache hit with no
    // side effects; for a stale or ABI-incompatible one it throws, exactly as
    // it does inside node-pty's own loader.
    try {
      createRequire(import.meta.url)(p);
      return true;
    } catch {
      return false;
    }
  },
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  accessSync: (p, mode) => fs.accessSync(p, mode),
  constants: { X_OK: fs.constants.X_OK },
};

export type HelperCheck =
  | { ok: true; reason: 'not-applicable' | 'healthy' }
  | { ok: false; reason: 'missing' | 'not-executable'; helperPath: string; message: string };

/** node-pty's package root, or undefined when it cannot be located. */
export function findNodePtyRoot(resolveFrom: string, io: HelperProbeFs = DEFAULT_FS): string | undefined {
  try {
    const require_ = createRequire(resolveFrom);
    let dir = path.dirname(require_.resolve('node-pty'));
    for (let i = 0; i < 8; i++) {
      if (io.existsSync(path.join(dir, 'package.json')) && path.basename(dir) === 'node-pty') return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Where node-pty will look for its native module — and therefore its helper.
 *
 * ⚠️ NOT `build/Release`. That was the first version of this check and it was
 * wrong in the worst direction: node-pty 1.1.0 ships PREBUILDS, and
 * `scripts/prebuild.js` only verifies they exist — it never copies them into
 * `build/Release`. So a healthy macOS install loads from
 * `prebuilds/darwin-arm64/` and has no `build/Release` at all, and hardcoding
 * that path would have aborted EVERY attach on EVERY healthy Mac. (codex P1.)
 *
 * This mirrors node-pty's own order from `lib/utils.js` — Release, Debug, then
 * the platform/arch prebuild — and identifies the live directory by the
 * presence of `pty.node`, the same file node-pty itself requires. Both the
 * package root and its `lib/` are checked, matching node-pty's unbundled and
 * bundled relative lookups.
 */
export function findHelperPath(
  root: string,
  platform: string,
  arch: string,
  io: HelperProbeFs,
): string | undefined {
  return findHelperCandidates(root, platform, arch, io)[0];
}

/**
 * EVERY directory node-pty might load from, in its own order.
 *
 * ⚠️ EXISTENCE IS NOT SELECTION, and neither is "any usable helper wins".
 * Two review rounds pushed this in opposite directions, and both were right
 * about the version they saw:
 *
 *   · stopping at the first pty.node that merely EXISTS inspects a stale or
 *     ABI-incompatible `build/Release` that node-pty skips at runtime — and
 *     aborts an attach that works;
 *   · accepting ANY usable helper among the candidates passes an install where
 *     node-pty loads a Release module whose OWN helper is broken, while a
 *     complete prebuild sits unused behind it — and reports health while the
 *     spawn fails.
 *
 * Neither is fixable by ordering, because the question is which module
 * actually LOADS. So `loadsNative` mirrors node-pty's require()-and-catch and
 * the winner is the first candidate that genuinely loads; its paired helper is
 * the only one that matters.
 */
export function findHelperCandidates(
  root: string,
  platform: string,
  arch: string,
  io: HelperProbeFs,
): string[] {
  // ⚠️ BUILD TYPE OUTER, BASE INNER — node-pty's `loadNativeModule` tries each
  // build type across BOTH relative bases before advancing to the next type.
  // Inverting these loops picks the root prebuild over a bundled
  // `lib/build/Release` that node-pty would actually load, so the check would
  // inspect a different helper than the one being executed. (codex P2.)
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`];
  const found: string[] = [];
  for (const d of dirs) {
    for (const base of [root, path.join(root, 'lib')]) {
      const dir = path.join(base, ...d.split('/'));
      const native = path.join(dir, 'pty.node');
      if (io.existsSync(native) && io.loadsNative(native)) found.push(path.join(dir, 'spawn-helper'));
    }
  }
  return found;
}

/** Whether one candidate helper is a real, executable file. */
function helperUsable(helperPath: string, io: HelperProbeFs): boolean {
  if (!io.existsSync(helperPath)) return false;
  try {
    if (!io.statSync(helperPath).isFile()) return false;
    io.accessSync(helperPath, io.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether node-pty's spawn-helper is present and executable.
 *
 * Returns `not-applicable` off darwin and whenever the helper cannot be
 * located — an inconclusive probe must not manufacture a failure, because the
 * cost of a false alarm here is sending someone to chmod a file that was never
 * meant to exist.
 */
export function checkPtyHelper(
  opts: {
    platform?: string;
    arch?: string;
    resolveFrom?: string;
    io?: HelperProbeFs;
    /** Injectable so the darwin branches are testable from any platform —
     *  otherwise the two cases that matter most (missing, not executable)
     *  would be unexercised everywhere CI actually runs. */
    nodePtyRoot?: string;
  } = {},
): HelperCheck {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return { ok: true, reason: 'not-applicable' };

  const io = opts.io ?? DEFAULT_FS;
  const root = opts.nodePtyRoot ?? findNodePtyRoot(opts.resolveFrom ?? import.meta.url, io);
  if (!root) return { ok: true, reason: 'not-applicable' };

  const candidates = findHelperCandidates(root, platform, opts.arch ?? process.arch, io);
  // Could not tell where node-pty loads from: stay silent rather than invent a
  // fault. Same rule as an unlocatable package.
  if (candidates.length === 0) return { ok: true, reason: 'not-applicable' };

  // ⚠️ THE FIRST CANDIDATE THAT ACTUALLY LOADS IS THE ONE NODE-PTY USES, and
  // only ITS helper matters. A complete prebuild sitting behind a loadable
  // Release module is never reached, so it cannot excuse a broken helper
  // there. (codex P2, correcting the previous round's over-correction.)
  const helperPath = candidates[0];
  if (helperUsable(helperPath, io)) return { ok: true, reason: 'healthy' };

  if (!io.existsSync(helperPath)) {
    return {
      ok: false,
      reason: 'missing',
      helperPath,
      message:
        `node-pty's spawn-helper is missing at ${helperPath}.\n`
        + `  ⚠️ This is NOT a problem with your agent. node-pty spawns this helper rather than\n`
        + `     your binary directly, so its absence surfaces as the same "posix_spawnp failed."\n`
        + `     you would see if the agent itself were missing.\n`
        + `  Reinstall to restore it: npm i -g @yolo-labs/yolobridge`,
    };
  }

  // ⚠️ A DIRECTORY PASSES X_OK. `accessSync(dir, X_OK)` succeeds for any
  // searchable directory, so a corrupt or partially-restored install with a
  // directory at this path would be waved through as healthy while node-pty
  // cannot execute it. (codex P2.)
  let isFile: boolean;
  try {
    isFile = io.statSync(helperPath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return {
      ok: false,
      reason: 'missing',
      helperPath,
      message:
        `node-pty's spawn-helper at ${helperPath} is not a file.\n`
        + `  ⚠️ This is NOT a problem with your agent — node-pty spawns this helper rather than\n`
        + `     your binary directly, so it fails with the same "posix_spawnp failed."\n`
        + `  Reinstall to restore it: npm i -g @yolo-labs/yolobridge`,
    };
  }

  try {
    io.accessSync(helperPath, io.constants.X_OK);
  } catch {
    return {
      ok: false,
      reason: 'not-executable',
      helperPath,
      message:
        `node-pty's spawn-helper at ${helperPath} is not executable.\n`
        + `  ⚠️ This is NOT a problem with your agent. node-pty spawns this helper rather than\n`
        + `     your binary directly, so it fails with the same "posix_spawnp failed." you would\n`
        + `     see if the agent itself were missing. npm can drop the executable bit on unpack.\n`
        + `  Fix it with: chmod +x ${helperPath}`,
    };
  }

  return { ok: true, reason: 'healthy' };
}
